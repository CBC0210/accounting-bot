const {
  addTransaction,
  getChannelSettings,
  getChannelNetBalance,
  getChannelRangeSummary,
  getChannelMonthlyExpense,
  getChannelTransactionCount,
  upsertChannelSettings,
  setChannelSetupState,
  setChannelBudget,
  clearChannelTransactions,
  clearChannelSettings,
} = require('../db/queries');
const { generateResponse } = require('../llm/generator');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { updateChannelBalanceName } = require('./channel');

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
  if (!ensureChannelReady(interaction)) return;
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
  
  const balance = getChannelNetBalance(interaction.channelId);
  const settings = getChannelSettings(interaction.channelId);
  const budget = Number(settings?.budget || 0);
  const monthlySpent = getChannelMonthlyExpense(interaction.channelId);
  const styleTags = parseStyleTags(settings?.chat_style_tags_text);
  // 頻道改名走背景，不阻塞 slash 指令回覆
  void updateChannelBalanceName(interaction.channel);
  const feedback = await generateResponse(transaction, balance, { budget, monthlySpent, styleTags });
  
  await interaction.reply({
    content: `✅ 記錄完成！\nNT$ ${amount}（${category}）\n💰 餘額：NT$ ${balance}\n${feedback}`,
    ephemeral: false,
  });
}

async function handleIncome(interaction, options) {
  if (!ensureChannelReady(interaction)) return;
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
  
  const balance = getChannelNetBalance(interaction.channelId);
  const settings = getChannelSettings(interaction.channelId);
  const budget = Number(settings?.budget || 0);
  const monthlySpent = getChannelMonthlyExpense(interaction.channelId);
  const styleTags = parseStyleTags(settings?.chat_style_tags_text);
  // 頻道改名走背景，不阻塞 slash 指令回覆
  void updateChannelBalanceName(interaction.channel);
  const feedback = await generateResponse(transaction, balance, { budget, monthlySpent, styleTags });
  
  await interaction.reply({
    content: `✅ 收入記錄完成！\n+NT$ ${amount}（${source}）\n💰 餘額：NT$ ${balance}\n${feedback}`,
    ephemeral: false,
  });
}

async function handleBalance(interaction) {
  if (!ensureChannelReady(interaction)) return;
  const range = interaction.options.getString('範圍') || interaction.options.getString('range') || 'month';
  const startDateText = interaction.options.getString('起日') || interaction.options.getString('start_date');
  const endDateText = interaction.options.getString('迄日') || interaction.options.getString('end_date');

  const parsed = parseRangeInput(range, startDateText, endDateText);
  if (parsed.error) {
    await interaction.reply({
      content: `⚠️ ${parsed.error}`,
      ephemeral: true,
    });
    return;
  }

  const summary = getChannelRangeSummary(interaction.channelId, parsed.startIso, parsed.endIso);
  const overallBalance = getChannelNetBalance(interaction.channelId);

  await interaction.reply({
    content:
      `📌 查詢區間：${parsed.label}\n` +
      `🧾 筆數：${summary.count}\n` +
      `📈 收入：NT$ ${summary.income.toLocaleString()}\n` +
      `📉 支出：NT$ ${summary.expense.toLocaleString()}\n` +
      `💹 區間淨額：NT$ ${summary.net.toLocaleString()}\n` +
      `💰 目前總餘額：NT$ ${overallBalance.toLocaleString()}`,
    ephemeral: false,
  });
}

async function handleStats(interaction, options) {
  if (!ensureChannelReady(interaction)) return;
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
  const transactionCount = getChannelTransactionCount(channelId);
  const settings = getChannelSettings(channelId);
  const pinnedMessages = await getPinnedMessagesSafe(channel);
  const pinnedCount = pinnedMessages.length;

  const hasConfiguredSettings = Boolean(
    settings && (
      Number(settings.budget || 0) > 0 ||
      settings.reminder_time ||
      settings.user_gender ||
      settings.setup_completed_at
    )
  );

  if (transactionCount > 0 || pinnedCount > 0 || hasConfiguredSettings) {
    const warningEmbed = new EmbedBuilder()
      .setColor(0xff6b6b)
      .setTitle('⚠️ 確認重新初始化')
      .setDescription('這個頻道已有歷史資料。若繼續初始化，會清空該頻道的舊記帳資料與釘選訊息。')
      .addFields(
        { name: '🧾 歷史記帳筆數', value: `${transactionCount}`, inline: true },
        { name: '📌 釘選訊息數', value: `${pinnedCount}`, inline: true },
        { name: '⚙️ 設定狀態', value: hasConfiguredSettings ? '已有設定' : '無', inline: true }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`init_confirm:${channelId}:${interaction.user.id}`)
        .setLabel('確認清空並初始化')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`init_cancel:${channelId}:${interaction.user.id}`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      embeds: [warningEmbed],
      components: [row],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: '✅ 已開始初始化，請看頻道訊息。',
    ephemeral: true,
  });
  await startChannelInitialization(channel, interaction.user.id, dashboardUrl);
}

