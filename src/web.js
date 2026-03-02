const express = require('express');
const path = require('path');
const { all } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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
app.get('/api/channel/:channelId', (req, res) => {
  const { channelId } = req.params;
  
  try {
    const transactions = all(`
      SELECT * FROM transactions
      WHERE channel_id = ?
      ORDER BY timestamp DESC
      LIMIT 50
    `, [channelId]);
    
    // 計算餘額
    const incomeRow = get(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions
      WHERE channel_id = ? AND type = 'income'
    `, [channelId]);
    
    const expenseRow = get(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions
      WHERE channel_id = ? AND type = 'expense'
    `, [channelId]);
    
    const balance = (incomeRow?.total || 0) - (expenseRow?.total || 0);
    
    res.json({
      channelId,
      balance,
      transactions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 取得餘額
app.get('/api/user/:userId/balance', (req, res) => {
  const { userId } = req.params;
  
  const incomeRow = get(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions
    WHERE user_id = ? AND type = 'income'
  `, [userId]);
  
  const expenseRow = get(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions
    WHERE user_id = ? AND type = 'expense'
  `, [userId]);
  
  const balance = (incomeRow?.total || 0) - (expenseRow?.total || 0);
  
  res.json({ userId, balance });
});

app.listen(PORT, () => {
  console.log(`🌐 Dashboard server running on port ${PORT}`);
});
