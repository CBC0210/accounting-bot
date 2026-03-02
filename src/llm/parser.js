const { parseWithLLM } = require('../llm/generator');

/**
 * 解析訊息是否為記帳指令
 */
async function parseTransaction(content, attachments) {
  // 簡單的正則匹配
  // 格式:uber 199, 晚餐 300, +500, -200 等
  
  // 收入格式
  const incomeMatch = content.match(/^[+]?(\d+)$/);
  if (incomeMatch) {
    return {
      amount: parseInt(incomeMatch[1]),
      type: 'income',
      category: '收入',
      note: '記錄收入',
    };
  }
  
  // 支出格式
  const expenseMatch = content.match(/^[-]?(\d+)$/);
  if (expenseMatch) {
    return {
      amount: parseInt(expenseMatch[1]),
      type: 'expense',
      category: '未分類',
      note: '記錄支出',
    };
  }
  
  // 包含文字的格式: uber 199, 晚餐 300 餐廳
  const textMatch = content.match(/^(.+?)\s+(\d+)(?:\s+(.+))?$/);
  if (textMatch) {
    const [, note, amount, category] = textMatch;
    return {
      amount: parseInt(amount),
      type: 'expense',
      category: category || guessCategory(note),
      note: note.trim(),
    };
  }
  
  // 用 LLM 解析
  const parsed = await parseWithLLM(content);
  if (parsed) {
    return parsed;
  }
  
  // 如果有附件（圖片），嘗試用 LLM 辨識
  if (attachments && attachments.size > 0) {
    // TODO: 圖片辨識
    return null;
  }
  
  return null;
}

/**
 * 猜測分類
 */
function guessCategory(text) {
  const categoryMap = {
    'food': ['吃', '飯', '餐', 'UBER', 'food', '麥當', '便當', '晚餐', '午餐', '早餐'],
    'transport': ['uber', '捷運', '公車', '火車', '高鐵', '交通', '車費'],
    'shopping': ['買', 'shopping', '商城', 'pchome', 'momo', '蝦皮'],
    'entertainment': ['電影', 'netflix', 'spotify', '遊戲', '唱', 'KTV'],
    'drink': ['飲料', '咖啡', '茶', 'starbucks', ' drink', '手搖'],
  };
  
  for (const [cat, keywords] of Object.entries(categoryMap)) {
    if (keywords.some(k => text.toLowerCase().includes(k.toLowerCase()))) {
      return cat;
    }
  }
  
  return '未分類';
}

module.exports = { parseTransaction, guessCategory };