async function handleComponentInteraction(interaction) {
  if (!interaction.isButton()) return;
  const [action, channelId, ownerUserId] = String(interaction.customId || '').split(':');
  if (action !== 'init_confirm' && action !== 'init_cancel') return;

  if (interaction.user.id !== ownerUserId) {
    await interaction.reply({
      content: '這個初始化確認按鈕不是你發起的。',
      ephemeral: true,
    });
    return;
  }

  if (interaction.channelId !== channelId) {
    await interaction.reply({
      content: '這個按鈕已不適用於目前頻道。',
      ephemeral: true,
    });
    return;
  }

  if (action === 'init_cancel') {
    await interaction.update({
      content: '已取消初始化，原本資料保留。',
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.update({
    content: '⏳ 正在清空舊資料並重新初始化...',
    embeds: [],
    components: [],
  });

  const channel = interaction.channel;
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${channelId}`;

  const result = await resetChannelData(channel);

  await interaction.followUp({
    content:
      `✅ 已完成重新初始化（清除記帳 ${result.clearedTransactions} 筆、取消釘選 ${result.unpinned} 則）。\n` +
      '接下來會在頻道送出新的初始化引導訊息。',
    ephemeral: true,
  });

  await startChannelInitialization(channel, interaction.user.id, dashboardUrl);
}

async function startChannelInitialization(channel, setupUserId, dashboardUrl) {
  const channelId = channel.id;
  upsertChannelSettings({
    channelId,
    name: channel.name,
    type: 'personal',
  });
  setChannelSetupState(channelId, 'await_budget', setupUserId);

  const embed = new EmbedBuilder()
    .setColor(0x00d9ff)
    .setTitle('🦑 記帳機器人')
    .setDescription('歡迎使用記帳機器人！\n先完成初始化，之後就能直接對話記帳。')
    .addFields(
      { name: '📊 Dashboard', value: `[打開網頁儀表板](${dashboardUrl})`, inline: false },
      { name: '💬 記帳方式', value: '直接說話就能記，如「uber 199」或「晚餐 300」', inline: false },
      { name: '📷 發票辨識', value: '直接傳圖片給我，自動解析金額', inline: false }
    )
    .setFooter({ text: '記帳機器人 v1.0' })
    .setTimestamp();

  const botMessage = await channel.send({ embeds: [embed] });
  await channel.send('💡 先來完成初始化第 1 題：請直接回覆你每月預算金額（例如：42000）。');
  try {
    await botMessage.pin();
  } catch (error) {
    console.log('釘選失敗:', error.message);
  }
}

async function resetChannelData(channel) {
  const channelId = channel.id;
  const transactionCount = getChannelTransactionCount(channelId);
  clearChannelTransactions(channelId);
  clearChannelSettings(channelId);

  let unpinned = 0;
  const pinnedMessages = await getPinnedMessagesSafe(channel);
  for (const pinnedMessage of pinnedMessages) {
    try {
      await pinnedMessage.unpin();
      unpinned += 1;
    } catch (error) {
      console.log('取消釘選失敗:', error.message);
    }
  }

  return {
    clearedTransactions: transactionCount,
    unpinned,
  };
}

async function getPinnedMessagesSafe(channel) {
  try {
    const collection = await channel.messages.fetchPinned();
    return Array.from(collection.values());
  } catch (error) {
    console.log('讀取釘選訊息失敗:', error.message);
    return [];
  }
}

function parseRangeInput(range, startDateText, endDateText) {
  const now = new Date();

  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startIso: start.toISOString(), endIso: end.toISOString(), label: '本日' };
  }

  if (range === 'week') {
    const start = new Date(now);
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day; // 週一作為一週起點
    start.setDate(start.getDate() + diff);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { startIso: start.toISOString(), endIso: end.toISOString(), label: '本週' };
  }

  if (range === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    return { startIso: start.toISOString(), endIso: end.toISOString(), label: '本月' };
  }

  if (range === 'custom') {
    if (!startDateText || !endDateText) {
      return { error: '自訂範圍需要同時提供「起日」與「迄日」，格式：YYYY-MM-DD。' };
    }

    const start = parseDateOnly(startDateText);
    const end = parseDateOnly(endDateText);
    if (!start || !end) {
      return { error: '日期格式錯誤，請使用 YYYY-MM-DD。' };
    }

    const endExclusive = new Date(end);
    endExclusive.setDate(endExclusive.getDate() + 1);
    if (endExclusive <= start) {
      return { error: '迄日需晚於或等於起日。' };
    }

    return {
      startIso: start.toISOString(),
      endIso: endExclusive.toISOString(),
      label: `${startDateText} ~ ${endDateText}`,
    };
  }

  // fallback: 本月
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString(), label: '本月' };
}

function parseDateOnly(text) {
  const match = String(text || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseStyleTags(styleText) {
  return String(styleText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isChannelInitialized(channelSettings) {
  if (!channelSettings) return false;
  if (channelSettings.setup_state) return false;
  return Boolean(channelSettings.setup_completed_at);
}

function ensureChannelReady(interaction) {
  const settings = getChannelSettings(interaction.channelId);
  if (isChannelInitialized(settings)) return true;

  void interaction.reply({
    content: '⚙️ 這個頻道尚未初始化完成，請先使用 `/初始化`。',
    ephemeral: true,
  });
  return false;
}

module.exports = { handleSlashCommand, handleComponentInteraction };
