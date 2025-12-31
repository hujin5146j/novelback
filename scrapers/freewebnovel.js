const axios = require("axios");
const cheerio = require("cheerio");

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CHAPTER SCRAPER ---------------- */

async function scrapeChapter(url) {
  try {
    const { data } = await axios.get(url, {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    });

    const $ = cheerio.load(data);

    const title =
      $("h1").first().text().trim() || "Chapter";

    let content = "";

    const selectors = [
      "#chapter-content",
      ".chapter-content",
      ".chapter-body",
      ".cha-words",
      "article",
    ];

    for (const sel of selectors) {
      const html = $(sel).html();
      if (html && html.length > 200) {
        content = html;
        break;
      }
    }

    if (!content) {
      const paragraphs = [];
      $("p").each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 30) {
          paragraphs.push(`<p>${text}</p>`);
        }
      });
      content = paragraphs.join("");
    }

    if (!content || content.length < 100) {
      content = "<p>[Chapter content unavailable]</p>";
    }

    return { title, content };
  } catch {
    return { title: "Chapter", content: "<p>[Failed to load]</p>" };
  }
}

/* ---------------- NOVEL SCRAPER ---------------- */

async function scrapeNovel(novelUrl, limit = 50, onProgress = null) {
  // Force chapter list page
  if (!novelUrl.endsWith("/chapters")) {
    novelUrl = novelUrl.replace(/\/$/, "") + "/chapters";
  }

  const { data } = await axios.get(novelUrl, {
    headers,
    timeout: 15000,
    validateStatus: () => true,
  });

  const $ = cheerio.load(data);

  const novelTitle =
    $("h1").first().text().trim() || "Unknown Novel";

  const chapterLinks = new Set();

  // Correct selectors for FreeWebNovel
  $(".chapter-list a, a[href*='/novel/']").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    try {
      const fullUrl = href.startsWith("http")
        ? href
        : new URL(href, novelUrl).href;

      if (
        fullUrl.includes("/novel/") &&
        fullUrl.match(/\/\d+\.html$/)
      ) {
        chapterLinks.add(fullUrl);
      }
    } catch {}
  });

  const chaptersToScrape = [...chapterLinks].slice(0, limit);

  if (chaptersToScrape.length === 0) {
    throw new Error("No chapters found");
  }

  console.log(
    `FreeWebNovel: Found ${chaptersToScrape.length} chapters`
  );

  if (onProgress) onProgress(0, chaptersToScrape.length);

  const chapters = [];

  for (let i = 0; i < chaptersToScrape.length; i++) {
    chapters.push(await scrapeChapter(chaptersToScrape[i]));
    if (onProgress) onProgress(i + 1, chaptersToScrape.length);
    await delay(1200);
  }

  return { novelTitle, chapters };
}

module.exports = { scrapeNovel };
