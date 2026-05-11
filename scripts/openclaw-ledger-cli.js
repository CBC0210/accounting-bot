#!/usr/bin/env node
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/accounting.db';
const db = new Database(dbPath);
const DEFAULT_ALLOWED_CATEGORIES = [
  '餐飲', '交通', '購物', '娛樂', '房租/帳單', '住宿', '日常生活', '醫療', '教育', '投資', '禮物', '其他',
  '薪資', '兼職', '被動收入', '紅包', '生活費',
];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function printHelp() {
  const lines = [
    'OpenClaw Ledger CLI (帳本維度：channel_id)',
    '',
    'Commands:',
    '  ledgers',
    '  settings-show --channel <channelId>',
    '  query --channel <channelId> [--preset today|yesterday|this_month|last_month|this_week|last_week] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--metric expense|income|net|count] [--category <分類>] [--meal breakfast|lunch|dinner|late_night]',
    '  entries --channel <channelId> [同 query 參數] [--limit 50]',
    '  add --channel <channelId> --amount <num> [--type expense|income] [--category <分類>] [--note <備註>] [--user <userId>] [--time <ISO>]',
    '  update --channel <channelId> --id <id> [--amount <num>] [--type expense|income] [--category <分類>] [--note <備註>]',
    '  delete --channel <channelId> --id <id>',
    '',
    'Discord-like Examples:',
    '  # 那這個月交通費呢',
    '  node scripts/openclaw-ledger-cli.js query --channel 1477641066105540638 --preset this_month --metric expense --category 交通費',
    '',
    '  # 幫我查我今天早餐吃多少',
    '  node scripts/openclaw-ledger-cli.js query --channel 1477641066105540638 --preset today --meal breakfast --metric expense --category 餐飲',
    '',
    '  # 學餐 70',
    '  node scripts/openclaw-ledger-cli.js add --channel 1477641066105540638 --amount 70 --type expense --category 餐飲 --note 學餐',
  ];
  console.log(lines.join('\n'));
}

function parseCategoryTags(text) {
  const raw = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tags = [];
  raw.forEach((line) => {
    if (line.includes('：')) {
      line.split('：').slice(1).join('：').split(/[、,，]/).forEach((x) => tags.push(x.trim()));
      return;
    }
    line.split(/[、,，]/).forEach((x) => tags.push(x.trim()));
  });
  const unique = [...new Set(tags.filter(Boolean))];
  return unique.length ? unique : [...DEFAULT_ALLOWED_CATEGORIES];
}

function normalizeTagText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:、,，。!！?？\-_]/g, '');
}

function inferCategoryAlias(input, allowed) {
  const text = String(input || '').toLowerCase();
  const map = [
    { kws: ['早餐', '午餐', '晚餐', '宵夜', '咖啡', '飲料', '餐', '吃'], target: '餐飲' },
    { kws: ['捷運', '公車', 'uber', '計程車', '交通', '交通費'], target: '交通' },
    { kws: ['購物', '蝦皮', 'momo'], target: '購物' },
    { kws: ['娛樂', '電影', '遊戲'], target: '娛樂' },
  ];
  for (const item of map) {
    if (!item.kws.some((k) => text.includes(k))) continue;
    const hit = allowed.find((tag) => normalizeTagText(tag) === normalizeTagText(item.target));
    if (hit) return hit;
  }
  return null;
}

function getAllowedCategoriesForChannel(channelId) {
  const row = db.prepare('SELECT categories_text FROM channel_settings WHERE channel_id = ?').get(channelId);
  return parseCategoryTags(row?.categories_text || '');
}

function normalizeCategoryForChannel(channelId, categoryRaw, contextText = '') {
  if (!categoryRaw) return null;
  const allowed = getAllowedCategoriesForChannel(channelId);
  const raw = normalizeTagText(categoryRaw);
  const exact = allowed.find((tag) => normalizeTagText(tag) === raw);
  if (exact) return exact;
  const partial = allowed.find((tag) => {
    const n = normalizeTagText(tag);
    return n.includes(raw) || raw.includes(n);
  });
  if (partial) return partial;
  const alias = inferCategoryAlias(`${categoryRaw || ''} ${contextText || ''}`, allowed);
  if (alias) return alias;
  const other = allowed.find((tag) => ['其他', '未分類'].includes(String(tag || '').trim()));
  return other || allowed[0];
}

function defaultMealPeriods() {
  return {
    breakfast: { start: '05:00', end: '10:59' },
    lunch: { start: '11:00', end: '15:59' },
    dinner: { start: '16:00', end: '21:59' },
    late_night: { start: '22:00', end: '04:59' },
  };
}

