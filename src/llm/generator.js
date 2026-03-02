const fetch = require('node-fetch');

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1';

/**
 * 呼叫 MiniMax API
 */
async function callMiniMax(prompt, systemPrompt = '你是一個記帳機器人助手，會調侃使用者，風格簡短有趣') {
  if (!MINIMAX_API_KEY) {
    console.log('沒有 MiniMax API Key');
    return null;
  }
  
  try {
    const response = await fetch(`${MINIMAX_BASE_URL}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'abab6.5s-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    });
    
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error('MiniMax API Error:', error);
    return null;
  }
}

/**
 * 產生回饋訊息
 */
async function generateResponse(transaction, balance) {
  // 用 LLM 產生回饋
  const prompt = `使用者記錄了一筆消費：
- 類型：${transaction.type}
- 金額：NT$ ${transaction.amount}
- 分類：${transaction.category}
- 備註：${transaction.note || '無'}
- 餘額：NT$ ${balance}

請給出一句簡短有趣的回應（不超過20字），可以調侃或關心。`;
  
  const response = await callMiniMax(prompt);
  
  if (response) return response;
  
  // fallback
  const responses = ['記好了', 'OK', '收到', '行'];
  return responses[Math.floor(Math.random() * responses.length)];
}

/**
 * 解析自然語言記帳
 */
async function parseWithLLM(content) {
  const prompt = `分析以下訊息是否是記帳指令，如果是請解析出金額、分類、類型（expense/income）和備註：

訊息：${content}

請用以下 JSON 格式回覆，如果不是記帳指令回覆 null：
{"amount": 數字, "type": "expense"或"income", "category": "分類", "note": "備註"}`;

  try {
    const response = await callMiniMax(prompt, '你是一個JSON解析器，只回覆JSON不要其他文字');
    
    // 嘗試解析 JSON
    const match = response.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.amount) {
        return {
          amount: parsed.amount,
          type: parsed.type || 'expense',
          category: parsed.category || '未分類',
          note: parsed.note || '',
        };
      }
    }
  } catch (e) {
    console.log('LLM 解析失敗:', e.message);
  }
  
  return null;
}

/**
 * 一般對話回應
 */
async function generateChatResponse(message) {
  const prompt = `這是使用者的訊息：${message}

請用簡短一句話回應（不超過30字），可以調侃、關心、或正常聊天。`;

  const response = await callMiniMax(prompt);
  return response || '哦';
}

/**
 * 產生週期性分析
 */
async function generateMonthlyReport(userId, transactions) {
  const prompt = `使用者這個月的消費紀錄如下，請給出一段簡短的分析和建議（不超過100字）：\n\n${transactions.map(t => `- ${t.category}: NT$ ${t.amount}`).join('\n')}`;
  
  return await callMiniMax(prompt, '你是一個理財顧問，給出專業但親切的建議');
}

module.exports = { 
  generateResponse, 
  callMiniMax, 
  parseWithLLM, 
  generateChatResponse,
  generateMonthlyReport 
};
