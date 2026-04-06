const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { initDatabase } = require('./db/database');
const {
  listBackups,
  createBackup,
  restoreBackupByFilename,
  getBackupConfig,
} = require('./services/db-backup');
const { stringifyCategoryRules } = require('./utils/category-rules');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

function normalizeBackupLimit(value, fallback = 30) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(raw)));
}

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
  // 使用本地時區月界線，避免 3/1 被視為 2 月（UTC 偏移）問題
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString(), year: y, month: m };
}

function getLedgerDisplayNameFromSettingsRow(row) {
  const type = String(row?.type || 'personal');
  if (type === 'shared') return '共同帳本';
  const title = String(row?.user_title || '').trim();
  if (title) return `${title}的帳本`;
  const fallback = String(row?.name || '').trim();
  return fallback || '個人帳本';
}

function parseCategoryBudgetsInput(value) {
  if (value === null || value === undefined || value === '') return {};
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('分類預算格式錯誤，需為 JSON 物件');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('分類預算格式錯誤，需為 {分類:預算} 物件');
  }
  const out = {};
  Object.entries(parsed).forEach(([key, amount]) => {
    const category = String(key || '').trim();
    if (!category) return;
    if (amount === null || amount === undefined || amount === '') return;
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`分類「${category}」預算必須為 0 或正數`);
    }
    if (numeric === 0) return;
    out[category] = Math.round(numeric);
  });
  return out;
}

function parseMealPeriodsInput(value) {
  const defaults = {
    breakfast: { start: '05:00', end: '10:59' },
    lunch: { start: '11:00', end: '15:59' },
    dinner: { start: '16:00', end: '21:59' },
    late_night: { start: '22:00', end: '04:59' },
  };
  if (value === null || value === undefined || value === '') return defaults;

  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('餐期時段格式錯誤，需為 JSON 物件');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('餐期時段格式錯誤，需為物件');
  }

  const keys = ['breakfast', 'lunch', 'dinner', 'late_night'];
  const out = {};
  keys.forEach((key) => {
    const src = parsed[key] || defaults[key];
    const start = String(src?.start || '').trim();
    const end = String(src?.end || '').trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(start) || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(end)) {
      throw new Error(`餐期「${key}」時間格式錯誤，請使用 HH:mm`);
    }
    out[key] = { start, end };
  });

  return out;
}

function parseCategoryRulesInput(value) {
  if (value === null || value === undefined || value === '') return '[]';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('分類記憶格式錯誤，需為 JSON 陣列');
  }
  if (!Array.isArray(parsed)) throw new Error('分類記憶需為陣列');
  const rules = parsed
    .map((row) => ({
      keyword: String(row?.keyword || '').trim(),
      category: String(row?.category || '').trim(),
    }))
    .filter((r) => r.keyword && r.category);
  if (rules.some((r) => r.keyword.length > 40)) throw new Error('分類記憶：關鍵字不可超過 40 字');
  return stringifyCategoryRules(rules);
}

function parseMonthlyBudgetsInput(value) {
  if (value === null || value === undefined || value === '') return {};
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('月份預算格式錯誤，需為 JSON 物件');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('月份預算格式錯誤，需為 {"YYYY-MM": 金額}');
  }
  const out = {};
  Object.entries(parsed).forEach(([key, amount]) => {
    const monthKey = String(key || '').trim();
    if (!monthKey) return;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
      throw new Error(`月份預算鍵格式錯誤：${monthKey}（需為 YYYY-MM）`);
    }
    if (amount === null || amount === undefined || amount === '') return;
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`月份預算「${monthKey}」必須為 0 或正數`);
    }
    out[monthKey] = Math.round(numeric);
  });
  return out;
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
    
    const totalIncome = Number(incomeRow?.total || 0);
    const totalExpense = Number(expenseRow?.total || 0);
    const balance = totalIncome - totalExpense;
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
      totalIncome,
      totalExpense,
      transactions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}));

