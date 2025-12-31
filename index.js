require("dotenv").config();const token = process.env.BOT_TOKEN;if (!token) {  console.log("❌ BOT_TOKEN is NOT set");  process.exit(1);}console.log("✅ BOT_TOKEN loaded");

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// ---- DATABASE ----
const { initializeDatabase, saveEpub, getUserLibrary, getEpubById, deleteEpub, updateEpub, getLibrarySize } = require("./db/library");

// ---- SCRAPERS ----
const { scrapeNovel: scrapeFreewebnovel } = require("./scrapers/freewebnovel");
const { scrapeNovel: scrapeRoyalroad } = require("./scrapers/royalroad");
const { scrapeNovel: scrapeWebnovel } = require("./scrapers/webnovel");
const { scrapeNovel: scrapeWattpad } = require("./scrapers/wattpad");
const { scrapeNovel: scrapeNovelUpdates } = require("./scrapers/novelupdates");
const { scrapeNovel: scrapeScribble } = require("./scrapers/scribble");
const { scrapeNovel: scrapeFanfiction } = require("./scrapers/fanfiction");
const { scrapeNovel: scrapeWuxiaworld } = require("./scrapers/wuxiaworld");
const { scrapeNovel: scrapeAO3 } = require("./scrapers/archiveofourown");
const { scrapeNovel: scrapeBoxnovel } = require("./scrapers/boxnovel");
const { scrapeNovel: scrapeReadlightnovel } = require("./scrapers/readlightnovel");
const { scrapeNovel: scrapeNovelfull } = require("./scrapers/novelfull");
const { scrapeNovel: scrapeMtlnovel } = require("./scrapers/mtlnovel");
const { scrapeNovel: scrapeGeneric } = require("./scrapers/generic");

const { createEpub } = require("./epub/builder");

// ---- SAFE ENV READ ----
const BOT_TOKEN = process.env.BOT_TOKEN;

console.log("BOT_TOKEN present:", !!BOT_TOKEN);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is NOT set. Waiting for Railway env injection...");
  setInterval(() => {
    console.error("⏳ BOT_TOKEN still missing...");
  }, 30000);
  process.exit(1);
}

// ---- INIT BOT ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Initialize database on startup
initializeDatabase().then(() => {
  console.log("📚 Library system initialized");
}).catch(err => {
  console.error("Failed to initialize database:", err);
});

// ---- SESSION STORAGE FOR URLS & STATES ----
const sessionURLs = new Map();
const waitingForRange = new Map();
let sessionCounter = 0;

function generateSessionId() {
  return `s_${++sessionCounter}`;
}

function storeNovelURL(url) {
  const sessionId = generateSessionId();
  sessionURLs.set(sessionId, url);
  setTimeout(() => sessionURLs.delete(sessionId), 3600000); // Auto-delete after 1 hour
  return sessionId;
}

function getNovelURL(sessionId) {
  return sessionURLs.get(sessionId);
}

function setWaitingForRange(chatId, sessionId, msgId) {
  waitingForRange.set(chatId, { sessionId, msgId });
  setTimeout(() => waitingForRange.delete(chatId), 600000); // Auto-delete after 10 min
}

function getWaitingForRange(chatId) {
  return waitingForRange.get(chatId);
}

function clearWaitingForRange(chatId) {
  waitingForRange.delete(chatId);
}

// ---- SITE DETECTION ----
function detectSite(url) {
  const domain = new URL(url).hostname.toLowerCase();
  
  if (domain.includes("freewebnovel")) return { name: "FreeWebNovel", scraper: scrapeFreewebnovel };
  if (domain.includes("readlightnovel")) return { name: "ReadLightNovel", scraper: scrapeReadlightnovel };
  if (domain.includes("archiveofourown")) return { name: "Archive of Our Own", scraper: scrapeAO3 };
  if (domain.includes("fanfiction.net")) return { name: "FanFiction.net", scraper: scrapeFanfiction };
  if (domain.includes("scribblehub")) return { name: "ScribbleHub", scraper: scrapeScribble };
  if (domain.includes("novelupdates")) return { name: "Novel Updates", scraper: scrapeNovelUpdates };
  if (domain.includes("wuxiaworld")) return { name: "Wuxiaworld", scraper: scrapeWuxiaworld };
  if (domain.includes("boxnovel")) return { name: "BoxNovel", scraper: scrapeBoxnovel };
  if (domain.includes("novelfull")) return { name: "NovelFull", scraper: scrapeNovelfull };
  if (domain.includes("mtlnovel")) return { name: "MTLNovel", scraper: scrapeMtlnovel };
  if (domain.includes("royalroad")) return { name: "Royal Road", scraper: scrapeRoyalroad };
  if (domain.includes("wattpad")) return { name: "Wattpad", scraper: scrapeWattpad };
  if (domain.includes("webnovel")) return { name: "WebNovel", scraper: scrapeWebnovel };
  
  return { name: "Generic", scraper: scrapeGeneric };
}

