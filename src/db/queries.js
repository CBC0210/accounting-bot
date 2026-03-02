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
  getTransactions,
};
