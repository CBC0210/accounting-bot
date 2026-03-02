const {
  addTransaction,
  getUserBalance,
  getChannelSettings,
  upsertChannelSettings,
  setChannelSetupState,
  setChannelBudget,
} = require('../db/queries');
const { generateResponse } = require('../llm/generator');
const { EmbedBuilder } = require('discord.js');

async function handleSlashCommand(interaction) {
  const { commandName, options, channel, user } = interaction;
  
  // 忽略非文字頻道
  if (!channel) return;
  
  switch (commandName) {
    case '記帳':
    case 'expense':
      await handleExpense(interaction, options);
      break;
      
    case '收入':
    case 'income':
      await handleIncome(interaction, options);
      break;
      
    case '查詢':
    case 'balance':
      await handleBalance(interaction);
      break;
      
    case '統計':
    case 'stats':
      await handleStats(interaction, options);
      break;
      
    case '預算':
    case 'budget':
      await handleBudget(interaction, options);
      break;
      
    case '初始化':
    case 'init':
      await handleInit(interaction);
      break;
  }
}

async function handleExpense(interaction, options) {
  const amount = options.getNumber('金額') || options.getNumber('amount');
  const category = options.getString('分類') || options.getString('category') || '未分類';
  const note = options.getString('備註') || options.getString('note') || '';
  
  const transaction = {
    amount,
    type: 'expense',
    category,
    note,
  };
  
  // 儲存
  addTransaction({
    channelId: interaction.channelId,
    userId: interaction.user.id,
    amount,
    category,
    note,
    type: 'expense',
    timestamp: new Date().toISOString(),
  });
  
  const balance = getUserBalance(interaction.user.id);
  const feedback = await generateResponse(transaction, balance);
  
  await interaction.reply({
    content: `✅ 記錄完成！\nNT$ ${amount}（${category}）\n💰 餘額：NT$ ${balance}\n${feedback}`,
    ephemeral: false,
  });
}

async function handleIncome(interaction, options) {
  const amount = options.getNumber('金額') || options.getNumber('amount');
  const source = options.getString('來源') || options.getString('source') || '收入';
  
  const transaction = {
    amount,
    type: 'income',
    category: '收入',
    note: source,
  };
  
  addTransaction({
    channelId: interaction.channelId,
    userId: interaction.user.id,
    amount,
    category: '收入',
    note: source,
    type: 'income',
    timestamp: new Date().toISOString(),
  });
  
  const balance = getUserBalance(interaction.user.id);
  const feedback = await generateResponse(transaction, balance);
  
  await interaction.reply({
    content: `✅ 收入記錄完成！\n+NT$ ${amount}（${source}）\n💰 餘額：NT$ ${balance}\n${feedback}`,
    ephemeral: false,
  });
}

async function handleBalance(interaction) {
  const balance = getUserBalance(interaction.user.id);
  
  await interaction.reply({
    content: `💰 你的餘額：NT$ ${balance.toLocaleString()}`,
    ephemeral: false,
  });
}

async function handleStats(interaction, options) {
  const period = options.getString('週期') || options.getString('period') || 'month';
  
  await interaction.reply({
    content: `📊 統計功能開發中...（${period}）`,
    ephemeral: false,
  });
}

async function handleBudget(interaction, options) {
  const amount = options.getNumber('金額') || options.getNumber('amount');
  setChannelBudget(interaction.channelId, amount);

  const settings = getChannelSettings(interaction.channelId);
  const waitingForBudget = settings?.setup_state === 'await_budget';
  const sameSetupUser = settings?.setup_user_id === interaction.user.id;

  if (waitingForBudget && sameSetupUser) {
    setChannelSetupState(interaction.channelId, 'await_reminder_time', interaction.user.id);
    await interaction.reply({
      content: `✅ 已設定每月預算：NT$ ${amount.toLocaleString()}\n下一題：你想每天幾點提醒記帳？例如「21:30」。`,
      ephemeral: false,
    });
    return;
  }

  await interaction.reply({
    content: `✅ 已更新每月預算：NT$ ${amount.toLocaleString()}`,
    ephemeral: false,
  });
}

async function handleInit(interaction) {
  const channel = interaction.channel;
  const channelId = channel.id;
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${channelId}`;

  // 初始化（或更新）頻道設定，並進入初始化提問流程
  upsertChannelSettings({
    channelId,
    name: channel.name,
    type: 'personal',
  });
  setChannelSetupState(channelId, 'await_budget', interaction.user.id);
  
  const embed = new EmbedBuilder()
    .setColor(0x00d9ff)
    .setTitle('🦑 記帳機器人')
    .setDescription('歡迎使用記帳機器人！')
    .addFields(
      { name: '📊 Dashboard', value: `[打開網頁儀表板](${dashboardUrl})`, inline: false },
      { name: '💬 記帳方式', value: '直接說話就能記，如「uber 199」或「晚餐 300」', inline: false },
      { name: '📷 發票辨識', value: '直接傳圖片給我，自動解析金額', inline: false },
      { name: '🔗 連結', value: dashboardUrl, inline: false }
    )
    .setFooter({ text: '記帳機器人 v1.0' })
    .setTimestamp();
  
  // 先回覆並取得訊息，避免 pin 到錯誤對象
  const replyMessage = await interaction.reply({
    embeds: [embed],
    fetchReply: true,
  });

  // 送出後續提示
  await interaction.followUp({
    content: '💡 先來完成初始化第 1 題：請直接回覆你每月預算金額（例如：42000）。',
  });

  // 直接釘選 bot 回覆的初始化訊息
  try {
    await replyMessage.pin();
  } catch (e) {
    console.log('釘選失敗:', e.message);
  }
}

module.exports = { handleSlashCommand };