function getMealPeriods(channelId) {
  const row = db.prepare('SELECT meal_periods_text FROM channel_settings WHERE channel_id = ?').get(channelId);
  const fallback = defaultMealPeriods();
  if (!row?.meal_periods_text) return fallback;
  try {
    const parsed = JSON.parse(String(row.meal_periods_text || '{}'));
    return {
      breakfast: parsed.breakfast || fallback.breakfast,
      lunch: parsed.lunch || fallback.lunch,
      dinner: parsed.dinner || fallback.dinner,
      late_night: parsed.late_night || fallback.late_night,
    };
  } catch (_) {
    return fallback;
  }
}

function hourInRange(hour, start, end) {
  const sh = Number(String(start || '00:00').slice(0, 2));
  const eh = Number(String(end || '23:59').slice(0, 2));
  if (sh <= eh) return hour >= sh && hour <= eh;
  return hour >= sh || hour <= eh;
}

function inMeal(ts, meal, periods) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return false;
  const h = d.getHours();
  const p = periods[meal];
  if (!p) return true;
  return hourInRange(h, p.start, p.end);
}

function rangeFromPreset(preset) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  if (preset === 'today') {
    const start = startOfDay(now);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { start, end };
  }
  if (preset === 'yesterday') {
    const end = startOfDay(now);
    const start = new Date(end); start.setDate(start.getDate() - 1);
    return { start, end };
  }
  if (preset === 'this_month' || preset === 'last_month') {
    const shift = preset === 'last_month' ? -1 : 0;
    const start = new Date(now.getFullYear(), now.getMonth() + shift, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + shift + 1, 1, 0, 0, 0, 0);
    return { start, end };
  }
  if (preset === 'this_week' || preset === 'last_week') {
    const day = now.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday, 0, 0, 0, 0);
    if (preset === 'last_week') start.setDate(start.getDate() - 7);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    return { start, end };
  }
  return null;
}

function resolveRange(args) {
  if (args.start && args.end) {
    const s = new Date(`${args.start}T00:00:00`);
    const e = new Date(`${args.end}T00:00:00`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) throw new Error('start/end 日期格式錯誤');
    e.setDate(e.getDate() + 1);
    return { start: s, end: e };
  }
  const preset = String(args.preset || 'this_month');
  const range = rangeFromPreset(preset);
  if (!range) throw new Error(`不支援的 preset: ${preset}`);
  return range;
}

function queryRows(channelId, args) {
  const range = resolveRange(args);
  let rows = db.prepare(`
    SELECT id, channel_id, user_id, type, amount, category, note, timestamp
    FROM transactions
    WHERE channel_id = ?
      AND timestamp >= ?
      AND timestamp < ?
    ORDER BY timestamp ASC, id ASC
  `).all(channelId, range.start.toISOString(), range.end.toISOString());

  const category = normalizeCategoryForChannel(channelId, args.category);
  if (category) {
    const normalized = normalizeTagText(category);
    rows = rows.filter((r) => normalizeTagText(r.category || '') === normalized);
  }
  if (args.type) {
    const type = String(args.type) === 'income' ? 'income' : 'expense';
    rows = rows.filter((r) => r.type === type);
  }
  if (args.meal) {
    const meal = String(args.meal);
    const periods = getMealPeriods(channelId);
    rows = rows.filter((r) => inMeal(r.timestamp, meal, periods));
  }
  return rows;
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function commandLedgers() {
  const rows = db.prepare(`
    SELECT s.channel_id,
           CASE
             WHEN s.type='shared' THEN '共同帳本'
             WHEN TRIM(COALESCE(s.user_title,''))<>'' THEN TRIM(s.user_title)||'的帳本'
             ELSE COALESCE(s.name,'未命名帳本')
           END AS ledger_name,
           s.type
    FROM channel_settings s
    ORDER BY s.updated_at DESC
  `).all();
  printJson(rows);
}

function commandSettingsShow(args) {
  const channelId = String(args.channel || '');
  if (!channelId) throw new Error('缺少 --channel');
  const row = db.prepare('SELECT * FROM channel_settings WHERE channel_id = ?').get(channelId);
  if (!row) throw new Error('找不到頻道設定');
  printJson({
    channelId,
    ledgerName: row.type === 'shared' ? '共同帳本' : (row.user_title ? `${row.user_title}的帳本` : row.name),
    budget: Number(row.budget || 0),
    reminderTime: row.reminder_time || '',
    mealPeriods: getMealPeriods(channelId),
    allowedCategories: getAllowedCategoriesForChannel(channelId),
    categoriesText: row.categories_text || '',
  });
}

function commandQuery(args) {
  const channelId = String(args.channel || '');
  if (!channelId) throw new Error('缺少 --channel');
  const metric = String(args.metric || 'expense');
  const rows = queryRows(channelId, args);
  const income = rows.filter((r) => r.type === 'income').reduce((s, r) => s + Number(r.amount || 0), 0);
  const expense = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + Number(r.amount || 0), 0);
  const net = income - expense;
  const count = rows.length;
  let value = expense;
  if (metric === 'income') value = income;
  if (metric === 'net') value = net;
  if (metric === 'count') value = count;
  printJson({
    channelId,
    metric,
    value,
    summary: { income, expense, net, count },
    filters: {
      preset: args.preset || null,
      start: args.start || null,
      end: args.end || null,
      category: normalizeCategoryForChannel(channelId, args.category) || null,
      meal: args.meal || null,
      type: args.type || null,
    },
  });
}

