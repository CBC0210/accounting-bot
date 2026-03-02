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

function getTransactions(userId, limit = 10) {
  return all(`
    SELECT * FROM transactions
    WHERE user_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `, [userId, limit]);
}

module.exports = {
  addTransaction,
  getUserBalance,
  getChannelSettings,
  upsertChannelSettings,
  setChannelSetupState,
  setChannelBudget,
  setChannelReminderTime,
  setChannelSplitBooks,
  setChannelGender,
  completeChannelSetup,
  getTransactions,
};
