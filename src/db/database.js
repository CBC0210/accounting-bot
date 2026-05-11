const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db;
let dbPath;
let SQLInstance;
let dbMtimeMs = 0;
let lastLocalWriteMs = 0;

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
  if (!hasColumn('channel_settings', 'reminder_enabled')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN reminder_enabled INTEGER DEFAULT 1`);
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
  if (!hasColumn('channel_settings', 'user_title')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN user_title TEXT`);
  }
  if (!hasColumn('channel_settings', 'categories_text')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN categories_text TEXT`);
  }
  if (!hasColumn('channel_settings', 'currency')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN currency TEXT DEFAULT 'TWD'`);
  }
  if (!hasColumn('channel_settings', 'ledgers_text')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN ledgers_text TEXT`);
  }
  if (!hasColumn('channel_settings', 'show_balance_in_name')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN show_balance_in_name INTEGER DEFAULT 1`);
  }
  if (!hasColumn('channel_settings', 'vehicle_sync_enabled')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN vehicle_sync_enabled INTEGER DEFAULT 0`);
  }
  if (!hasColumn('channel_settings', 'recurring_items_text')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN recurring_items_text TEXT`);
  }
  if (!hasColumn('channel_settings', 'chat_style_tags_text')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN chat_style_tags_text TEXT`);
  }
  if (!hasColumn('channel_settings', 'category_budgets_text')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN category_budgets_text TEXT`);
  }
  if (!hasColumn('channel_settings', 'meal_periods_text')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN meal_periods_text TEXT`);
  }
  if (!hasColumn('channel_settings', 'monthly_budgets_text')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN monthly_budgets_text TEXT`);
  }
  if (!hasColumn('channel_settings', 'category_rules_text')) {
    db.run(`ALTER TABLE channel_settings ADD COLUMN category_rules_text TEXT`);
  }
  if (!hasColumn('transactions', 'exclude_from_budget')) {
    db.run(`ALTER TABLE transactions ADD COLUMN exclude_from_budget INTEGER DEFAULT 0`);
  }
}

