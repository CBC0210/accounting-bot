const {
  addTransaction,
  getChannelSettings,
  getChannelNetBalance,
  getChannelRangeSummary,
  getChannelMonthlyExpense,
  getChannelTransactionCount,
  getGuildSharedLedgerChannelId,
  upsertGuildSharedLedger,
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
    case 'query':
      await handleBalance(interaction);
      break;
      
    case '預算':
    case 'budget':
      await handleBudget(interaction, options);
      break;

    case '儀表板':
    case 'dashboard':
      await handleDashboard(interaction);
      break;

    case '幫助':
    case 'help':
      await handleHelp(interaction);
      break;
      
    case '初始化':
    case 'init':
      await handleInit(interaction);
      break;

    case '初始化-共同記賬':
    case 'init-shared-ledger':
      await handleInitSharedLedger(interaction);
      break;

    default:
      await interaction.reply({
        content: '⚠️ 這個指令目前未啟用，請使用 `/幫助` 查看可用功能。',
        ephemeral: true,
      });
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
  const range =
    interaction.options.getString('範圍')
    || interaction.options.getString('period')
    || interaction.options.getString('range')
    || 'this_month';
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
  const embed = new EmbedBuilder()
    .setColor(0x4f46e5)
    .setTitle(`📊 ${parsed.label} 收支摘要`)
    .addFields(
      { name: '區間筆數', value: `${summary.count}`, inline: true },
      { name: '區間淨額', value: `NT$ ${summary.net.toLocaleString()}`, inline: true },
      { name: '目前總餘額', value: `NT$ ${overallBalance.toLocaleString()}`, inline: true },
      { name: '收入', value: `NT$ ${summary.income.toLocaleString()}`, inline: true },
      { name: '支出', value: `NT$ ${summary.expense.toLocaleString()}`, inline: true }
    )
    .setFooter({ text: '進階分析可直接輸入：「昨天和今天的消費差多少」' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleBudget(interaction, options) {
  const amount = options.getNumber('金額') || options.getNumber('amount');
  if (amount === null || amount === undefined) {
    const settings = getChannelSettings(interaction.channelId);
    const budget = Number(settings?.budget || 0);
    const spent = getChannelMonthlyExpense(interaction.channelId);
    if (!budget || budget <= 0) {
      await interaction.reply({
        content: '📌 目前尚未設定每月預算，可使用 `/預算 金額:42000` 進行設定。',
        ephemeral: false,
      });
      return;
    }
    const usage = Math.max(0, Math.round((spent / budget) * 100));
    await interaction.reply({
      content:
        `📌 目前每月預算：NT$ ${budget.toLocaleString()}\n` +
        `📉 本月已支出：NT$ ${spent.toLocaleString()}（${usage}%）`,
      ephemeral: false,
    });
    return;
  }
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

async function handleDashboard(interaction) {
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${interaction.channelId}`;
  const embed = new EmbedBuilder()
    .setColor(0x00d9ff)
    .setTitle('📊 Dashboard')
    .setDescription(`[打開本頻道儀表板](${dashboardUrl})`)
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: false });
}

async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('🧭 指令與用法')
    .setDescription('建議以「直接對話」為主，Slash 作為快速入口。')
    .addFields(
      { name: '/初始化', value: '啟動或重置本頻道初始化流程', inline: false },
      { name: '/記帳', value: '快速新增一筆支出（也可直接打字記帳）', inline: false },
      { name: '/收入', value: '快速新增一筆收入', inline: false },
      { name: '/查詢', value: '查詢今天/昨天/本週/本月等區間收支摘要', inline: false },
      { name: '/預算', value: '設定預算，或不填金額直接查看目前預算', inline: false },
      { name: '/儀表板', value: '取得本頻道 Dashboard 連結', inline: false },
      { name: '/初始化-共同記賬', value: '設定此伺服器唯一共同賬本頻道', inline: false }
    )
    .setFooter({ text: '進階查詢示例：昨天和今天的消費差多少、本月支出分類占比' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
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

async function handleInitSharedLedger(interaction) {
  const channel = interaction.channel;
  const channelId = channel.id;
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: '⚠️ 共同賬本僅支援伺服器文字頻道。',
      ephemeral: true,
    });
    return;
  }

  const existingSharedChannelId = getGuildSharedLedgerChannelId(guildId);
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

  const isSwitchingChannel = Boolean(existingSharedChannelId && existingSharedChannelId !== channelId);
  if (isSwitchingChannel || transactionCount > 0 || pinnedCount > 0 || hasConfiguredSettings) {
    const previousCount = isSwitchingChannel ? getChannelTransactionCount(existingSharedChannelId) : 0;
    const warningEmbed = new EmbedBuilder()
      .setColor(0xff8c42)
      .setTitle('⚠️ 確認初始化共同賬本')
      .setDescription(
        isSwitchingChannel
          ? `此伺服器目前共同賬本為 <#${existingSharedChannelId}>，若確認切換會清空舊共同賬本資料。`
          : '此頻道已有資料，若確認會清空目前頻道資料後作為共同賬本。'
      )
      .addFields(
        { name: '🏦 新共同賬本頻道', value: `<#${channelId}>`, inline: false },
        { name: '🧾 目前頻道記帳筆數', value: `${transactionCount}`, inline: true },
        { name: '📌 目前頻道釘選數', value: `${pinnedCount}`, inline: true },
        { name: '⚙️ 目前頻道設定', value: hasConfiguredSettings ? '已有設定' : '無', inline: true },
        { name: '🗂️ 舊共同賬本記帳筆數', value: isSwitchingChannel ? `${previousCount}` : '無', inline: true }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`init_shared_confirm:${channelId}:${interaction.user.id}:${guildId}:${existingSharedChannelId || 'none'}`)
        .setLabel('確認切換共同賬本')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`init_shared_cancel:${channelId}:${interaction.user.id}:${guildId}:${existingSharedChannelId || 'none'}`)
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

  upsertGuildSharedLedger(guildId, channelId);
  await interaction.reply({
    content: '✅ 已設定此頻道為共同賬本，請依序完成初始化。',
    ephemeral: true,
  });
  await startChannelInitialization(channel, interaction.user.id, dashboardUrl, 'shared');
}

async function handleComponentInteraction(interaction) {
  if (!interaction.isButton()) return;
  const [action, channelId, ownerUserId] = String(interaction.customId || '').split(':');
  if (
    action !== 'init_confirm'
    && action !== 'init_cancel'
    && action !== 'init_shared_confirm'
    && action !== 'init_shared_cancel'
  ) return;

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

  if (action === 'init_shared_cancel') {
    await interaction.update({
      content: '已取消共同賬本初始化，原本資料保留。',
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === 'init_shared_confirm') {
    const [, , , guildId, previousSharedChannelId] = String(interaction.customId || '').split(':');
    await interaction.update({
      content: '⏳ 正在切換共同賬本並清理資料...',
      embeds: [],
      components: [],
    });

    const channel = interaction.channel;
    const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
    const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${channelId}`;

    const currentResult = await resetChannelData(channel);
    let previousResult = { clearedTransactions: 0, unpinned: 0, channelId: null };
    if (previousSharedChannelId && previousSharedChannelId !== 'none' && previousSharedChannelId !== channelId) {
      previousResult = await resetAnotherChannelData(interaction.guild, previousSharedChannelId);
    }

    upsertGuildSharedLedger(guildId, channelId);
    await startChannelInitialization(channel, interaction.user.id, dashboardUrl, 'shared');

    await interaction.followUp({
      content:
        `✅ 共同賬本已設定為 <#${channelId}>。\n` +
        `- 目前頻道已清除 ${currentResult.clearedTransactions} 筆記帳、取消 ${currentResult.unpinned} 則釘選。\n` +
        `${previousResult.channelId ? `- 舊共同賬本 <#${previousResult.channelId}> 已清除 ${previousResult.clearedTransactions} 筆記帳、取消 ${previousResult.unpinned} 則釘選。\n` : ''}` +
        '接下來請完成初始化設定。',
      ephemeral: true,
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

async function startChannelInitialization(channel, setupUserId, dashboardUrl, type = 'personal') {
  const channelId = channel.id;
  upsertChannelSettings({
    channelId,
    name: channel.name,
    type,
  });
  setChannelSetupState(channelId, 'await_budget', setupUserId);

  const titleText = type === 'shared' ? '🦑 共同記賬機器人' : '🦑 記帳機器人';
  const welcomeText = type === 'shared'
    ? '歡迎使用共同記賬機器人！\n先完成初始化，之後伺服器成員可共用這本帳。'
    : '歡迎使用記帳機器人！\n先完成初始化，之後就能直接對話記帳。';

  const embed = new EmbedBuilder()
    .setColor(0x00d9ff)
    .setTitle(titleText)
    .setDescription(welcomeText)
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

async function resetAnotherChannelData(guild, channelId) {
  const transactionCount = getChannelTransactionCount(channelId);
  clearChannelTransactions(channelId);
  clearChannelSettings(channelId);

  let unpinned = 0;
  try {
    const target = await guild.channels.fetch(channelId);
    if (target && typeof target.messages?.fetchPinned === 'function') {
      const pinnedMessages = await getPinnedMessagesSafe(target);
      for (const pinnedMessage of pinnedMessages) {
        try {
          await pinnedMessage.unpin();
          unpinned += 1;
        } catch (error) {
          console.log('舊共同賬本取消釘選失敗:', error.message);
        }
      }
    }
  } catch (error) {
    console.log('讀取舊共同賬本頻道失敗:', error.message);
  }

  return {
    channelId,
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

  if (range === 'yesterday') {
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    return { startIso: start.toISOString(), endIso: end.toISOString(), label: '昨天' };
  }

  if (range === 'week' || range === 'this_week' || range === 'last_week') {
    const start = new Date(now);
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day; // 週一作為一週起點
    start.setDate(start.getDate() + diff);
    if (range === 'last_week') start.setDate(start.getDate() - 7);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return {
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      label: range === 'last_week' ? '上週' : '本週',
    };
  }

  if (range === 'month' || range === 'this_month' || range === 'last_month') {
    const shift = range === 'last_month' ? -1 : 0;
    const start = new Date(now.getFullYear(), now.getMonth() + shift, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + shift + 1, 1, 0, 0, 0, 0);
    return {
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      label: range === 'last_month' ? '上月' : '本月',
    };
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
