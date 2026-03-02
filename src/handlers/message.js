const { parseTransaction } = require('../llm/parser');
const {
  getUserBalance,
  getChannelSettings,
  setChannelSetupState,
  setChannelBudget,
  setChannelReminderTime,
  setChannelGender,
  completeChannelSetup,
} = require('../db/queries');
const { generateResponse, generateChatResponse, decideActionWithLLM } = require('../llm/generator');
const { sendEmbed } = require('../utils/embed');

async function handleMessage(message) {
  console.log(`收到訊息: ${message.content} from ${message.author.username}`);
  
  const content = message.content.trim();
  const channelSettings = getChannelSettings(message.channel.id);
  const setupState = channelSettings?.setup_state || null;
  const setupUserId = channelSettings?.setup_user_id || null;
  const isSetupMode = Boolean(setupState);

  const llmDecision = await decideActionWithLLM(content, {
    isSetupMode,
    setupState,
  });

  // 初始化尚未完成時，優先強制走初始化流程
  if (isSetupMode) {
    if (setupUserId && setupUserId !== message.author.id) {
      await message.reply('⚙️ 這個頻道正在初始化中，請先等發起者完成設定。');
      return;
    }

    const handled = await handleSetupConversation(message, setupState, llmDecision, content, channelSettings);
    if (handled) {
      return;
    }

    await message.reply(getSetupPrompt(setupState));
    return;
  }

  if (llmDecision?.action === 'record_transaction') {
    const transaction = normalizeDecisionToTransaction(llmDecision);
    if (transaction) {
      await processTransaction(message, transaction);
      return;
    }
  }

  // fallback：仍支援既有解析器，但不會把純數字直接視為交易
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

async function handleSetupConversation(message, setupState, llmDecision, content, channelSettings) {
  switch (setupState) {
    case 'await_budget': {
      const budget = extractBudgetFromDecision(content, llmDecision);
      if (budget === null) {
        await message.reply('💡 請直接回覆每月預算金額（例如：42000）。');
        return true;
      }

      setChannelBudget(message.channel.id, budget);
      setChannelSetupState(message.channel.id, 'await_reminder_time', message.author.id);
      await message.reply(`✅ 已設定每月預算：NT$ ${budget.toLocaleString()}\n第 2 題：你想每天幾點提醒記帳？例如「21:30」。`);
      return true;
    }
    case 'await_reminder_time': {
      const reminderTime = extractReminderTimeFromDecision(content, llmDecision);
      if (!reminderTime) {
        await message.reply('⏰ 請回覆提醒時間（24 小時制），例如：09:00、21:30。');
        return true;
      }

      setChannelReminderTime(message.channel.id, reminderTime);
      setChannelSetupState(message.channel.id, 'await_gender', message.author.id);
      await message.reply(`✅ 已設定每日提醒時間：${reminderTime}\n第 3 題：你希望我怎麼稱呼你？可回覆「男 / 女 / 其他」。`);
      return true;
    }
    case 'await_gender': {
      const gender = extractGenderFromDecision(content, llmDecision);
      if (!gender) {
        await message.reply('🙋 請回覆「男」、「女」或「其他」。');
        return true;
      }

      setChannelGender(message.channel.id, gender);
      completeChannelSetup(message.channel.id);

      const current = getChannelSettings(message.channel.id);
      await message.reply(
        `🎉 初始化完成！\n` +
        `- 每月預算：NT$ ${(current?.budget || 0).toLocaleString()}\n` +
        `- 每日提醒：${current?.reminder_time || '未設定'}\n` +
        `- 稱呼設定：${formatGender(current?.user_gender)}`
      );
      return true;
    }
    // 舊版流程兼容：把 split_books 問題直接升級成 gender 問題
    case 'await_split_books': {
      setChannelSetupState(message.channel.id, 'await_gender', message.author.id);
      await message.reply('🔄 已更新初始化流程。\n第 3 題：你希望我怎麼稱呼你？可回覆「男 / 女 / 其他」。');
      return true;
    }
    default:
      return false;
  }
}

function normalizeDecisionToTransaction(decision) {
  if (!decision || typeof decision.amount !== 'number') return null;
  const type = decision.type === 'income' ? 'income' : 'expense';
  return {
    amount: decision.amount,
    type,
    category: decision.category || (type === 'income' ? '收入' : '未分類'),
    note: decision.note || '',
  };
}

function extractBudgetFromDecision(content, decision) {
  if (decision?.action === 'set_budget' && typeof decision.amount === 'number' && decision.amount > 0) {
    return decision.amount;
  }

  const numericMatch = content.match(/(\d+(?:\.\d+)?)/);
  if (!numericMatch) return null;
  const amount = Number(numericMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function extractReminderTimeFromDecision(content, decision) {
  if (decision?.action === 'set_reminder_time' && decision.reminderTime) {
    const normalized = normalizeTime(decision.reminderTime);
    if (normalized) return normalized;
  }

  const match = content.match(/([01]?\d|2[0-3])[:：]?([0-5]\d)?/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeTime(value) {
  const match = String(value).trim().match(/^([01]?\d|2[0-3])[:：]?([0-5]\d)$/);
  if (!match) return null;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

function extractGenderFromDecision(content, decision) {
  if (decision?.action === 'set_gender' && typeof decision.gender === 'string') {
    const normalized = normalizeGender(decision.gender);
    if (normalized) return normalized;
  }

  return normalizeGender(content);
}

function normalizeGender(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return null;
  if (/^(男|男性|male|m)$/.test(text)) return 'male';
  if (/^(女|女性|female|f)$/.test(text)) return 'female';
  if (/^(其他|不指定|other|o)$/.test(text)) return 'other';
  return null;
}

function formatGender(gender) {
  if (gender === 'male') return '男';
  if (gender === 'female') return '女';
  return '其他';
}

function getSetupPrompt(setupState) {
  switch (setupState) {
    case 'await_budget':
      return '🧭 初始化尚未完成：請先回覆「每月預算金額」（例如：42000）。';
    case 'await_reminder_time':
      return '🧭 初始化尚未完成：請先回覆「每日提醒時間」（例如：21:30）。';
    case 'await_gender':
      return '🧭 初始化尚未完成：請先回覆你的稱呼設定（男 / 女 / 其他）。';
    case 'await_split_books':
      return '🧭 初始化流程已更新：請先回覆你的稱呼設定（男 / 女 / 其他）。';
    default:
      return '🧭 初始化尚未完成，請先依序回答設定問題。';
  }
}

module.exports = { handleMessage };
