const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { initDatabase } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsvRow(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim());
}

function buildTransactionsCsv(transactions) {
  const header = ['timestamp', 'type', 'amount', 'category', 'note', 'user_id'];
  const rows = transactions.map((tx) => [
    tx.timestamp,
    tx.type,
    tx.amount,
    tx.category || '',
    tx.note || '',
    tx.user_id || '',
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

function parseTransactionsCsv(csvText) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const header = parseCsvRow(lines[0]).map((h) => h.toLowerCase());
  const required = ['timestamp', 'type', 'amount', 'category', 'note', 'user_id'];
  const hasRequired = required.every((column) => header.includes(column));
  if (!hasRequired) {
    throw new Error('CSV 欄位不足，必須包含 timestamp,type,amount,category,note,user_id');
  }

  return lines.slice(1).map((line) => {
    const cols = parseCsvRow(line);
    const obj = {};
    header.forEach((name, idx) => {
      obj[name] = cols[idx] ?? '';
    });
    return {
      timestamp: obj.timestamp || new Date().toISOString(),
      type: obj.type === 'income' ? 'income' : 'expense',
      amount: Number(obj.amount) || 0,
      category: obj.category || '未分類',
      note: obj.note || '',
      user_id: obj.user_id || 'imported:web',
    };
  });
}

function resolveMonthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || y < 2000 || m < 1 || m > 12) {
    return null;
  }
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  return { startIso: start.toISOString(), endIso: end.toISOString(), year: y, month: m };
}

function getLedgerDisplayNameFromSettingsRow(row) {
  const type = String(row?.type || 'personal');
  if (type === 'shared') return '共同賬本';
  const title = String(row?.user_title || '').trim();
  if (title) return `${title}的賬本`;
  const fallback = String(row?.name || '').trim();
  return fallback || '個人賬本';
}

function withReadonlyDb(handler) {
  return (req, res) => {
    const dbPath = process.env.DB_PATH || './data/accounting.db';
    let db;
    try {
      db = new Database(dbPath, { readonly: true });
      handler(req, res, db);
    } catch (error) {
      res.status(500).json({ error: error.message });
    } finally {
      if (db) db.close();
    }
  };
}

function withWritableDb(handler) {
  return (req, res) => {
    const dbPath = process.env.DB_PATH || './data/accounting.db';
    let db;
    try {
      db = new Database(dbPath);
      handler(req, res, db);
    } catch (error) {
      res.status(500).json({ error: error.message });
    } finally {
      if (db) db.close();
    }
  };
}

// 首頁 / 說明頁
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 頻道記錄頁面 /:channelId
app.get('/:channelId', (req, res) => {
  const { channelId } = req.params;
  res.sendFile(path.join(__dirname, '../public/channel.html'));
});

