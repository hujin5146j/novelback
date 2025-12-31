const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize database tables
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS epubs (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        title VARCHAR(255) NOT NULL,
        author VARCHAR(255),
        source_url TEXT,
        chapters_count INT DEFAULT 0,
        file_path TEXT NOT NULL,
        file_size INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, title)
      );
      
      CREATE INDEX IF NOT EXISTS idx_user_id ON epubs(user_id);
      CREATE INDEX IF NOT EXISTS idx_created_at ON epubs(created_at);
    `);
    console.log("✅ Database tables initialized");
  } catch (err) {
    console.error("Database init error:", err.message);
  }
}

// Save EPUB to database
async function saveEpub(userId, title, author, sourceUrl, chaptersCount, filePath, fileSize) {
  try {
    const result = await pool.query(
      `INSERT INTO epubs (user_id, title, author, source_url, chapters_count, file_path, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, title) DO UPDATE SET
       author = EXCLUDED.author,
       chapters_count = EXCLUDED.chapters_count,
       file_path = EXCLUDED.file_path,
       file_size = EXCLUDED.file_size,
       updated_at = CURRENT_TIMESTAMP
       RETURNING id;`,
      [userId, title, author, sourceUrl, chaptersCount, filePath, fileSize]
    );
    return result.rows[0].id;
  } catch (err) {
    console.error("Save EPUB error:", err.message);
    throw err;
  }
}

// Get user's EPUB library
async function getUserLibrary(userId) {
  try {
    const result = await pool.query(
      `SELECT id, title, author, chapters_count, file_size, created_at
       FROM epubs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50;`,
      [userId]
    );
    return result.rows;
  } catch (err) {
    console.error("Get library error:", err.message);
    return [];
  }
}

// Get EPUB by ID
async function getEpubById(id, userId) {
  try {
    const result = await pool.query(
      `SELECT * FROM epubs WHERE id = $1 AND user_id = $2;`,
      [id, userId]
    );
    return result.rows[0];
  } catch (err) {
    console.error("Get EPUB error:", err.message);
    return null;
  }
}

// Delete EPUB
async function deleteEpub(id, userId) {
  try {
    const result = await pool.query(
      `DELETE FROM epubs WHERE id = $1 AND user_id = $2 RETURNING file_path;`,
      [id, userId]
    );
    return result.rows[0];
  } catch (err) {
    console.error("Delete EPUB error:", err.message);
    return null;
  }
}

// Update EPUB metadata
async function updateEpub(id, userId, updates) {
  try {
    const allowedFields = ['title', 'author', 'chapters_count'];
    const setClause = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClause.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (setClause.length === 0) return null;

    values.push(id, userId);
    const result = await pool.query(
      `UPDATE epubs SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
       RETURNING *;`,
      values
    );
    return result.rows[0];
  } catch (err) {
    console.error("Update EPUB error:", err.message);
    return null;
  }
}

// Get library size in MB
async function getLibrarySize(userId) {
  try {
    const result = await pool.query(
      `SELECT SUM(file_size) as total_size FROM epubs WHERE user_id = $1;`,
      [userId]
    );
    return result.rows[0].total_size || 0;
  } catch (err) {
    return 0;
  }
}

module.exports = {
  initializeDatabase,
  saveEpub,
  getUserLibrary,
  getEpubById,
  deleteEpub,
  updateEpub,
  getLibrarySize
};
