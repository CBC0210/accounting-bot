const { run, get, all, saveDatabase } = require('./database');

function addTransaction({ channelId, userId, amount, category, note, type, timestamp }) {
  run(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [channelId, userId, amount, category, note, type, timestamp]);
  
  return { success: true };
}

function getUserBalance(userId) {
  // 計算收入總額
  const incomeRow = get(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions
    WHERE user_id = ? AND type = 'income'
  `, [userId]);
  
  // 計算支出總額
  const expenseRow = get(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions
    WHERE user_id = ? AND type = 'expense'
  `, [userId]);
  
  const income = incomeRow ? incomeRow.total : 0;
  const expense = expenseRow ? expenseRow.total : 0;
  
  return income - expense;
}

function getChannelSettings(channelId) {
  return get(`
    SELECT * FROM channel_settings WHERE channel_id = ?
  `, [channelId]);
}

function getGuildSharedLedgerChannelId(guildId) {
  if (!guildId) return null;
  const row = get(`
    SELECT channel_id
    FROM guild_shared_ledgers
    WHERE guild_id = ?
  `, [guildId]);
  return row?.channel_id || null;
}

function upsertGuildSharedLedger(guildId, channelId) {
  if (!guildId || !channelId) return;
  run(`
    INSERT INTO guild_shared_ledgers (guild_id, channel_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      updated_at = excluded.updated_at
  `, [guildId, channelId, new Date().toISOString()]);
}

function clearGuildSharedLedger(guildId) {
  if (!guildId) return;
  run(`
    DELETE FROM guild_shared_ledgers
    WHERE guild_id = ?
  `, [guildId]);
}

function getChannelTransactionCount(channelId) {
  const row = get(`
    SELECT COUNT(*) AS total
    FROM transactions
    WHERE channel_id = ?
  `, [channelId]);
  return row ? Number(row.total) : 0;
}

function upsertChannelSettings({ channelId, name, type = 'personal' }) {
  run(`
    INSERT INTO channel_settings (channel_id, name, type, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      updated_at = excluded.updated_at
  `, [channelId, name || '未命名頻道', type, new Date().toISOString()]);
}

function setChannelSetupState(channelId, setupState, setupUserId = null) {
  run(`
    UPDATE channel_settings
    SET setup_state = ?, setup_user_id = ?, updated_at = ?
    WHERE channel_id = ?
  `, [setupState, setupUserId, new Date().toISOString(), channelId]);
}

function setChannelBudget(channelId, budget) {
  run(`
    UPDATE channel_settings
    SET budget = ?, updated_at = ?
    WHERE channel_id = ?
  `, [budget, new Date().toISOString(), channelId]);
}

function setChannelReminderTime(channelId, reminderTime) {
  run(`
    UPDATE channel_settings
    SET reminder_time = ?, updated_at = ?
    WHERE channel_id = ?
  `, [reminderTime, new Date().toISOString(), channelId]);
}

function setChannelSplitBooks(channelId, splitBooks) {
  run(`
    UPDATE channel_settings
    SET split_books = ?, updated_at = ?
    WHERE channel_id = ?
  `, [splitBooks ? 1 : 0, new Date().toISOString(), channelId]);
}

function setChannelGender(channelId, gender) {
  run(`
    UPDATE channel_settings
    SET user_gender = ?, updated_at = ?
    WHERE channel_id = ?
  `, [gender, new Date().toISOString(), channelId]);
}

function setChannelTitle(channelId, title) {
  run(`
    UPDATE channel_settings
    SET user_title = ?, updated_at = ?
    WHERE channel_id = ?
  `, [title, new Date().toISOString(), channelId]);
}

function completeChannelSetup(channelId) {
  run(`
    UPDATE channel_settings
    SET setup_state = NULL,
        setup_user_id = NULL,
        setup_completed_at = ?,
        updated_at = ?
    WHERE channel_id = ?
  `, [new Date().toISOString(), new Date().toISOString(), channelId]);
}