// API: 資料庫備份清單
app.get('/api/backups', (req, res) => {
  try {
    const limit = normalizeBackupLimit(req.query.limit, 30);
    const backups = listBackups({ limit });
    res.json({
      backups,
      config: getBackupConfig(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 立即建立一份備份
app.post('/api/backups/create', (req, res) => {
  try {
    const reasonRaw = String(req.body?.reason || 'manual');
    const reason = reasonRaw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'manual';
    const backup = createBackup({ reason: reason.toLowerCase() });
    res.json({ success: true, backup });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 從指定備份回檔（全庫）
app.post('/api/backups/restore', (req, res) => {
  try {
    const filename = String(req.body?.filename || '').trim();
    if (!filename) {
      res.status(400).json({ error: '缺少 filename' });
      return;
    }
    const result = restoreBackupByFilename(filename, { createSafetyBackup: true });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

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
    SELECT channel_id, name, budget, reminder_time, reminder_enabled, split_books, user_gender, user_title, categories_text,
           currency, show_balance_in_name, vehicle_sync_enabled, recurring_items_text,
           chat_style_tags_text, category_budgets_text, meal_periods_text, monthly_budgets_text, category_rules_text, type
    FROM channel_settings
    WHERE channel_id = ?
  `).get(channelId);

  res.json({
    channelId,
    ledgerName: getLedgerDisplayNameFromSettingsRow(row),
    ledgerType: String(row?.type || 'personal'),
    budget: Number(row?.budget || 0),
    reminderTime: row?.reminder_time || '',
    reminderEnabled: Number(row?.reminder_enabled ?? 1) === 1,
    splitBooks: Number(row?.split_books ?? 0) === 1,
    gender: row?.user_gender || '',
    title: row?.user_title || '',
    categoriesText: row?.categories_text || '',
    currency: row?.currency || 'TWD',
    showBalanceInName: Number(row?.show_balance_in_name ?? 1) === 1,
    vehicleSyncEnabled: Number(row?.vehicle_sync_enabled ?? 0) === 1,
    recurringItemsText: row?.recurring_items_text || '',
    chatStyleTagsText: row?.chat_style_tags_text || '',
    categoryBudgetsText: row?.category_budgets_text || '',
    mealPeriodsText: row?.meal_periods_text || '',
    monthlyBudgetsText: row?.monthly_budgets_text || '',
    categoryRulesText: row?.category_rules_text || '[]',
  });
}));

// API: 更新頻道設定（預算 / 分類 / 稱呼等）
app.put('/api/channel/:channelId/settings', withWritableDb((req, res, db) => {
  const { channelId } = req.params;
  const {
    budget = 0,
    reminderTime = '',
    reminderEnabled = true,
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
    categoryBudgetsText = '',
    mealPeriodsText = '',
    monthlyBudgetsText = '',
    categoryRulesText = '[]',
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
  let parsedCategoryBudgets;
  let parsedMealPeriods;
  let parsedMonthlyBudgets;
  let serializedCategoryRules;
  try {
    parsedCategoryBudgets = parseCategoryBudgetsInput(categoryBudgetsText);
    parsedMealPeriods = parseMealPeriodsInput(mealPeriodsText);
    parsedMonthlyBudgets = parseMonthlyBudgetsInput(monthlyBudgetsText);
    serializedCategoryRules = parseCategoryRulesInput(categoryRulesText);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  const categoryBudgetTotal = Object.values(parsedCategoryBudgets).reduce((sum, v) => sum + Number(v || 0), 0);
  if (categoryBudgetTotal > Number(budget)) {
    res.status(400).json({ error: '分類預算總和不可超過每月預算' });
    return;
  }

  db.prepare(`
    INSERT INTO channel_settings (
      channel_id, budget, reminder_time, reminder_enabled, split_books, user_gender, user_title, categories_text,
      currency, ledgers_text, show_balance_in_name, vehicle_sync_enabled, recurring_items_text,
      chat_style_tags_text, category_budgets_text, meal_periods_text, monthly_budgets_text, category_rules_text, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      budget = excluded.budget,
      reminder_time = excluded.reminder_time,
      reminder_enabled = excluded.reminder_enabled,
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
      category_budgets_text = excluded.category_budgets_text,
      meal_periods_text = excluded.meal_periods_text,
      monthly_budgets_text = excluded.monthly_budgets_text,
      category_rules_text = excluded.category_rules_text,
      updated_at = excluded.updated_at
  `).run(
    channelId,
    Number(budget) || 0,
    String(reminderTime || '').trim(),
    reminderEnabled ? 1 : 0,
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
    JSON.stringify(parsedCategoryBudgets),
    JSON.stringify(parsedMealPeriods),
    JSON.stringify(parsedMonthlyBudgets),
    serializedCategoryRules,
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
      COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense_total,
      COALESCE(SUM(CASE WHEN type='expense' AND (exclude_from_budget IS NULL OR exclude_from_budget=0) THEN amount END), 0) AS budget_expense_total
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
      budgetExpense: Number(totals?.budget_expense_total || 0),
    },
    expenseByCategory: expenseByCategory.map((row) => ({ category: row.category || '未分類', total: Number(row.total || 0) })),
    incomeByCategory: incomeByCategory.map((row) => ({ category: row.category || '未分類', total: Number(row.total || 0) })),
  });
}));

// API: 月結歷史（由每月排程寫入）
app.get('/api/channel/:channelId/settlements', withReadonlyDb((req, res, db) => {
  const { channelId } = req.params;
  const limitRaw = Number(req.query.limit || 12);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(36, Math.floor(limitRaw))) : 12;

  const rows = db.prepare(`
    SELECT
      id, channel_id, year, month, start_iso, end_iso,
      income_total, expense_total, net_total, transaction_count,
      summary_text, generated_at, created_at
    FROM monthly_settlements
    WHERE channel_id = ?
    ORDER BY year DESC, month DESC
    LIMIT ?
  `).all(channelId, limit);

  res.json({
    channelId,
    settlements: rows.map((row) => ({
      id: Number(row.id),
      year: Number(row.year),
      month: Number(row.month),
      startIso: row.start_iso,
      endIso: row.end_iso,
      income: Number(row.income_total || 0),
      expense: Number(row.expense_total || 0),
      net: Number(row.net_total || 0),
      transactionCount: Number(row.transaction_count || 0),
      summary: row.summary_text || '',
      generatedAt: row.generated_at || row.created_at || null,
    })),
  });
}));

// API: 切換單筆交易是否排除於預算
app.patch('/api/channel/:channelId/transactions/:id/exclude-budget', withWritableDb((req, res, db) => {
  const { channelId, id } = req.params;
  const existing = db.prepare(`
    SELECT id, exclude_from_budget FROM transactions WHERE id = ? AND channel_id = ?
  `).get(Number(id), channelId);

  if (!existing) {
    res.status(404).json({ error: '找不到該筆交易' });
    return;
  }

  const exclude = req.body?.exclude !== undefined
    ? Boolean(req.body.exclude)
    : existing.exclude_from_budget !== 1;

  db.prepare(`
    UPDATE transactions SET exclude_from_budget = ? WHERE id = ? AND channel_id = ?
  `).run(exclude ? 1 : 0, Number(id), channelId);

  res.json({ success: true, id: Number(id), exclude_from_budget: exclude ? 1 : 0 });
}));

// API: 轉移單筆交易到另一個頻道
app.post('/api/channel/:channelId/transactions/:id/transfer', withWritableDb((req, res, db) => {
  const { channelId, id } = req.params;
  const { targetChannelId } = req.body || {};

  const target = String(targetChannelId || '').trim();
  if (!target || !/^\d+$/.test(target)) {
    res.status(400).json({ error: '目標頻道 ID 格式錯誤，需為數字字串' });
    return;
  }
  if (target === channelId) {
    res.status(400).json({ error: '目標頻道不能與來源頻道相同' });
    return;
  }

  const existing = db.prepare(`
    SELECT id FROM transactions WHERE id = ? AND channel_id = ?
  `).get(Number(id), channelId);
  if (!existing) {
    res.status(404).json({ error: '找不到該筆交易' });
    return;
  }

  db.prepare(`
    UPDATE transactions SET channel_id = ? WHERE id = ? AND channel_id = ?
  `).run(target, Number(id), channelId);

  res.json({ success: true, targetChannelId: target });
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
        channel_id, name, budget, type, setup_state, setup_user_id, reminder_time, reminder_enabled, split_books,
        setup_completed_at, user_gender, user_title, categories_text, currency, ledgers_text,
        show_balance_in_name, vehicle_sync_enabled, recurring_items_text, chat_style_tags_text, category_budgets_text, monthly_budgets_text, category_rules_text, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        name = excluded.name,
        budget = excluded.budget,
        type = excluded.type,
        reminder_time = excluded.reminder_time,
        reminder_enabled = excluded.reminder_enabled,
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
        category_budgets_text = excluded.category_budgets_text,
        monthly_budgets_text = excluded.monthly_budgets_text,
        category_rules_text = excluded.category_rules_text,
        updated_at = excluded.updated_at
    `).run(
      channelId,
      parsedSettings.name || null,
      Number(parsedSettings.budget) || 0,
      parsedSettings.type || 'personal',
      parsedSettings.setup_state || null,
      parsedSettings.setup_user_id || null,
      parsedSettings.reminder_time || '',
      Number(parsedSettings.reminder_enabled ?? 1) ? 1 : 0,
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
      typeof parsedSettings.category_budgets_text === 'string' ? parsedSettings.category_budgets_text : '',
      typeof parsedSettings.monthly_budgets_text === 'string' ? parsedSettings.monthly_budgets_text : '',
      typeof parsedSettings.category_rules_text === 'string' ? parsedSettings.category_rules_text : '',
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
