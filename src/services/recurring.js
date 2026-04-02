const { all, get, run } = require('../db/database');

const SYSTEM_USER_ID = 'system:recurring';
const TICK_INTERVAL_MS = 60 * 1000;
const FX_API_BASE = 'https://open.er-api.com/v6/latest/';
const FX_API_TIMEOUT_MS = 6000;
const fxRateCache = new Map();

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

function normalizeCurrency(currencyText, fallback = 'TWD') {
  const raw = String(currencyText || '').trim().toUpperCase();
  if (/^[A-Z]{2,6}$/.test(raw)) return raw;
  return String(fallback || 'TWD').trim().toUpperCase() || 'TWD';
}

function normalizeMonthlyPolicy(policyText) {
  const text = String(policyText || '').trim().toLowerCase();
  if (text === 'skip_month') return 'skip_month';
  if (text === 'rollover_next_month') return 'rollover_next_month';
  return 'clip_to_last_day';
}

function parseItemOptions(parts) {
  const out = {};
  parts.forEach((token) => {
    const idx = String(token || '').indexOf('=');
    if (idx <= 0) return;
    const key = String(token.slice(0, idx)).trim().toLowerCase();
    const value = String(token.slice(idx + 1)).trim();
    if (!key) return;
    out[key] = value;
  });
  return out;
}