function commandEntries(args) {
  const channelId = String(args.channel || '');
  if (!channelId) throw new Error('缺少 --channel');
  const limit = Math.max(1, Math.min(500, Number(args.limit || 50)));
  const rows = queryRows(channelId, args).slice(0, limit);
  printJson({ channelId, total: rows.length, rows });
}

function commandAdd(args) {
  const channelId = String(args.channel || '');
  if (!channelId) throw new Error('缺少 --channel');
  const amount = Number(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount 必須為正數');
  const type = String(args.type || 'expense') === 'income' ? 'income' : 'expense';
  const defaultCategoryHint = type === 'income' ? '收入' : '其他';
  const category = normalizeCategoryForChannel(channelId, args.category || defaultCategoryHint, `${args.note || ''} ${type}`);
  const note = String(args.note || '');
  const userId = String(args.user || 'manual:openclaw');
  const timestamp = args.time ? new Date(String(args.time)).toISOString() : new Date().toISOString();
  db.prepare(`
    INSERT INTO transactions(channel_id,user_id,amount,category,note,type,timestamp)
    VALUES(?,?,?,?,?,?,?)
  `).run(channelId, userId, amount, category, note, type, timestamp);
  const row = db.prepare('SELECT * FROM transactions WHERE channel_id=? ORDER BY id DESC LIMIT 1').get(channelId);
  printJson({ success: true, row });
}

function commandUpdate(args) {
  const channelId = String(args.channel || '');
  const id = Number(args.id);
  if (!channelId) throw new Error('缺少 --channel');
  if (!Number.isFinite(id)) throw new Error('缺少 --id');
  const before = db.prepare('SELECT * FROM transactions WHERE channel_id=? AND id=?').get(channelId, id);
  if (!before) throw new Error('找不到指定交易');
  const amount = args.amount ? Number(args.amount) : Number(before.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount 必須為正數');
  const type = args.type ? (String(args.type) === 'income' ? 'income' : 'expense') : before.type;
  const category = args.category
    ? normalizeCategoryForChannel(channelId, args.category, `${args.note || before.note || ''} ${type}`)
    : before.category;
  const note = args.note !== undefined ? String(args.note) : String(before.note || '');
  db.prepare('UPDATE transactions SET amount=?,type=?,category=?,note=? WHERE channel_id=? AND id=?')
    .run(amount, type, category, note, channelId, id);
  const after = db.prepare('SELECT * FROM transactions WHERE channel_id=? AND id=?').get(channelId, id);
  printJson({ success: true, before, after });
}

function commandDelete(args) {
  const channelId = String(args.channel || '');
  const id = Number(args.id);
  if (!channelId) throw new Error('缺少 --channel');
  if (!Number.isFinite(id)) throw new Error('缺少 --id');
  const before = db.prepare('SELECT * FROM transactions WHERE channel_id=? AND id=?').get(channelId, id);
  if (!before) throw new Error('找不到指定交易');
  db.prepare('DELETE FROM transactions WHERE channel_id=? AND id=?').run(channelId, id);
  printJson({ success: true, deleted: before });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').toLowerCase();
  if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
    printHelp();
    return;
  }
  const aliases = {
    查詢: 'query',
    明細: 'entries',
    記帳: 'add',
    修改: 'update',
    刪除: 'delete',
  };
  const resolved = aliases[cmd] || cmd;
  if (resolved === 'ledgers') return commandLedgers();
  if (resolved === 'settings-show') return commandSettingsShow(args);
  if (resolved === 'query') return commandQuery(args);
  if (resolved === 'entries') return commandEntries(args);
  if (resolved === 'add') return commandAdd(args);
  if (resolved === 'update') return commandUpdate(args);
  if (resolved === 'delete') return commandDelete(args);
  throw new Error(`未知指令：${cmd}`);
}

try {
  main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
