const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db;
let dbPath;

function hasColumn(tableName, columnName) {
  const stmt = db.prepare(`PRAGMA table_info(${tableName})`);
  while (stmt.step()) {
    const row = stmt.getAsObject();
    if (row.name === columnName) {
      stmt.free();
      return true;
    }
  }
  stmt.free();
  return false;
}

function migrateSchema() {
  if (!hasColumn('channel_settings', 'setup_state')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN setup_state TEXT`);
  }
  if (!hasColumn('channel_settings', 'setup_user_id')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN setup_user_id TEXT`);
  }
  if (!hasColumn('channel_settings', 'updated_at')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP`);
  }
  if (!hasColumn('channel_settings', 'reminder_time')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN reminder_time TEXT`);
  }
  if (!hasColumn('channel_settings', 'split_books')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN split_books INTEGER DEFAULT 0`);
  }
  if (!hasColumn('channel_settings', 'setup_completed_at')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN setup_completed_at TEXT`);
  }
  if (!hasColumn('channel_settings', 'user_gender')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN user_gender TEXT`);
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();
  
  dbPath = process.env.DB_PATH || './data/accounting.db';
  
  // 確保目錄存在
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // 載入或創建資料庫
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  
  // 建立資料表
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT,
      note TEXT,
      type TEXT DEFAULT 'expense',
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS channel_settings (
      channel_id TEXT PRIMARY KEY,
      name TEXT,
      budget REAL DEFAULT 0,
      type TEXT DEFAULT 'personal',
      setup_state TEXT,
      setup_user_id TEXT,
      reminder_time TEXT,
      split_books INTEGER DEFAULT 0,
      setup_completed_at TEXT,
      user_gender TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  migrateSchema();
  
  // 儲存資料庫
  saveDatabase();
  
  console.log('📦 資料庫初始化完成');
  return db;
}

function saveDatabase() {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

function getDatabase() {
  return db;
}

// 確保每次改動後儲存
function run(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

module.exports = { initDatabase, getDatabase, saveDatabase, run, get, all };