function getLocalDateKey(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchFxRate(baseCurrency, targetCurrency, dateLike = new Date()) {
  const base = normalizeCurrency(baseCurrency, 'USD');
  const target = normalizeCurrency(targetCurrency, 'TWD');
  if (base === target) return 1;

  const dateKey = getLocalDateKey(dateLike) || 'today';
  const cacheKey = `${base}->${target}@${dateKey}`;
  const cached = fxRateCache.get(cacheKey);
  if (cached && Number.isFinite(cached.rate) && cached.rate > 0) return cached.rate;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FX_API_TIMEOUT_MS);
  try {
    const response = await fetch(`${FX_API_BASE}${encodeURIComponent(base)}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`fx_api_http_${response.status}`);
    }
    const payload = await response.json();
    const rate = Number(payload?.rates?.[target]);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`fx_rate_missing_${base}_${target}`);
    }
    fxRateCache.set(cacheKey, { rate, at: Date.now() });
    return rate;
  } finally {
    clearTimeout(timer);
  }
}

function parseRecurringItems(text, baseCurrency = 'TWD') {
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
      const options = parseItemOptions(parts.slice(4));
      const currency = normalizeCurrency(options.currency || options.ccy, baseCurrency);
      const monthlyPolicy = normalizeMonthlyPolicy(options.monthlypolicy || options.month_policy);

      return {
        key: `${index}:${parts[0]}:${amount}:${parts[2]}:${parts[3]}:${currency}:${monthlyPolicy}`,
        name: parts[0],
        amount,
        schedule: parts[2],
        type: normalizeType(parts[3]),
        currency,
        monthlyPolicy,
      };
    })
    .filter(Boolean);
}

function buildDueDate(scheduleText, now, monthlyPolicy = 'clip_to_last_day') {
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
    const policy = normalizeMonthlyPolicy(monthlyPolicy);
    if (day <= lastDay) {
      return new Date(now.getFullYear(), now.getMonth(), day, hour, minute, 0, 0);
    }
    if (policy === 'skip_month') return null;
    if (policy === 'rollover_next_month') {
      return new Date(now.getFullYear(), now.getMonth() + 1, 1, hour, minute, 0, 0);
    }
    return new Date(now.getFullYear(), now.getMonth(), lastDay, hour, minute, 0, 0);
  }

  const yearlyMatch = String(scheduleText).match(/^每年(\d{1,2})(?:\/|月)(\d{1,2})日?(?:\s+(\d{1,2}:\d{2}))?$/);
  if (yearlyMatch) {
    const month = Number(yearlyMatch[1]);
    const day = Number(yearlyMatch[2]);
    if (!Number.isFinite(month) || !Number.isFinite(day) || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    const { hour, minute } = parseTimeText(yearlyMatch[3], 9, 0);
    const policy = normalizeMonthlyPolicy(monthlyPolicy);

    const buildCandidate = (year) => {
      const lastDay = new Date(year, month, 0).getDate();
      if (day <= lastDay) {
        return new Date(year, month - 1, day, hour, minute, 0, 0);
      }
      if (policy === 'skip_month') return null;
      if (policy === 'rollover_next_month') {
        return new Date(year, month, 1, hour, minute, 0, 0);
      }
      return new Date(year, month - 1, lastDay, hour, minute, 0, 0);
    };

    const thisYear = buildCandidate(now.getFullYear());
    if (thisYear && thisYear > now) return thisYear;
    return buildCandidate(now.getFullYear() + 1);
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

function isYearlySchedule(scheduleText) {
  return /^每年(\d{1,2})(?:\/|月)(\d{1,2})日?(?:\s+(\d{1,2}:\d{2}))?$/.test(String(scheduleText || '').trim());
}

function splitAmountToInstallments(totalAmount, count) {
  const cents = Math.round(Number(totalAmount || 0) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || !Number.isInteger(count) || count <= 0) return [];
  const base = Math.floor(cents / count);
  let remainder = cents - (base * count);
  const chunks = [];
  for (let i = 0; i < count; i += 1) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    chunks.push((base + extra) / 100);
  }
  return chunks;
}

function addMonthsWithPolicy(anchorDate, monthOffset, monthlyPolicy = 'clip_to_last_day') {
  const policy = normalizeMonthlyPolicy(monthlyPolicy);
  const target = new Date(anchorDate);
  target.setMonth(target.getMonth() + monthOffset, 1);
  const targetYear = target.getFullYear();
  const targetMonth = target.getMonth();
  const wantedDay = anchorDate.getDate();
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  const hour = anchorDate.getHours();
  const minute = anchorDate.getMinutes();
  const second = anchorDate.getSeconds();
  const ms = anchorDate.getMilliseconds();

  if (wantedDay <= lastDay) {
    return new Date(targetYear, targetMonth, wantedDay, hour, minute, second, ms);
  }
  if (policy === 'skip_month') {
    return null;
  }
  if (policy === 'rollover_next_month') {
    return new Date(targetYear, targetMonth + 1, 1, hour, minute, second, ms);
  }
  return new Date(targetYear, targetMonth, lastDay, hour, minute, second, ms);
}

function insertRecurringTransaction(channelId, item, timestampIso, amountValue, noteText) {
  run(`
    INSERT INTO transactions (
      channel_id, user_id, amount, category, note, type, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    channelId,
    SYSTEM_USER_ID,
    amountValue,
    item.name,
    noteText,
    item.type,
    timestampIso,
  ]);

  const created = get(`
    SELECT id
    FROM transactions
    WHERE channel_id = ? AND user_id = ? AND timestamp = ?
    ORDER BY id DESC
    LIMIT 1
  `, [channelId, SYSTEM_USER_ID, timestampIso]);
  return created ? Number(created.id) : null;
}

async function resolveRecurringAmountInBaseCurrency(item, baseCurrency, dueDate) {
  const sourceCurrency = normalizeCurrency(item.currency, baseCurrency);
  const targetCurrency = normalizeCurrency(baseCurrency, 'TWD');
  const sourceAmount = Number(item.amount || 0);
  if (!Number.isFinite(sourceAmount) || sourceAmount <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (sourceCurrency === targetCurrency) {
    return {
      ok: true,
      amountBase: sourceAmount,
      rateUsed: 1,
      sourceCurrency,
      targetCurrency,
      noteExtra: '',
    };
  }
  try {
    const rate = await fetchFxRate(sourceCurrency, targetCurrency, dueDate);
    const converted = sourceAmount * Number(rate);
    return {
      ok: true,
      amountBase: converted,
      rateUsed: Number(rate),
      sourceCurrency,
      targetCurrency,
      noteExtra: `；原幣 ${sourceCurrency} ${sourceAmount.toFixed(2)}；匯率(當日) ${Number(rate).toFixed(6)}；來源 open.er-api.com`,
    };
  } catch (error) {
    return { ok: false, reason: `fx_fetch_failed:${error.message}` };
  }
}

async function executeRecurringItem(channelId, item, dueDate, baseCurrency) {
  const dueAtIso = dueDate.toISOString();
  if (hasExecution(channelId, item.key, dueAtIso)) return;
  const resolved = await resolveRecurringAmountInBaseCurrency(item, baseCurrency, dueDate);
  if (!resolved.ok) {
    console.warn('[RECURRING] skip item due to fx configuration', JSON.stringify({
      channelId,
      itemName: item.name,
      currency: item.currency,
      baseCurrency,
      reason: resolved.reason,
    }));
    return;
  }
  const amountToWrite = Math.round(Number(resolved.amountBase || 0) * 100) / 100;
  let createdTxId = null;

  if (isYearlySchedule(item.schedule)) {
    const chunks = splitAmountToInstallments(amountToWrite, 12);
    const insertedIds = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const installmentDate = addMonthsWithPolicy(dueDate, i, item.monthlyPolicy || 'clip_to_last_day');
      if (!installmentDate) continue;
      const installmentIso = installmentDate.toISOString();
      const chunkAmount = Math.round(Number(chunks[i] || 0) * 100) / 100;
      if (!Number.isFinite(chunkAmount) || chunkAmount <= 0) continue;
      const installmentNote =
        `週期收支自動入帳（年費攤提 ${i + 1}/12；原排程 ${item.schedule}；月策略:${item.monthlyPolicy || 'clip_to_last_day'}${resolved.noteExtra || ''}；年費總額 ${resolved.targetCurrency} ${amountToWrite.toFixed(2)}）`;
      const txId = insertRecurringTransaction(channelId, item, installmentIso, chunkAmount, installmentNote);
      if (txId) insertedIds.push(txId);
    }
    createdTxId = insertedIds.length ? insertedIds[0] : null;
  } else {
    const noteText =
      `週期收支自動入帳（${item.schedule}；月策略:${item.monthlyPolicy || 'clip_to_last_day'}${resolved.noteExtra || ''}；入帳 ${resolved.targetCurrency} ${amountToWrite.toFixed(2)}）`;
    createdTxId = insertRecurringTransaction(channelId, item, dueAtIso, amountToWrite, noteText);
  }

  run(`
    INSERT OR IGNORE INTO recurring_executions (
      channel_id, item_key, due_at, transaction_id
    ) VALUES (?, ?, ?, ?)
  `, [channelId, item.key, dueAtIso, createdTxId]);
}

async function tickRecurringJobs() {
  const now = new Date();
  const rows = all(`
    SELECT channel_id, recurring_items_text, currency
    FROM channel_settings
    WHERE recurring_items_text IS NOT NULL
      AND TRIM(recurring_items_text) <> ''
  `);

  for (const row of rows) {
    const baseCurrency = normalizeCurrency(row.currency, 'TWD');
    const items = parseRecurringItems(row.recurring_items_text, baseCurrency);
    for (const item of items) {
      const dueDate = buildDueDate(item.schedule, now, item.monthlyPolicy);
      if (!shouldRunNow(dueDate, now)) continue;
      await executeRecurringItem(row.channel_id, item, dueDate, baseCurrency);
    }
  }
}

function startRecurringScheduler() {
  void tickRecurringJobs();
  return setInterval(tickRecurringJobs, TICK_INTERVAL_MS);
}

module.exports = {
  startRecurringScheduler,
};

