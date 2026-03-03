const { all, get, run } = require('../db/database');

const TICK_INTERVAL_MS = 60 * 1000;

function getPreviousMonthByLocalDate(now = new Date()) {
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (currentMonth === 1) {
    return { year: currentYear - 1, month: 12 };
  }
  return { year: currentYear, month: currentMonth - 1 };
}

function buildMonthRangeUtc(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function shouldGenerateNow(now = new Date()) {
  return now.getDate() === 1 && now.getHours() === 0 && now.getMinutes() === 0;
}

function hasMonthlySettlement(channelId, year, month) {
  const row = get(`
    SELECT id
    FROM monthly_settlements
    WHERE channel_id = ? AND year = ? AND month = ?
  `, [channelId, year, month]);
  return Boolean(row);
}

function generateMonthlySettlementForChannel(channelId, year, month, generatedAtIso) {
  const { startIso, endIso } = buildMonthRangeUtc(year, month);
  const totals = get(`
    SELECT
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS income_total,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS expense_total,
      COUNT(*) AS tx_count
    FROM transactions
    WHERE channel_id = ?
      AND timestamp >= ?
      AND timestamp < ?
  `, [channelId, startIso, endIso]);

  const income = Number(totals?.income_total || 0);
  const expense = Number(totals?.expense_total || 0);
  const count = Number(totals?.tx_count || 0);
  const net = income - expense;
  const summary = `${year}-${String(month).padStart(2, '0')} 月結：收入 NT$ ${income.toLocaleString()}，支出 NT$ ${expense.toLocaleString()}，淨額 NT$ ${net.toLocaleString()}，共 ${count} 筆。`;

  run(`
    INSERT OR IGNORE INTO monthly_settlements (
      channel_id, year, month, start_iso, end_iso,
      income_total, expense_total, net_total, transaction_count,
      summary_text, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    channelId,
    year,
    month,
    startIso,
    endIso,
    income,
    expense,
    net,
    count,
    summary,
    generatedAtIso,
  ]);
}

function tickMonthlySettlementJobs() {
  const now = new Date();
  if (!shouldGenerateNow(now)) return;

  const { year, month } = getPreviousMonthByLocalDate(now);
  const generatedAtIso = now.toISOString();
  const channels = all(`
    SELECT channel_id
    FROM channel_settings
    WHERE setup_completed_at IS NOT NULL
  `);

  channels.forEach((row) => {
    const channelId = String(row.channel_id || '').trim();
    if (!channelId) return;
    if (hasMonthlySettlement(channelId, year, month)) return;
    generateMonthlySettlementForChannel(channelId, year, month, generatedAtIso);
  });
}

function startMonthlySettlementScheduler() {
  tickMonthlySettlementJobs();
  return setInterval(tickMonthlySettlementJobs, TICK_INTERVAL_MS);
}

module.exports = {
  startMonthlySettlementScheduler,
};