async function initDatabase() {
  SQLInstance = await initSqlJs();
  
  dbPath = process.env.DB_PATH || './data/accounting.db';
  
  // 確保目錄存在
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // 載入或創建資料庫
  loadDatabaseFromDisk();
  
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
      exclude_from_budget INTEGER DEFAULT 0,
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
      reminder_enabled INTEGER DEFAULT 1,
      split_books INTEGER DEFAULT 0,
      setup_completed_at TEXT,
      user_gender TEXT,
      user_title TEXT,
      categories_text TEXT,
      currency TEXT DEFAULT 'TWD',
      ledgers_text TEXT,
      show_balance_in_name INTEGER DEFAULT 1,
      vehicle_sync_enabled INTEGER DEFAULT 0,
      recurring_items_text TEXT,
      chat_style_tags_text TEXT,
      category_budgets_text TEXT,
      meal_periods_text TEXT,
      monthly_budgets_text TEXT,
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

  db.run(`
    CREATE TABLE IF NOT EXISTS recurring_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      due_at TEXT NOT NULL,
      transaction_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_id, item_key, due_at)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_reminder_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      reminder_date TEXT NOT NULL,
      reminder_time TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_id, reminder_date, reminder_time)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS guild_shared_ledgers (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS monthly_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      start_iso TEXT NOT NULL,
      end_iso TEXT NOT NULL,
      income_total REAL DEFAULT 0,
      expense_total REAL DEFAULT 0,
      net_total REAL DEFAULT 0,
      transaction_count INTEGER DEFAULT 0,
      summary_text TEXT,
      generated_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_id, year, month)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS data_change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      action TEXT NOT NULL,
      summary TEXT,
      created_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      processed INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS operation_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'external_event',
      entity TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id INTEGER,
      undo_payload TEXT NOT NULL,
      preview TEXT,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 舊資料兼容：若 timestamp 只有日期（YYYY-MM-DD），補上預設時間 00:00:00
  db.run(`
    UPDATE transactions
    SET timestamp = timestamp || 'T00:00:00'
    WHERE timestamp IS NOT NULL
      AND LENGTH(timestamp) = 10
      AND instr(timestamp, 'T') = 0
  `);

  // 修正非 UTC 格式的 timestamp（Web UI 存入的本地時間字串，如 2026-04-13T14:30:00）
  // 在 Asia/Taipei 環境下，new Date('2026-04-13T14:30:00') 會被視為台北本地時間，toISOString() 轉為正確的 UTC
  {
    const stmt = db.prepare(`
      SELECT id, timestamp FROM transactions
      WHERE timestamp IS NOT NULL
        AND timestamp NOT LIKE '%Z'
        AND timestamp NOT LIKE '%+%'
    `);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    for (const row of rows) {
      const d = new Date(String(row.timestamp || ''));
      if (!Number.isNaN(d.getTime())) {
        db.run(`UPDATE transactions SET timestamp = ? WHERE id = ?`, [d.toISOString(), Number(row.id)]);
      }
    }
  }

  db.run(`DROP TRIGGER IF EXISTS trg_tx_insert_event`);
  db.run(`DROP TRIGGER IF EXISTS trg_tx_update_event`);
  db.run(`DROP TRIGGER IF EXISTS trg_tx_delete_event`);
  db.run(`DROP TRIGGER IF EXISTS trg_settings_insert_event`);
  db.run(`DROP TRIGGER IF EXISTS trg_settings_update_event`);
  db.run(`DROP TRIGGER IF EXISTS trg_settings_delete_event`);

  db.run(`
    CREATE TRIGGER trg_tx_insert_event
    AFTER INSERT ON transactions
    BEGIN
      INSERT INTO data_change_events (channel_id, entity, action, summary, created_ms)
      VALUES (
        NEW.channel_id,
        'transactions',
        'insert',
        'id=' || NEW.id
          || ' | user=' || COALESCE(NEW.user_id, '')
          || ' | type=' || COALESCE(NEW.type, '')
          || ' | amount=' || COALESCE(NEW.amount, 0)
          || ' | category=' || COALESCE(NEW.category, '未分類')
          || ' | note=' || COALESCE(NEW.note, '')
          || ' | timestamp=' || COALESCE(NEW.timestamp, ''),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      );
    END;
  `);
  db.run(`
    CREATE TRIGGER trg_tx_update_event
    AFTER UPDATE ON transactions
    BEGIN
      INSERT INTO data_change_events (channel_id, entity, action, summary, created_ms)
      VALUES (
        NEW.channel_id,
        'transactions',
        'update',
        'id=' || NEW.id
          || ' | user_old=' || COALESCE(OLD.user_id, '')
          || ' | user_new=' || COALESCE(NEW.user_id, '')
          || ' | type_old=' || COALESCE(OLD.type, '')
          || ' | type_new=' || COALESCE(NEW.type, '')
          || ' | amount_old=' || COALESCE(OLD.amount, 0)
          || ' | amount_new=' || COALESCE(NEW.amount, 0)
          || ' | category_old=' || COALESCE(OLD.category, '未分類')
          || ' | category_new=' || COALESCE(NEW.category, '未分類')
          || ' | note_old=' || COALESCE(OLD.note, '')
          || ' | note_new=' || COALESCE(NEW.note, '')
          || ' | timestamp_old=' || COALESCE(OLD.timestamp, '')
          || ' | timestamp_new=' || COALESCE(NEW.timestamp, ''),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      );
    END;
  `);
  db.run(`
    CREATE TRIGGER trg_tx_delete_event
    AFTER DELETE ON transactions
    BEGIN
      INSERT INTO data_change_events (channel_id, entity, action, summary, created_ms)
      VALUES (
        OLD.channel_id,
        'transactions',
        'delete',
        'id=' || OLD.id
          || ' | user=' || COALESCE(OLD.user_id, '')
          || ' | type=' || COALESCE(OLD.type, '')
          || ' | amount=' || COALESCE(OLD.amount, 0)
          || ' | category=' || COALESCE(OLD.category, '未分類')
          || ' | note=' || COALESCE(OLD.note, '')
          || ' | timestamp=' || COALESCE(OLD.timestamp, ''),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      );
    END;
  `);

  db.run(`
    CREATE TRIGGER trg_settings_insert_event
    AFTER INSERT ON channel_settings
    BEGIN
      INSERT INTO data_change_events (channel_id, entity, action, summary, created_ms)
      VALUES (
        NEW.channel_id,
        'channel_settings',
        'insert',
        'type=' || COALESCE(NEW.type, 'personal')
          || ' title=' || COALESCE(NEW.user_title, '')
          || ' budget=' || COALESCE(NEW.budget, 0)
          || ' reminder=' || COALESCE(NEW.reminder_time, '')
          || ' reminderEnabled=' || COALESCE(NEW.reminder_enabled, 1)
          || ' categories=' || COALESCE(REPLACE(REPLACE(NEW.categories_text, char(13), ''), char(10), ','), ''),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      );
    END;
  `);
  db.run(`
    CREATE TRIGGER trg_settings_update_event
    AFTER UPDATE ON channel_settings
    BEGIN
      INSERT INTO data_change_events (channel_id, entity, action, summary, created_ms)
      VALUES (
        NEW.channel_id,
        'channel_settings',
        'update',
        'budget:' || COALESCE(OLD.budget, 0) || '->' || COALESCE(NEW.budget, 0)
          || ' || reminder:' || COALESCE(OLD.reminder_time, '') || '->' || COALESCE(NEW.reminder_time, '')
          || ' || reminderEnabled:' || COALESCE(OLD.reminder_enabled, 1) || '->' || COALESCE(NEW.reminder_enabled, 1)
          || ' || monthlyBudgets:' || COALESCE(OLD.monthly_budgets_text, '') || '->' || COALESCE(NEW.monthly_budgets_text, '')
          || ' || title:' || COALESCE(OLD.user_title, '') || '->' || COALESCE(NEW.user_title, '')
          || ' || showBalance:' || COALESCE(OLD.show_balance_in_name, 1) || '->' || COALESCE(NEW.show_balance_in_name, 1)
          || ' || categories:' || COALESCE(REPLACE(REPLACE(OLD.categories_text, char(13), ''), char(10), ','), '')
          || '->' || COALESCE(REPLACE(REPLACE(NEW.categories_text, char(13), ''), char(10), ','), ''),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      );
    END;
  `);
  db.run(`
    CREATE TRIGGER trg_settings_delete_event
    AFTER DELETE ON channel_settings
    BEGIN
      INSERT INTO data_change_events (channel_id, entity, action, summary, created_ms)
      VALUES (
        OLD.channel_id,
        'channel_settings',
        'delete',
        'type=' || COALESCE(OLD.type, 'personal')
          || ' title=' || COALESCE(OLD.user_title, '')
          || ' budget=' || COALESCE(OLD.budget, 0),
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      );
    END;
  `);

  migrateSchema();
  
  // 儲存資料庫
  saveDatabase();
  
  console.log('📦 資料庫初始化完成');
  return db;
}

function loadDatabaseFromDisk() {
  if (!SQLInstance) {
    throw new Error('SQL.js 尚未初始化');
  }
  if (db) {
    db.close();
  }

  if (dbPath && fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQLInstance.Database(fileBuffer);
    dbMtimeMs = fs.statSync(dbPath).mtimeMs;
    return;
  }

  db = new SQLInstance.Database();
  dbMtimeMs = 0;
}

function ensureFreshDatabase() {
  if (!db || !dbPath || !fs.existsSync(dbPath)) return;

  const mtimeMs = fs.statSync(dbPath).mtimeMs;
  if (mtimeMs !== dbMtimeMs) {
    loadDatabaseFromDisk();
  }
}

function saveDatabase() {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
    dbMtimeMs = fs.statSync(dbPath).mtimeMs;
  }
}

function getDatabase() {
  return db;
}

// 確保每次改動後儲存
function run(sql, params = []) {
  ensureFreshDatabase();
  lastLocalWriteMs = Date.now();
  db.run(sql, params);
  saveDatabase();
}

function get(sql, params = []) {
  ensureFreshDatabase();
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
  ensureFreshDatabase();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function getLastLocalWriteMs() {
  return lastLocalWriteMs;
}

module.exports = { initDatabase, getDatabase, saveDatabase, run, get, all, getLastLocalWriteMs };