// API: 取得頻道記錄
app.get('/api/channel/:channelId', withReadonlyDb((req, res, db) => {
  const { channelId } = req.params;
  
  try {
    const transactions = db.prepare(`
      SELECT * FROM transactions
      WHERE channel_id = ?
      ORDER BY timestamp DESC
      LIMIT 50
    `).all(channelId);
    
    // 計算餘額
    const incomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions
      WHERE channel_id = ? AND type = 'income'
    `).get(channelId);
    
    const expenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions
      WHERE channel_id = ? AND type = 'expense'
    `).get(channelId);
    
    const balance = (incomeRow?.total || 0) - (expenseRow?.total || 0);
    const settingsRow = db.prepare(`
      SELECT type, user_title, name
      FROM channel_settings
      WHERE channel_id = ?
    `).get(channelId) || {};
    
    res.json({
      channelId,
      ledgerName: getLedgerDisplayNameFromSettingsRow(settingsRow),
      ledgerType: String(settingsRow?.type || 'personal'),
      balance,
      transactions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}));

// API: 取得餘額
app.get('/api/user/:userId/balance', withReadonlyDb((req, res, db) => {
  const { userId } = req.params;
  
  const incomeRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions
    WHERE user_id = ? AND type = 'income'
  `).get(userId);
  
  const expenseRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions
    WHERE user_id = ? AND type = 'expense'
  `).get(userId);
  
  const balance = (incomeRow?.total || 0) - (expenseRow?.total || 0);
  
  res.json({ userId, balance });
}));

// API: 讀取頻道設定
app.get('/api/channel/:channelId/settings', withReadonlyDb((req, res, db) => {
  const { channelId } = req.params;
  const row = db.prepare(`
    SELECT channel_id, name, budget, reminder_time, split_books, user_gender, user_title, categories_text,
           currency, show_balance_in_name, vehicle_sync_enabled, recurring_items_text,
           chat_style_tags_text
    FROM channel_settings
    WHERE channel_id = ?
  `).get(channelId);

  res.json({
    channelId,
    ledgerName: getLedgerDisplayNameFromSettingsRow(row),
    ledgerType: String(row?.type || 'personal'),
    budget: Number(row?.budget || 0),
    reminderTime: row?.reminder_time || '',
    splitBooks: Number(row?.split_books ?? 0) === 1,
    gender: row?.user_gender || '',
    title: row?.user_title || '',
    categoriesText: row?.categories_text || '',
    currency: row?.currency || 'TWD',
    showBalanceInName: Number(row?.show_balance_in_name ?? 1) === 1,
    vehicleSyncEnabled: Number(row?.vehicle_sync_enabled ?? 0) === 1,
    recurringItemsText: row?.recurring_items_text || '',
    chatStyleTagsText: row?.chat_style_tags_text || '',
  });
}));

// API: 更新頻道設定（預算 / 分類 / 稱呼等）
app.put('/api/channel/:channelId/settings', withWritableDb((req, res, db) => {
  const { channelId } = req.params;
  const {
    budget = 0,
    reminderTime = '',
    splitBooks = false,
    gender = '',
    title = '',
    categoriesText = '',
    currency = 'TWD',
    ledgersText = '',
    showBalanceInName = true,
    vehicleSyncEnabled = false,
    recurringItemsText = '',
    chatStyleTagsText = '',
  } = req.body || {};

  if (!Number.isFinite(Number(budget)) || Number(budget) < 0) {
    res.status(400).json({ error: '預算格式錯誤，必須為 0 或正數' });
    return;
  }
  if (reminderTime && !/^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(reminderTime).trim())) {
    res.status(400).json({ error: '提醒時間格式錯誤，請使用 HH:mm' });
    return;
  }
  if (currency && !/^[A-Za-z]{2,6}$/.test(String(currency).trim())) {
    res.status(400).json({ error: '貨幣格式錯誤，請輸入 2-6 位英文字母' });
    return;
  }
  if (gender && !['male', 'female', 'other'].includes(String(gender).trim())) {
    res.status(400).json({ error: '性別格式錯誤' });
    return;
  }

  db.prepare(`
    INSERT INTO channel_settings (
      channel_id, budget, reminder_time, split_books, user_gender, user_title, categories_text,
      currency, ledgers_text, show_balance_in_name, vehicle_sync_enabled, recurring_items_text,
      chat_style_tags_text, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      budget = excluded.budget,
      reminder_time = excluded.reminder_time,
      split_books = excluded.split_books,
      user_gender = excluded.user_gender,
      user_title = excluded.user_title,
      categories_text = excluded.categories_text,
      currency = excluded.currency,
      ledgers_text = excluded.ledgers_text,
      show_balance_in_name = excluded.show_balance_in_name,
      vehicle_sync_enabled = excluded.vehicle_sync_enabled,
      recurring_items_text = excluded.recurring_items_text,
      chat_style_tags_text = excluded.chat_style_tags_text,
      updated_at = excluded.updated_at
  `).run(
    channelId,
    Number(budget) || 0,
    String(reminderTime || '').trim(),
    splitBooks ? 1 : 0,
    String(gender || ''),
    String(title || ''),
    String(categoriesText || ''),
    String(currency || 'TWD').trim().toUpperCase(),
    String(ledgersText || ''),
    showBalanceInName ? 1 : 0,
    vehicleSyncEnabled ? 1 : 0,
    String(recurringItemsText || ''),
    String(chatStyleTagsText || ''),
    new Date().toISOString()
  );

  res.json({ success: true });
}));