function clearChannelTransactions(channelId) {
  run(`
    DELETE FROM transactions
    WHERE channel_id = ?
  `, [channelId]);
}

function clearChannelSettings(channelId) {
  run(`
    DELETE FROM channel_settings
    WHERE channel_id = ?
  `, [channelId]);
}

function getTransactions(userId, limit = 10) {
  return all(`
    SELECT * FROM transactions
    WHERE user_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `, [userId, limit]);
}

function getChannelMonthlyExpense(channelId, now = new Date()) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));

  const row = get(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE channel_id = ?
      AND type = 'expense'
      AND timestamp >= ?
      AND timestamp < ?
  `, [channelId, monthStart.toISOString(), nextMonthStart.toISOString()]);

  return row ? Number(row.total) : 0;
}

function getChannelNetBalance(channelId) {
  const incomeRow = get(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE channel_id = ? AND type = 'income'
  `, [channelId]);

  const expenseRow = get(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE channel_id = ? AND type = 'expense'
  `, [channelId]);

  const income = incomeRow ? Number(incomeRow.total) : 0;
  const expense = expenseRow ? Number(expenseRow.total) : 0;
  return income - expense;
}

function getUserRangeSummary(userId, startIso, endIso) {
  const incomeRow = get(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE user_id = ?
      AND type = 'income'
      AND timestamp >= ?
      AND timestamp < ?
  `, [userId, startIso, endIso]);

  const expenseRow = get(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE user_id = ?
      AND type = 'expense'
      AND timestamp >= ?
      AND timestamp < ?
  `, [userId, startIso, endIso]);

  const countRow = get(`
    SELECT COUNT(*) AS total
    FROM transactions
    WHERE user_id = ?
      AND timestamp >= ?
      AND timestamp < ?
  `, [userId, startIso, endIso]);

  const income = incomeRow ? Number(incomeRow.total) : 0;
  const expense = expenseRow ? Number(expenseRow.total) : 0;
  const count = countRow ? Number(countRow.total) : 0;

  return {
    income,
    expense,
    net: income - expense,
    count,
  };
}

function getChannelRangeSummary(channelId, startIso, endIso) {
  const incomeRow = get(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE channel_id = ?
      AND type = 'income'
      AND timestamp >= ?
      AND timestamp < ?
  `, [channelId, startIso, endIso]);

  const expenseRow = get(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE channel_id = ?
      AND type = 'expense'
      AND timestamp >= ?
      AND timestamp < ?
  `, [channelId, startIso, endIso]);

  const countRow = get(`
    SELECT COUNT(*) AS total
    FROM transactions
    WHERE channel_id = ?
      AND timestamp >= ?
      AND timestamp < ?
  `, [channelId, startIso, endIso]);

  const income = incomeRow ? Number(incomeRow.total) : 0;
  const expense = expenseRow ? Number(expenseRow.total) : 0;
  const count = countRow ? Number(countRow.total) : 0;

  return {
    income,
    expense,
    net: income - expense,
    count,
  };
}

function getChannelMetricTotal(channelId, startIso, endIso, metric = 'expense', category = null) {
  const metricType = String(metric || 'expense');
  if (metricType === 'count') {
    const row = category
      ? get(`
        SELECT COUNT(*) AS total
        FROM transactions
        WHERE channel_id = ?
          AND timestamp >= ?
          AND timestamp < ?
          AND category = ?
      `, [channelId, startIso, endIso, category])
      : get(`
        SELECT COUNT(*) AS total
        FROM transactions
        WHERE channel_id = ?
          AND timestamp >= ?
          AND timestamp < ?
      `, [channelId, startIso, endIso]);
    return Number(row?.total || 0);
  }

  if (metricType === 'net') {
    const row = category
      ? get(`
        SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) AS total
        FROM transactions
        WHERE channel_id = ?
          AND timestamp >= ?
          AND timestamp < ?
          AND category = ?
      `, [channelId, startIso, endIso, category])
      : get(`
        SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) AS total
        FROM transactions
        WHERE channel_id = ?
          AND timestamp >= ?
          AND timestamp < ?
      `, [channelId, startIso, endIso]);
    return Number(row?.total || 0);
  }

  const type = metricType === 'income' ? 'income' : 'expense';
  const row = category
    ? get(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE channel_id = ?
        AND type = ?
        AND timestamp >= ?
        AND timestamp < ?
        AND category = ?
    `, [channelId, type, startIso, endIso, category])
    : get(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE channel_id = ?
        AND type = ?
        AND timestamp >= ?
        AND timestamp < ?
    `, [channelId, type, startIso, endIso]);

  return Number(row?.total || 0);
}

function getChannelCategoryBreakdown(channelId, startIso, endIso, metric = 'expense') {
  const metricType = String(metric || 'expense');
  if (metricType === 'count') {
    return all(`
      SELECT category, COUNT(*) AS total
      FROM transactions
      WHERE channel_id = ?
        AND timestamp >= ?
        AND timestamp < ?
      GROUP BY category
      ORDER BY total DESC
    `, [channelId, startIso, endIso]).map((row) => ({
      category: row.category || '未分類',
      total: Number(row.total || 0),
    }));
  }

  if (metricType === 'net') {
    return all(`
      SELECT category,
             COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) AS total
      FROM transactions
      WHERE channel_id = ?
        AND timestamp >= ?
        AND timestamp < ?
      GROUP BY category
      ORDER BY ABS(total) DESC
    `, [channelId, startIso, endIso]).map((row) => ({
      category: row.category || '未分類',
      total: Number(row.total || 0),
    }));
  }

  const type = metricType === 'income' ? 'income' : 'expense';
  return all(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE channel_id = ?
      AND type = ?
      AND timestamp >= ?
      AND timestamp < ?
    GROUP BY category
    ORDER BY total DESC
  `, [channelId, type, startIso, endIso]).map((row) => ({
    category: row.category || '未分類',
    total: Number(row.total || 0),
  }));
}