// ---- FETCH NOVEL INFO ----
async function fetchNovelInfo(url) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    };
    
    const { data } = await axios.get(url, { 
      headers, 
      timeout: 8000,
      validateStatus: () => true 
    });
    const $ = cheerio.load(data);

    let title = $("h1").first().text().trim() || "Novel";
    let description = "";
    let coverImage = "";

    // Extract description
    const descSelectors = [
      ".novel-intro",
      ".description",
      "[class*='desc']",
      ".synopsis",
      ".summary"
    ];

    for (const selector of descSelectors) {
      const text = $(selector).text().trim();
      if (text && text.length > 20) {
        description = text.substring(0, 300);
        break;
      }
    }

    // Extract cover image
    const coverSelectors = [
      "img[class*='cover']",
      "img[class*='poster']",
      ".novel-cover img",
      ".book-cover img",
      "img[alt*='cover']",
      "img[src*='cover']"
    ];

    for (const selector of coverSelectors) {
      const src = $(selector).attr("src");
      if (src && src.trim()) {
        try {
          coverImage = src.startsWith("http") ? src : new URL(src, url).href;
          // Verify the image is accessible
          const imgCheck = await axios.head(coverImage, { headers, timeout: 3000 });
          if (imgCheck.status === 200) break;
          coverImage = "";
        } catch (e) {
          coverImage = "";
        }
      }
    }

    return { title, description: description || "No description available", coverImage };
  } catch (err) {
    console.error("fetchNovelInfo error:", err.message);
    return { 
      title: "Novel", 
      description: "Unable to fetch description", 
      coverImage: "" 
    };
  }
}

// Helper function to create progress bar
function createProgressBar(current, total, width = 20) {
  const percentage = Math.round((current / total) * 100);
  const filledWidth = Math.round((width * current) / total);
  const emptyWidth = width - filledWidth;
  const bar = "█".repeat(filledWidth) + "░".repeat(emptyWidth);
  return `${bar} ${percentage}%`;
}