// API: 編輯單筆交易
app.put('/api/channel/:channelId/transactions/:id', withWritableDb((req, res, db) => {
  const { channelId, id } = req.params;
  const { amount, category, note, type, timestamp } = req.body || {};

  const existing = db.prepare(`
    SELECT id FROM transactions WHERE id = ? AND channel_id = ?
  `).get(Number(id), channelId);

  if (!existing) {
    res.status(404).json({ error: '找不到該筆交易' });
    return;
  }

  db.prepare(`
    UPDATE transactions
    SET amount = ?, category = ?, note = ?, type = ?, timestamp = ?
    WHERE id = ? AND channel_id = ?
  `).run(
    Number(amount) || 0,
    String(category || '未分類'),
    String(note || ''),
    type === 'income' ? 'income' : 'expense',
    String(timestamp || new Date().toISOString()),
    Number(id),
    channelId
  );

  res.json({ success: true });
}));

// API: 依月份取得交易清單
app.get('/api/channel/:channelId/transactions', withReadonlyDb((req, res, db) => {
  const { channelId } = req.params;
  const { year, month } = req.query;
  const range = resolveMonthRange(year, month);

  let transactions;
  if (range) {
    transactions = db.prepare(`
      SELECT *
      FROM transactions
      WHERE channel_id = ?
        AND timestamp >= ?
        AND timestamp < ?
      ORDER BY timestamp DESC
    `).all(channelId, range.startIso, range.endIso);
  } else {
    transactions = db.prepare(`
      SELECT *
      FROM transactions
      WHERE channel_id = ?
      ORDER BY timestamp DESC
      LIMIT 200
    `).all(channelId);
  }

  res.json({ channelId, transactions });
}));

