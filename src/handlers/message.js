const { parseTransaction, parseWithLLM } = require('../llm/parser');
const { getUserBalance } = require('../db/queries');
const { generateResponse, generateChatResponse } = require('../llm/generator');
const { sendEmbed } = require('../utils/embed');

async function handleMessage(message) {
  console.log(`收到訊息: ${message.content} from ${message.author.username}`);
  
  const content = message.content.trim();
  
  // 檢查是否為記帳指令
  const transaction = await parseTransaction(content, message.attachments);
  
  if (transaction) {
    await processTransaction(message, transaction);
    return;
  }
  
  // 一般對話回應（用 LLM）
  await handleConversation(message, content);
}

async function handleConversation(message, content) {
  // 用 LLM 回應
  const response = await generateChatResponse(content);
  await message.reply(response);
}

async function processTransaction(message, transaction) {
  const { amount, category, note, type } = transaction;
  
  // 儲存到資料庫
  const { run } = require('../db/database');
  run(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [message.channel.id, message.author.id, amount, category, note, type, new Date().toISOString()]);
  
  // 取得餘額
  const balance = getUserBalance(message.author.id);
  
  // 產生回饋
  const feedback = await generateResponse(transaction, balance);
  
  // 發送確認訊息
  await sendEmbed(message, {
    title: '✅ 記帳成功',
    fields: [
      { name: '項目', value: note || category, inline: true },
      { name: '金額', value: `${type === 'income' ? '+' : '-'}${amount}`, inline: true },
      { name: '分類', value: category, inline: true },
      { name: '餘額', value: balance.toString(), inline: false },
    ],
    footer: feedback,
  });
}

module.exports = { handleMessage };
