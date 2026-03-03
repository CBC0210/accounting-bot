const { all, get, run } = require('../db/database');

const SYSTEM_USER_ID = 'system:recurring';
const TICK_INTERVAL_MS = 60 * 1000;

function parseTimeText(timeText, fallbackHour = 9, fallbackMinute = 0) {
  const match = String(timeText || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: fallbackHour, minute: fallbackMinute };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { hour: fallbackHour, minute: fallbackMinute };
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: fallbackHour, minute: fallbackMinute };
  }
  return { hour, minute };
}

function weekdayTextToIndex(weekdayText) {
  const map = {
    日: 0,
    天: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
  };
  return map[weekdayText] ?? null;
}

function splitCsvLikeLine(line) {
  return String(line || '')
    .split(/[,\uFF0C]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeType(typeText) {
  const text = String(typeText || '').trim().toLowerCase();
  if (text === 'income' || text === '收入') return 'income';
  return 'expense';
}

function parseRecurringItems(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line, index) => {
      const parts = splitCsvLikeLine(line);
      if (parts.length < 4) return null;

      const amount = Math.abs(Number(parts[1]));
      if (!Number.isFinite(amount) || amount <= 0) return null;

      return {
        key: `${index}:${parts[0]}:${amount}:${parts[2]}:${parts[3]}`,
        name: parts[0],
        amount,
        schedule: parts[2],
        type: normalizeType(parts[3]),
      };
    })
    .filter(Boolean);
}

function buildDueDate(scheduleText, now) {
  const dailyMatch = String(scheduleText).match(/^每日(?:\s+(\d{1,2}:\d{2}))?$/);
  if (dailyMatch) {
    const { hour, minute } = parseTimeText(dailyMatch[1], 9, 0);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  }

  const weeklyMatch = String(scheduleText).match(/^每週([一二三四五六日天])(?:\s+(\d{1,2}:\d{2}))?$/);
  if (weeklyMatch) {
    const targetWeekday = weekdayTextToIndex(weeklyMatch[1]);
    if (targetWeekday === null) return null;
    const { hour, minute } = parseTimeText(weeklyMatch[2], 9, 0);
    const dueDate = new Date(now);
    dueDate.setHours(hour, minute, 0, 0);
    const delta = targetWeekday - now.getDay();
    dueDate.setDate(now.getDate() + delta);
    return dueDate;
  }

  const monthlyMatch = String(scheduleText).match(/^每月(\d{1,2})號?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (monthlyMatch) {
    const day = Number(monthlyMatch[1]);
    if (!Number.isFinite(day) || day < 1 || day > 31) return null;
    const { hour, minute } = parseTimeText(monthlyMatch[2], 9, 0);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const appliedDay = Math.min(day, lastDay);
    return new Date(now.getFullYear(), now.getMonth(), appliedDay, hour, minute, 0, 0);
  }

  return null;
}

function shouldRunNow(dueDate, now) {
  if (!dueDate) return false;
  if (now < dueDate) return false;
  const maxDelayMs = 36 * 60 * 60 * 1000;
  return now.getTime() - dueDate.getTime() <= maxDelayMs;
}

function hasExecution(channelId, itemKey, dueAtIso) {
  const row = get(`
    SELECT id
    FROM recurring_executions
    WHERE channel_id = ? AND item_key = ? AND due_at = ?
  `, [channelId, itemKey, dueAtIso]);
  return Boolean(row);
}

function executeRecurringItem(channelId, item, dueDate) {
  const dueAtIso = dueDate.toISOString();
  if (hasExecution(channelId, item.key, dueAtIso)) return;

  run(`
    INSERT INTO transactions (
      channel_id, user_id, amount, category, note, type, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    channelId,
    SYSTEM_USER_ID,
    item.amount,
    item.name,
    `週期收支自動入帳（${item.schedule}）`,
    item.type,
    dueAtIso,
  ]);

  const created = get(`
    SELECT id
    FROM transactions
    WHERE channel_id = ? AND user_id = ? AND timestamp = ?
    ORDER BY id DESC
    LIMIT 1
  `, [channelId, SYSTEM_USER_ID, dueAtIso]);

  run(`
    INSERT OR IGNORE INTO recurring_executions (
      channel_id, item_key, due_at, transaction_id
    ) VALUES (?, ?, ?, ?)
  `, [channelId, item.key, dueAtIso, created ? Number(created.id) : null]);
}

function tickRecurringJobs() {
  const now = new Date();
  const rows = all(`
    SELECT channel_id, recurring_items_text
    FROM channel_settings
    WHERE recurring_items_text IS NOT NULL
      AND TRIM(recurring_items_text) <> ''
  `);

  rows.forEach((row) => {
    const items = parseRecurringItems(row.recurring_items_text);
    items.forEach((item) => {
      const dueDate = buildDueDate(item.schedule, now);
      if (!shouldRunNow(dueDate, now)) return;
      executeRecurringItem(row.channel_id, item, dueDate);
    });
  });
}

function startRecurringScheduler() {
  tickRecurringJobs();
  return setInterval(tickRecurringJobs, TICK_INTERVAL_MS);
}

module.exports = {
  startRecurringScheduler,
};