// Helper function to format time
function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// ---- PROCESS NOVEL (after chapter count selected) ----
async function processNovel(chatId, novelUrl, chapterLimit, infoMsg = null) {
  const { name: siteName, scraper } = detectSite(novelUrl);
  
  const processingMsg = infoMsg || await bot.sendMessage(
    chatId,
    `⏳ Connecting to *${siteName}*...\n\n_Discovering chapters..._`,
    { parse_mode: "Markdown" }
  );

  try {
    console.log(`[${new Date().toISOString()}] Scraping from ${siteName}: ${novelUrl}`);

    let startTime = Date.now();
    let lastUpdateTime = startTime;

    const { novelTitle, chapters } = await scraper(novelUrl, chapterLimit, async (current, total) => {
      const now = Date.now();
      
      if (now - lastUpdateTime > 2000 || current === total) {
        lastUpdateTime = now;
        const elapsedSeconds = (now - startTime) / 1000;
        const avgTimePerChapter = elapsedSeconds / Math.max(1, current);
        const remainingChapters = total - current;
        const estimatedRemainingSeconds = avgTimePerChapter * remainingChapters;

        const progressBar = createProgressBar(current, total);
        const eta = estimatedRemainingSeconds > 0 ? formatTime(estimatedRemainingSeconds) : "~0s";
        
        const statusMsg = `⏳ Scraping Chapters\n\n${progressBar}\n\n` +
                          `📊 *Progress:* ${current}/${total}\n` +
                          `⏱️ *ETA:* ${eta}\n` +
                          `🕐 *Elapsed:* ${formatTime(elapsedSeconds)}`;

        try {
          if (infoMsg) {
            await bot.editMessageText(statusMsg, {
              chat_id: chatId,
              message_id: infoMsg.message_id,
              parse_mode: "Markdown"
            });
          }
        } catch (e) {
          // Ignore edit errors
        }
      }
    });

    if (!chapters || chapters.length === 0) {
      throw new Error("No chapters found. The website structure might have changed.");
    }

    console.log(`Found ${chapters.length} chapters for "${novelTitle}"`);

    // Creating EPUB
    if (infoMsg) {
      await bot.editMessageText(
        `⏳ Creating EPUB...\n\n📖 *${novelTitle}*\n\nChapters: ${chapters.length}`,
        { chat_id: chatId, message_id: infoMsg.message_id, parse_mode: "Markdown" }
      );
    }

    const epubPath = await createEpub(novelTitle, "Web Novel", chapters);
    const fileSize = (fs.statSync(epubPath).size / 1024).toFixed(2);
    const totalTime = formatTime((Date.now() - startTime) / 1000);

    if (infoMsg) {
      await bot.editMessageText(
        `✅ EPUB Ready!\n\n📖 *${novelTitle}*\n` +
        `📊 Chapters: ${chapters.length}\n` +
        `💾 Size: ~${fileSize} KB\n` +
        `⏱️ Time: ${totalTime}`,
        { chat_id: chatId, message_id: infoMsg.message_id, parse_mode: "Markdown" }
      );
    }

    await bot.sendDocument(chatId, epubPath, {
      caption: `✅ *EPUB Ready!*\n\n` +
        `📖 *${novelTitle}*\n\n` +
        `📦 Download complete!\n` +
        `💾 Open in your EPUB reader\n\n` +
        `👉 Send another URL to convert another novel!`,
      parse_mode: "Markdown"
    });

    // Save to library
    try {
      const fileSize = fs.statSync(epubPath).size;
      await saveEpub(chatId, novelTitle, "Unknown", novelUrl, chapters.length, epubPath, fileSize);
      console.log(`✅ EPUB saved to library for user ${chatId}`);
    } catch (dbErr) {
      console.log(`⚠️ Could not save to library: ${dbErr.message}`);
    }

    // Clean up temp file
    setTimeout(() => {
      try { fs.unlinkSync(epubPath); } catch (e) {}
    }, 5000);
    
    console.log(`✅ Successfully sent EPUB for "${novelTitle}"`);

  } catch (err) {
    console.error(`[${new Date().toISOString()}] EPUB ERROR:`, err.message);

    const errorMsg = err.message.includes("timeout") 
      ? "❌ Connection timeout. The website might be blocking requests or slow to respond."
      : err.message.includes("No chapters")
      ? "❌ Could not find chapters. This site might not be supported or the URL might be incorrect."
      : `❌ Failed to create EPUB\n\n_Error: ${err.message.substring(0, 100)}_`;

    if (infoMsg) {
      await bot.editMessageText(
        errorMsg,
        { chat_id: chatId, message_id: infoMsg.message_id, parse_mode: "Markdown" }
      );
    } else {
      await bot.sendMessage(chatId, errorMsg, { parse_mode: "Markdown" });
    }
  }
}

// ---- COMMANDS ----
bot.onText(/\/start/, async (msg) => {
  const helpMessage = 
    "📚 *WebNovel → EPUB Converter*\n\n" +
    "Convert any web novel to EPUB for offline reading!\n\n" +
    "*Quick Start:*\n" +
    "1️⃣ Paste a novel URL\n" +
    "2️⃣ Choose chapter range\n" +
    "3️⃣ Download EPUB file\n\n" +
    "*Example:*\n" +
    "`https://www.royalroad.com/fiction/...`\n\n" +
    "*Commands:*\n" +
    "/sites - Show all supported websites\n" +
    "/library - View your saved EPUBs\n" +
    "/help - Show this message\n\n" +
    "*Tips:*\n" +
    "• First 50-100 chapters work best\n" +
    "• Scrapers have 15s timeout per chapter\n" +
    "• Failed chapters are retried automatically\n\n" +
    "👉 Send a novel URL to get started!";
  
  try {
    await bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error in /start command:", err.message);
  }
});