function getChannelDailyMetricSeries(channelId, startIso, endIso, metric = 'expense', category = null) {
  const rows = category
    ? all(`
      SELECT substr(timestamp, 1, 10) AS day,
             COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS income_total,
             COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS expense_total,
             COUNT(*) AS count_total
      FROM transactions
      WHERE channel_id = ?
        AND timestamp >= ?
        AND timestamp < ?
        AND category = ?
      GROUP BY day
      ORDER BY day ASC
    `, [channelId, startIso, endIso, category])
    : all(`
      SELECT substr(timestamp, 1, 10) AS day,
             COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS income_total,
             COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS expense_total,
             COUNT(*) AS count_total
      FROM transactions
      WHERE channel_id = ?
        AND timestamp >= ?
        AND timestamp < ?
      GROUP BY day
      ORDER BY day ASC
    `, [channelId, startIso, endIso]);

  const metricType = String(metric || 'expense');
  return rows.map((row) => {
    const income = Number(row.income_total || 0);
    const expense = Number(row.expense_total || 0);
    const count = Number(row.count_total || 0);
    let value = expense;
    if (metricType === 'income') value = income;
    if (metricType === 'net') value = income - expense;
    if (metricType === 'count') value = count;

    return {
      day: row.day,
      value,
      income,
      expense,
      count,
    };
  });
}

module.exports = {
  addTransaction,
  getUserBalance,
  getChannelSettings,
  getGuildSharedLedgerChannelId,
  upsertGuildSharedLedger,
  clearGuildSharedLedger,
  getChannelTransactionCount,
  upsertChannelSettings,
  setChannelSetupState,
  setChannelBudget,
  setChannelReminderTime,
  setChannelSplitBooks,
  setChannelGender,
  setChannelTitle,
  completeChannelSetup,
  clearChannelTransactions,
  clearChannelSettings,
  getTransactions,
  getChannelMonthlyExpense,
  getChannelNetBalance,
  getUserRangeSummary,
  getChannelRangeSummary,
  getChannelMetricTotal,
  getChannelCategoryBreakdown,
  getChannelDailyMetricSeries,
};