// API: 月份分析（總額 + 類別分布）
app.get('/api/channel/:channelId/analytics/month', withReadonlyDb((req, res, db) => {
  const { channelId } = req.params;
  const now = new Date();
  const year = req.query.year || now.getUTCFullYear();
  const month = req.query.month || (now.getUTCMonth() + 1);
  const range = resolveMonthRange(year, month);
  if (!range) {
    res.status(400).json({ error: 'year/month 格式錯誤' });
    return;
  }

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='income' THEN amount END), 0) AS income_total,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense_total
    FROM transactions
    WHERE channel_id = ?
      AND timestamp >= ?
      AND timestamp < ?
  `).get(channelId, range.startIso, range.endIso);

  const expenseByCategory = db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE channel_id = ?
      AND type = 'expense'
      AND timestamp >= ?
      AND timestamp < ?
    GROUP BY category
    ORDER BY total DESC
  `).all(channelId, range.startIso, range.endIso);

  const incomeByCategory = db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE channel_id = ?
      AND type = 'income'
      AND timestamp >= ?
      AND timestamp < ?
    GROUP BY category
    ORDER BY total DESC
  `).all(channelId, range.startIso, range.endIso);

  res.json({
    channelId,
    year: range.year,
    month: range.month,
    totals: {
      income: Number(totals?.income_total || 0),
      expense: Number(totals?.expense_total || 0),
      net: Number(totals?.income_total || 0) - Number(totals?.expense_total || 0),
    },
    expenseByCategory: expenseByCategory.map((row) => ({ category: row.category || '未分類', total: Number(row.total || 0) })),
    incomeByCategory: incomeByCategory.map((row) => ({ category: row.category || '未分類', total: Number(row.total || 0) })),
  });
}));

// API: 刪除單筆交易
app.delete('/api/channel/:channelId/transactions/:id', withWritableDb((req, res, db) => {
  const { channelId, id } = req.params;
  const result = db.prepare(`
    DELETE FROM transactions WHERE id = ? AND channel_id = ?
  `).run(Number(id), channelId);

  if (!result.changes) {
    res.status(404).json({ error: '找不到該筆交易' });
    return;
  }

  res.json({ success: true });
}));

// API: 匯出交易（CSV / JSON）
app.get('/api/channel/:channelId/export', withReadonlyDb((req, res, db) => {
  const { channelId } = req.params;
  const format = String(req.query.format || 'json').toLowerCase();
  const settings = db.prepare(`
    SELECT *
    FROM channel_settings
    WHERE channel_id = ?
  `).get(channelId) || {};
  const transactions = db.prepare(`
    SELECT *
    FROM transactions
    WHERE channel_id = ?
    ORDER BY timestamp ASC
  `).all(channelId);

  if (format === 'csv') {
    const csv = buildTransactionsCsv(transactions);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="channel-${channelId}.csv"`);
    res.send(csv);
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="channel-${channelId}.json"`);
  res.send(JSON.stringify({ channelId, settings, transactions }, null, 2));
}));

// API: 匯入交易（CSV / JSON）
app.post('/api/channel/:channelId/import', withWritableDb((req, res, db) => {
  const { channelId } = req.params;
  const { format = 'json', data, mode = 'append' } = req.body || {};
  const normalizedFormat = String(format).toLowerCase();
  const normalizedMode = String(mode).toLowerCase();
  if (!['json', 'csv'].includes(normalizedFormat)) {
    res.status(400).json({ error: 'format 只支援 json 或 csv' });
    return;
  }
  if (!['append', 'replace'].includes(normalizedMode)) {
    res.status(400).json({ error: 'mode 只支援 append 或 replace' });
    return;
  }

  let parsedSettings = null;
  let transactions = [];

  try {
    if (normalizedFormat === 'json') {
      const payload = typeof data === 'string' ? JSON.parse(data) : data;
      parsedSettings = payload?.settings || null;
      transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
    } else {
      transactions = parseTransactionsCsv(String(data || ''));
    }
  } catch (error) {
    res.status(400).json({ error: `解析匯入內容失敗：${error.message}` });
    return;
  }

  if (normalizedMode === 'replace') {
    db.prepare(`DELETE FROM transactions WHERE channel_id = ?`).run(channelId);
  }

  if (parsedSettings && typeof parsedSettings === 'object') {
    db.prepare(`
      INSERT INTO channel_settings (
        channel_id, name, budget, type, setup_state, setup_user_id, reminder_time, split_books,
        setup_completed_at, user_gender, user_title, categories_text, currency, ledgers_text,
        show_balance_in_name, vehicle_sync_enabled, recurring_items_text, chat_style_tags_text, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        name = excluded.name,
        budget = excluded.budget,
        type = excluded.type,
        reminder_time = excluded.reminder_time,
        split_books = excluded.split_books,
        user_gender = excluded.user_gender,
        user_title = excluded.user_title,
        categories_text = excluded.categories_text,
        currency = excluded.currency,
        ledgers_text = excluded.ledgers_text,
        show_balance_in_name = excluded.show_balance_in_name,
        vehicle_sync_enabled = excluded.vehicle_sync_enabled,
        recurring_items_text = excluded.recurring_items_text,
        chat_style_tags_text = excluded.chat_style_tags_text,
        updated_at = excluded.updated_at
    `).run(
      channelId,
      parsedSettings.name || null,
      Number(parsedSettings.budget) || 0,
      parsedSettings.type || 'personal',
      parsedSettings.setup_state || null,
      parsedSettings.setup_user_id || null,
      parsedSettings.reminder_time || '',
      Number(parsedSettings.split_books) ? 1 : 0,
      parsedSettings.setup_completed_at || null,
      parsedSettings.user_gender || '',
      parsedSettings.user_title || '',
      parsedSettings.categories_text || '',
      parsedSettings.currency || 'TWD',
      parsedSettings.ledgers_text || '',
      Number(parsedSettings.show_balance_in_name ?? 1) ? 1 : 0,
      Number(parsedSettings.vehicle_sync_enabled ?? 0) ? 1 : 0,
      parsedSettings.recurring_items_text || '',
      parsedSettings.chat_style_tags_text || '',
      new Date().toISOString()
    );
  }

  const insertStmt = db.prepare(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let importedCount = 0;

  transactions.forEach((tx) => {
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    insertStmt.run(
      channelId,
      String(tx.user_id || tx.userId || 'imported:web'),
      amount,
      String(tx.category || '未分類'),
      String(tx.note || ''),
      tx.type === 'income' ? 'income' : 'expense',
      String(tx.timestamp || new Date().toISOString())
    );
    importedCount += 1;
  });

  res.json({ success: true, importedCount });
}));

async function startWebServer() {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`🌐 Dashboard server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Dashboard 啟動失敗:', error);
    process.exit(1);
  }
}

startWebServer();