bot.onText(/\/sites/, async (msg) => {
  const sitesList = 
    "🌐 *All Supported Websites* (15+ platforms)\n\n" +
    "*Popular Sites:*\n" +
    "🔹 Royal Road\n" +
    "🔹 WebNovel\n" +
    "🔹 Wattpad\n" +
    "🔹 FreeWebNovel\n" +
    "🔹 ReadLightNovel\n\n" +
    "*Asian Novels:*\n" +
    "🔹 NovelFull\n" +
    "🔹 MTLNovel\n" +
    "🔹 Wuxiaworld\n" +
    "🔹 BoxNovel\n\n" +
    "*Community & Fan Fiction:*\n" +
    "🔹 ScribbleHub\n" +
    "🔹 FanFiction.net\n" +
    "🔹 Archive of Our Own (AO3)\n" +
    "🔹 Novel Updates\n\n" +
    "*Plus 100+ more sites supported via generic scraper!*\n\n" +
    "_Just paste any novel URL and the bot will detect it automatically._";
  
  try {
    await bot.sendMessage(msg.chat.id, sitesList, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error in /sites command:", err.message);
  }
});

bot.onText(/\/library/, async (msg) => {
  const userId = msg.chat.id;
  try {
    const epubs = await getUserLibrary(userId);
    const totalSize = await getLibrarySize(userId);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
    
    if (epubs.length === 0) {
      await bot.sendMessage(userId, 
        "📚 *Your Library is Empty*\n\n" +
        "Start by sending a novel URL to create your first EPUB!",
        { parse_mode: "Markdown" }
      );
      return;
    }
    
    let libraryText = `📚 *Your EPUB Library*\n\n` +
      `📊 ${epubs.length} books | 💾 ${sizeMB} MB\n\n`;
    
    epubs.forEach((epub, idx) => {
      const date = new Date(epub.created_at).toLocaleDateString();
      libraryText += `${idx + 1}. *${epub.title}*\n` +
        `   📄 ${epub.chapters_count} chapters | ${date}\n`;
    });
    
    libraryText += `\n_Use /delete <number> to remove an EPUB_`;
    
    await bot.sendMessage(userId, libraryText, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Library error:", err.message);
    await bot.sendMessage(userId, "❌ Error loading library. Try again later.");
  }
});

bot.onText(/\/delete\s+(\d+)/, async (msg, match) => {
  const userId = msg.chat.id;
  const bookNum = parseInt(match[1]);
  
  try {
    const epubs = await getUserLibrary(userId);
    if (bookNum < 1 || bookNum > epubs.length) {
      await bot.sendMessage(userId, "❌ Invalid book number. Use /library to see your books.");
      return;
    }
    
    const bookId = epubs[bookNum - 1].id;
    const result = await deleteEpub(bookId, userId);
    
    if (result) {
      // Delete file if it exists
      if (result.file_path && fs.existsSync(result.file_path)) {
        fs.unlinkSync(result.file_path);
      }
      await bot.sendMessage(userId, "✅ EPUB deleted from library!");
    }
  } catch (err) {
    await bot.sendMessage(userId, "❌ Error deleting EPUB.");
  }
});

bot.onText(/\/help/, async (msg) => {
  await bot.onText(/\/start/, msg);
});

// ---- URL DETECTION IN MESSAGES ----
bot.on("message", async msg => {
  if (!msg.text) return;

  // Check if message contains a URL
  const urlMatch = msg.text.match(/https?:\/\/[^\s]+/);
  
  if (urlMatch) {
    const novelUrl = urlMatch[0];
    const chatId = msg.chat.id;

    // Validate URL
    try {
      new URL(novelUrl);
    } catch (e) {
      await bot.sendMessage(chatId, "❌ Invalid URL. Please send a valid website link.");
      return;
    }

    const { name: siteName } = detectSite(novelUrl);

    // Fetch novel info with spinning animation
    const loadingMsg = await bot.sendMessage(chatId, `⏳ Fetching *${siteName}* novel info...\n\n⟳ Searching for title, description, and cover...`, { parse_mode: "Markdown" });

    const { title, description, coverImage } = await fetchNovelInfo(novelUrl);

    // Store URL in session and get short ID
    const sessionId = storeNovelURL(novelUrl);

    // Create chapter selection buttons with better labels
    const keyboard = {
      inline_keyboard: [
        [
          { text: "📝 Choose Chapters (1-200)", callback_data: `cr_${sessionId}` },
          { text: "📚 Get All Chapters", callback_data: `sc_999_${sessionId}` }
        ]
      ]
    };

    // Create caption with better formatting
    let caption = `${coverImage ? "🖼️" : "📖"} *${title}*\n\n` +
      `${description}\n\n` +
      `✨ Ready to convert! Choose an option below:`;

    try {
      await bot.editMessageText(caption, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: "Markdown",
        reply_markup: keyboard
      });
    } catch (err) {
      console.error("Error sending novel info:", err.message);
      await bot.sendMessage(chatId, "❌ Error loading novel. Please try again.", { parse_mode: "Markdown" });
    }
  } else if (msg.text && !msg.text.startsWith("/")) {
    const chatId = msg.chat.id;
    
    // Check if we're waiting for a custom chapter count
    const waiting = getWaitingForRange(chatId);
    if (waiting) {
      const chapterCount = parseInt(msg.text);
      if (!isNaN(chapterCount) && chapterCount > 0) {
        clearWaitingForRange(chatId);
        const novelUrl = getNovelURL(waiting.sessionId);
        
        if (novelUrl) {
          const limit = Math.min(chapterCount, 200); // Max 200 chapters
          const processingMsg = await bot.sendMessage(chatId, 
            `🚀 *Starting conversion...*\n\n` +
            `📊 Scraping: ${limit} chapters\n` +
            `⟳ This may take a few minutes...\n\n` +
            `_Progress updates below:_`,
            { parse_mode: "Markdown" }
          );
          await processNovel(chatId, novelUrl, limit, processingMsg);
        } else {
          await bot.sendMessage(chatId, "❌ Session expired. Please send the novel URL again.");
        }
      } else {
        await bot.sendMessage(chatId, 
          "❌ *Invalid input!*\n\n" +
          "Please send a number between 1-200\n\n" +
          "Example: `50`",
          { parse_mode: "Markdown" }
        );
      }
    } else {
      await bot.sendMessage(chatId, 
        "💬 *Need help?*\n\n" +
        "Send a novel URL like:\n" +
        "`https://royalroad.com/fiction/...`\n\n" +
        "Or use /start for full instructions",
        { parse_mode: "Markdown" }
      );
    }
  }
});

// ---- CALLBACK QUERY HANDLER (button clicks) ----
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Handle custom range button: cr_s_123
  if (data.startsWith("cr_")) {
    const sessionId = data.substring(3);
    setWaitingForRange(chatId, sessionId, query.message.message_id);
    await bot.answerCallbackQuery(query.id, "✅ Enter chapter count", false);
    await bot.sendMessage(chatId, 
      "📝 *How many chapters do you want?*\n\n" +
      "Send a number between 1-200\n\n" +
      "Examples:\n" +
      "• `50` → First 50 chapters\n" +
      "• `100` → First 100 chapters\n" +
      "• `200` → First 200 chapters",
      { parse_mode: "Markdown" }
    );
  }
  // Handle all chapters or preset: sc_999_s_123
  else if (data.startsWith("sc_")) {
    const parts = data.split("_");
    const chapterLimit = parseInt(parts[1]);
    const sessionId = parts.slice(2).join("_");

    // Get URL from session
    const novelUrl = getNovelURL(sessionId);
    
    if (!novelUrl) {
      await bot.answerCallbackQuery(query.id, "❌ Session expired. Please send the URL again.", true);
      return;
    }

    // Acknowledge button click
    await bot.answerCallbackQuery(query.id, "⏳ Starting to scrape...", false);

    // Process the novel
    const processingMsg = query.message;
    await processNovel(chatId, novelUrl, chapterLimit, processingMsg);
  }
});

console.log("✅ Bot initialized and polling started");
