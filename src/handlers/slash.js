const { addTransaction, getUserBalance } = require('../db/queries');
const { generateResponse } = require('../llm/generator');

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
      
    case '設定':
    case 'settings':
      await handleSettings(interaction, options);
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

async function handleSettings(interaction, options) {
  const amount = options.getNumber('金額') || options.getNumber('amount');
  
  await interaction.reply({
    content: `⚙️ 設定功能開發中...（預算 NT$ ${amount}）`,
    ephemeral: false,
  });
}

async function handleInit(interaction) {
  const channel = interaction.channel;
  const channelId = channel.id;
  const dashboardUrl = `https://accounting.bc-verse.com/${channelId}`;
  
  const { MessageEmbed } = require('discord.js');
  
  const embed = new MessageEmbed()
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
  
  // 先回覆
  await interaction.reply({
    embeds: [embed],
  });
  
  // 發送後續問題
  setTimeout(async () => {
    await channel.send('💡 請問你的每月預算是多少？使用 /設定 [金額] 來設定');
  }, 1000);
  
  // 嘗試取得回覆的訊息來釘選
  try {
    const messages = await channel.messages.fetch({ limit: 1 });
    const lastMessage = messages.first();
    if (lastMessage && lastMessage.author.id === interaction.client.user.id) {
      await lastMessage.pin();
    }
  } catch (e) {
    console.log('釘選失敗:', e.message);
  }
}

module.exports = { handleSlashCommand };
