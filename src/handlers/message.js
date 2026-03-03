const {
  getChannelSettings,
  getGuildSharedLedgerChannelId,
  setChannelSetupState,
  setChannelBudget,
  setChannelReminderTime,
  setChannelGender,
  setChannelTitle,
  completeChannelSetup,
  getChannelMonthlyExpense,
  getChannelNetBalance,
  getChannelRangeSummary,
  getChannelMetricTotal,
  getChannelCategoryBreakdown,
  getChannelDailyMetricSeries,
} = require('../db/queries');
const {
  generateResponse,
  generateChatResponse,
  decideActionWithLLM,
  generateDataAnalysisResponse,
  parseTransactionFromImageWithLLM,
  planDataQueryWithLLM,
} = require('../llm/generator');
const { sendEmbed } = require('../utils/embed');
const { EmbedBuilder } = require('discord.js');
const { updateChannelBalanceName } = require('./channel');

const DEFAULT_ALLOWED_CATEGORIES = [
  '餐飲', '交通', '購物', '娛樂', '房租/帳單', '住宿', '日常生活', '醫療', '教育', '投資', '禮物', '其他',
  '薪資', '兼職', '被動收入', '紅包', '生活費',
];

const channelMessageQueues = new Map();

async function handleMessage(message) {
  const channelId = message?.channel?.id;
  if (!channelId) return;

  const previousTask = channelMessageQueues.get(channelId) || Promise.resolve();
  const nextTask = previousTask
    .catch(() => {})
    .then(() => handleMessageCore(message));

  channelMessageQueues.set(channelId, nextTask);
  try {
    await nextTask;
  } finally {
    if (channelMessageQueues.get(channelId) === nextTask) {
      channelMessageQueues.delete(channelId);
    }
  }
}

async function handleMessageCore(message) {
  console.log(`收到訊息: ${message.content} from ${message.author.username}`);

  const stopTyping = startTypingIndicator(message.channel);
  try {
    const content = message.content.trim();
    const channelSettings = getChannelSettings(message.channel.id);
    if (!isChannelReadyForMessage(channelSettings)) {
      // 未初始化頻道保持靜默，不主動回覆任何訊息
      return;
    }
    const allowedCategories = parseConfiguredCategories(channelSettings?.categories_text);
    const styleTags = parseStyleTags(channelSettings?.chat_style_tags_text);
    const setupState = channelSettings?.setup_state || null;
    const setupUserId = channelSettings?.setup_user_id || null;
    const isSetupMode = Boolean(setupState);
    const isSharedLedger = String(channelSettings?.type || 'personal') === 'shared';

    // 共同賬本不需要性別/稱呼：若還停在舊流程狀態，直接完成初始化
    if (isSetupMode && isSharedLedger && ['await_gender', 'await_title', 'await_split_books'].includes(setupState)) {
      completeChannelSetup(message.channel.id);
      void updateChannelBalanceName(message.channel);
      const current = getChannelSettings(message.channel.id);
      await message.reply(
        `✅ 已自動完成共同賬本初始化（共同賬本不需性別與稱呼）。\n` +
        `- 每月預算：NT$ ${(current?.budget || 0).toLocaleString()}\n` +
        `- 每日提醒：${current?.reminder_time || '未設定'}`
      );
      return;
    }

    const sharedTransfer = !isSetupMode ? parseSharedLedgerTransferIntent(content) : null;
    if (sharedTransfer) {
      const handled = await handleSharedLedgerTransfer(message, sharedTransfer.amount);
      if (handled) return;
    }
    const personalTransfer = !isSetupMode ? parsePersonalLedgerTransferIntent(content) : null;
    if (personalTransfer) {
      const handled = await handlePersonalLedgerTransfer(message, personalTransfer);
      if (handled) return;
    }

    const llmDecision = await decideActionWithLLM(content, {
      isSetupMode,
      setupState,
      allowedCategories,
    });

    const llmUnavailable = !llmDecision;

    // 初始化尚未完成時，優先強制走初始化流程
    if (isSetupMode) {
      if (setupUserId && setupUserId !== message.author.id) {
        await message.reply('⚙️ 這個頻道正在初始化中，請先等發起者完成設定。');
        return;
      }

      if (llmUnavailable) {
        logFallbackOnly('setup', setupState, content);
        await message.reply(`⚠️ 我剛剛沒成功理解你的回答，為避免寫錯資料，這次不會自動設定。\n${getSetupPrompt(setupState)}`);
        return;
      }

      const handled = await handleSetupConversation(message, setupState, llmDecision, content);
      if (handled) {
        return;
      }

      if (llmDecision?.needsClarification && llmDecision.followUpQuestion) {
        await message.reply(llmDecision.followUpQuestion);
        return;
      }

      await message.reply(llmUnavailable
        ? `⚠️ 我這次沒成功理解你的回答，${getSetupPrompt(setupState)}`
        : getSetupPrompt(setupState));
      return;
    }

    if (llmDecision?.action === 'record_transaction') {
      const transaction = normalizeDecisionToTransaction(llmDecision, allowedCategories, content);
      if (transaction) {
        await processTransaction(message, transaction, styleTags);
        return;
      }
    }

    const imageAttachment = getFirstImageAttachment(message);
    if (imageAttachment) {
      const imageTransaction = await parseTransactionFromImageWithLLM(imageAttachment.url, {
        allowedCategories,
      });
      if (imageTransaction) {
        const merged = normalizeDecisionToTransaction(
          {
            amount: imageTransaction.amount,
            type: imageTransaction.type,
            category: imageTransaction.category,
            note: imageTransaction.note || content || '',
          },
          allowedCategories,
          content
        );
        if (merged) {
          await processTransaction(message, merged, styleTags);
          return;
        }
      }
    }

    if (llmDecision?.action === 'query_analysis') {
      const handled = await handleQueryAnalysis(message, content, llmDecision);
      if (handled) return;
    }

    // LLM 低信心時，優先追問，不直接硬判
    if (llmDecision?.needsClarification && llmDecision.followUpQuestion) {
      await message.reply(llmDecision.followUpQuestion);
      return;
    }

    // LLM 失敗時只記 log，不自動寫入
    if (!llmDecision) {
      logFallbackOnly('general', null, content);
      await message.reply('⚠️ 我現在無法可靠判斷這句話，為避免誤記帳，這次不會自動寫入。請再說一次或稍後重試。');
      return;
    }

    // 一般對話回應（用 LLM）
    await handleConversation(message, content, styleTags);
  } finally {
    stopTyping();
  }
}

async function handleConversation(message, content, styleTags = []) {
  // 用 LLM 回應
  const response = await generateChatResponse(content, { styleTags });
  await message.reply(response);
}

async function processTransaction(message, transaction, styleTags = []) {
  const { amount, category, note, type, itemName } = transaction;
  
  // 儲存到資料庫
  const { run } = require('../db/database');
  run(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [message.channel.id, message.author.id, amount, category, note, type, new Date().toISOString()]);
  
  // 取得餘額
  const balance = getChannelNetBalance(message.channel.id);
  const settings = getChannelSettings(message.channel.id);
  const budget = Number(settings?.budget || 0);
  const monthlySpent = getChannelMonthlyExpense(message.channel.id);
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${message.channel.id}`;
  // 頻道改名可能觸發 Discord rate limit，改為背景更新避免阻塞回覆
  void updateChannelBalanceName(message.channel);

  // 1) 本月預算使用量
  await sendMonthlyBudgetUsageMessage(message);

  // 2) 發送記帳成功訊息
  await sendEmbed(message, {
    title: '✅ 記帳成功',
    fields: [
      { name: '項目', value: itemName || category || '未分類', inline: true },
      { name: '金額', value: `${type === 'income' ? '+' : '-'}${amount}`, inline: true },
      { name: '分類', value: category, inline: true },
      { name: '餘額', value: balance.toString(), inline: false },
      { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false },
    ],
  });

  // 3) 發送閒聊回饋
  const feedback = await generateResponse(transaction, balance, { budget, monthlySpent, styleTags });
  await message.channel.send(feedback);
}

async function handleQueryAnalysis(message, content, decision) {
  const llmPlan = await planDataQueryWithLLM(content);
  const fallbackPlan = resolveAnalysisPlan(content, decision);
  const plan = llmPlan || fallbackPlan;
  if (!plan) return false;

  const analysisType = plan.analysisType || 'compare_ranges';
  const metric = normalizeMetric(plan.metric) || 'expense';
  const category = typeof plan.category === 'string' && plan.category.trim() ? plan.category.trim() : null;
  const singlePreset = inferSinglePeriodPreset(content);
  const effectiveAnalysisType = shouldUseSingleRangeCard(content, analysisType, singlePreset)
    ? 'single_range'
    : analysisType;

  if (effectiveAnalysisType === 'single_range') {
    const targetRange = resolveRangeSpec(plan.targetRange, content)
      || (singlePreset ? getRangeFromPreset(singlePreset) : null);
    if (!targetRange) return false;

    const summary = getChannelRangeSummary(message.channel.id, targetRange.startIso, targetRange.endIso);
    const metricValue = getChannelMetricTotal(
      message.channel.id,
      targetRange.startIso,
      targetRange.endIso,
      metric,
      category
    );
    const rows = category
      ? []
      : getChannelCategoryBreakdown(message.channel.id, targetRange.startIso, targetRange.endIso, metric)
        .slice(0, 4);
    const rowsTotal = rows.reduce((sum, row) => sum + Math.abs(Number(row.total || 0)), 0);
    const metricLabel = metricToLabel(metric);

    const analysisText = await generateDataAnalysisResponse({
      userQuery: content,
      data: {
        analysisType: 'single_range',
        metric,
        metricLabel,
        category,
        range: targetRange,
        value: metricValue,
        summary,
        topCategories: rows,
      },
    });

    const color = metric === 'income' ? 0x2ecc71 : metric === 'net' ? 0x3498db : metric === 'count' ? 0x7f8c8d : 0xe67e22;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`📊 ${targetRange.label} ${metricLabel}摘要`)
      .addFields(
        { name: '區間結餘', value: formatMetric('net', summary.net), inline: true },
        { name: '區收', value: formatMetric('income', summary.income), inline: true },
        { name: '區支', value: formatMetric('expense', summary.expense), inline: true },
        { name: `${metricLabel}${category ? `（${category}）` : ''}`, value: formatMetric(metric, metricValue), inline: false }
      )
      .setTimestamp();

    if (rows.length > 0) {
      const categoryLines = rows.map((row) => {
        const part = rowsTotal > 0 ? Math.round((Math.abs(Number(row.total || 0)) / rowsTotal) * 100) : 0;
        return `• ${row.category} ${part}%`;
      });
      const bar = buildCategoryShareBar(rows, 20);
      embed.addFields({
        name: '區間分類分析',
        value: `${bar}\n${categoryLines.join('\n')}`,
        inline: false,
      });
    }

    await message.reply({
      content: analysisText || undefined,
      embeds: [embed],
    });
    return true;
  }

  if (effectiveAnalysisType === 'category_breakdown') {
    const targetRange = resolveRangeSpec(plan.targetRange, content) || resolveRangeSpec({ preset: 'this_month' }, content);
    if (!targetRange) return false;
    const rows = getChannelCategoryBreakdown(message.channel.id, targetRange.startIso, targetRange.endIso, metric);
    const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
    const topN = Math.max(1, Math.min(20, Number(plan.topN || 8)));
    const top = rows.slice(0, topN);
    const metricLabel = metricToLabel(metric);

    const analysisText = await generateDataAnalysisResponse({
      userQuery: content,
      data: {
        analysisType,
        metric,
        metricLabel,
        range: targetRange,
        total,
        topCategories: top,
      },
    });

    const lines = top.length
      ? top.map((row) => `- ${row.category}：${formatMetric(metric, row.total)}（${Math.round((Math.abs(row.total) / Math.max(Math.abs(total), 1)) * 100)}%）`).join('\n')
      : '- 此區間尚無資料';
    const header =
      `📊 ${targetRange.label} 分類分析（${metricLabel}）\n` +
      `總計：${formatMetric(metric, total)}\n${lines}`;
    await message.reply(analysisText ? `${header}\n\n${analysisText}` : header);
    return true;
  }

  if (effectiveAnalysisType === 'trend') {
    const targetRange = resolveRangeSpec(plan.targetRange, content) || resolveRangeSpec({ preset: 'this_month' }, content);
    if (!targetRange) return false;
    const series = getChannelDailyMetricSeries(message.channel.id, targetRange.startIso, targetRange.endIso, metric, category);
    const metricLabel = metricToLabel(metric);
    const total = series.reduce((sum, point) => sum + Number(point.value || 0), 0);
    const head = series.slice(0, 12);
    const lines = head.length
      ? head.map((point) => `- ${point.day}：${formatMetric(metric, point.value)}`).join('\n')
      : '- 此區間尚無資料';

    const analysisText = await generateDataAnalysisResponse({
      userQuery: content,
      data: {
        analysisType,
        metric,
        metricLabel,
        category,
        range: targetRange,
        total,
        points: series,
      },
    });

    const header =
      `📈 ${targetRange.label} 趨勢（${metricLabel}${category ? ` / ${category}` : ''}）\n` +
      `合計：${formatMetric(metric, total)}\n${lines}`;
    await message.reply(analysisText ? `${header}\n\n${analysisText}` : header);
    return true;
  }

  const rangeA = resolveRangeSpec(plan.rangeA, content) || resolveRangeSpec({ preset: plan.periodA }, content);
  const rangeB = resolveRangeSpec(plan.rangeB, content) || resolveRangeSpec({ preset: plan.periodB }, content);
  if (!rangeA || !rangeB) {
    await message.reply('我需要兩個比較區間，例如「昨天和今天的消費差多少」。');
    return true;
  }

  const valueA = getChannelMetricTotal(message.channel.id, rangeA.startIso, rangeA.endIso, metric, category);
  const valueB = getChannelMetricTotal(message.channel.id, rangeB.startIso, rangeB.endIso, metric, category);
  const diff = valueB - valueA;
  const absDiff = Math.abs(diff);
  const direction = diff === 0 ? '持平' : diff > 0 ? '增加' : '減少';
  const metricLabel = metricToLabel(metric);

  const analysisText = await generateDataAnalysisResponse({
    userQuery: content,
    data: {
      analysisType: 'compare_ranges',
      metric,
      metricLabel,
      category,
      periodA: { label: rangeA.label, value: valueA },
      periodB: { label: rangeB.label, value: valueB },
      diff,
      direction,
    },
  });

  const header =
    `📊 ${rangeA.label} vs ${rangeB.label}（${metricLabel}${category ? ` / ${category}` : ''}）\n` +
    `- ${rangeA.label}：${formatMetric(metric, valueA)}\n` +
    `- ${rangeB.label}：${formatMetric(metric, valueB)}\n` +
    `- 差異：${direction} ${formatMetric(metric, absDiff)}`;

  await message.reply(analysisText ? `${header}\n\n${analysisText}` : header);
  return true;
}

async function handleSetupConversation(message, setupState, llmDecision, content) {
  const channelSettings = getChannelSettings(message.channel.id);
  const isSharedLedger = String(channelSettings?.type || 'personal') === 'shared';

  switch (setupState) {
    case 'await_budget': {
      const budget = extractBudgetFromDecision(llmDecision);
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
      const reminderTime = extractReminderTimeFromDecision(llmDecision);
      if (!reminderTime) {
        await message.reply('⏰ 請回覆提醒時間（24 小時制），例如：09:00、21:30。');
        return true;
      }

      setChannelReminderTime(message.channel.id, reminderTime);
      if (isSharedLedger) {
        completeChannelSetup(message.channel.id);
        void updateChannelBalanceName(message.channel);
        const current = getChannelSettings(message.channel.id);
        await message.reply(
          `🎉 共同賬本初始化完成！\n` +
          `- 每月預算：NT$ ${(current?.budget || 0).toLocaleString()}\n` +
          `- 每日提醒：${current?.reminder_time || '未設定'}`
        );
        return true;
      }
      setChannelSetupState(message.channel.id, 'await_gender', message.author.id);
      await message.reply(`✅ 已設定每日提醒時間：${reminderTime}\n第 3 題：你的性別是什麼？可回覆「男 / 女 / 其他」。`);
      return true;
    }
    case 'await_gender': {
      // 彈性修正：若使用者在第 3 題補充的是時間，視為修正第 2 題
      const correctedReminderTime = extractReminderTimeFromDecision(llmDecision);
      if (correctedReminderTime) {
        setChannelReminderTime(message.channel.id, correctedReminderTime);
        await message.reply(`✅ 已更新提醒時間：${correctedReminderTime}\n請繼續回覆第 3 題（男 / 女 / 其他）。`);
        return true;
      }

      const gender = extractGenderFromDecision(llmDecision);
      if (!gender) {
        await message.reply('🙋 請回覆「男」、「女」或「其他」。若要修正上一題時間，也可以直接回例如「23點」。');
        return true;
      }

      setChannelGender(message.channel.id, gender);
      setChannelSetupState(message.channel.id, 'await_title', message.author.id);
      await message.reply(`✅ 已設定性別：${formatGender(gender)}\n第 4 題：你希望我怎麼稱呼你？（例如：柏丞、丞哥、你）`);
      return true;
    }
    case 'await_title': {
      // 若在最後一題回了性別，視為修正第 3 題
      const correctedGender = extractGenderFromDecision(llmDecision);
      if (correctedGender) {
        setChannelGender(message.channel.id, correctedGender);
        await message.reply(`✅ 已更新性別：${formatGender(correctedGender)}\n請繼續回覆第 4 題（你希望的稱呼）。`);
        return true;
      }

      const title = extractTitleFromDecision(llmDecision);
      if (!title) {
        await message.reply('🗣️ 請回覆你希望我使用的稱呼（例如：柏丞、丞哥、你）。');
        return true;
      }

      setChannelTitle(message.channel.id, title);
      completeChannelSetup(message.channel.id);
      // 初始化完成後背景更新頻道名稱，不阻塞使用者回覆
      void updateChannelBalanceName(message.channel);
      const current = getChannelSettings(message.channel.id);
      await message.reply(
        `🎉 初始化完成！\n` +
        `- 每月預算：NT$ ${(current?.budget || 0).toLocaleString()}\n` +
        `- 每日提醒：${current?.reminder_time || '未設定'}\n` +
        `- 性別：${formatGender(current?.user_gender)}\n` +
        `- 稱呼：${current?.user_title || '未設定'}`
      );
      return true;
    }
    // 舊版流程兼容：把 split_books 問題直接升級成 gender 問題
    case 'await_split_books': {
      setChannelSetupState(message.channel.id, 'await_gender', message.author.id);
      await message.reply('🔄 已更新初始化流程。\n第 3 題：你的性別是什麼？可回覆「男 / 女 / 其他」。');
      return true;
    }
    default:
      return false;
  }
}

function normalizeDecisionToTransaction(decision, allowedCategories = [], content = '') {
  if (!decision || typeof decision.amount !== 'number') return null;
  const type = decision.type === 'income' ? 'income' : 'expense';
  const normalizedNote = normalizeOptionalNote(decision.note);
  const normalizedCategory = normalizeTransactionCategory(
    decision.category,
    allowedCategories,
    `${normalizedNote || ''} ${content || ''}`
  );
  const category = normalizedCategory || (type === 'income' ? '收入' : '未分類');
  const itemName = normalizedNote || category;
  return {
    amount: decision.amount,
    type,
    category,
    note: normalizedNote,
    itemName,
  };
}

function parseConfiguredCategories(categoriesText) {
  const raw = String(categoriesText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const tags = [];
  raw.forEach((line) => {
    if (line.includes('：')) {
      const listText = line.split('：').slice(1).join('：');
      listText.split(/[、,，]/).forEach((token) => tags.push(token.trim()));
      return;
    }
    line.split(/[、,，]/).forEach((token) => tags.push(token.trim()));
  });

  const unique = [...new Set(tags.filter(Boolean))];
  return unique.length ? unique : [...DEFAULT_ALLOWED_CATEGORIES];
}

function parseStyleTags(styleText) {
  return String(styleText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeOptionalNote(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const lowered = text.toLowerCase();
  if (['-', '--', '無', '沒有', 'none', 'null', 'n/a', 'na'].includes(lowered)) {
    return '';
  }
  return text;
}

function normalizeTagText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:、,，。!！?？\-_]/g, '');
}

function normalizeTransactionCategory(rawCategory, allowedCategories, contextText = '') {
  const safeAllowed = Array.isArray(allowedCategories) && allowedCategories.length
    ? allowedCategories
    : [...DEFAULT_ALLOWED_CATEGORIES];

  const normalizedRaw = normalizeTagText(rawCategory);
  if (normalizedRaw) {
    const exact = safeAllowed.find((tag) => normalizeTagText(tag) === normalizedRaw);
    if (exact) return exact;

    const partial = safeAllowed.find((tag) => {
      const normalizedTag = normalizeTagText(tag);
      return normalizedTag.includes(normalizedRaw) || normalizedRaw.includes(normalizedTag);
    });
    if (partial) return partial;
  }

  const alias = inferCategoryAlias(`${rawCategory || ''} ${contextText || ''}`, safeAllowed);
  if (alias) return alias;

  const other = safeAllowed.find((tag) => ['其他', '未分類'].includes(tag));
  return other || safeAllowed[0];
}

function inferCategoryAlias(contextText, allowedCategories) {
  const text = String(contextText || '').toLowerCase();
  const aliasMap = [
    { keywords: ['早餐', '午餐', '晚餐', '宵夜', '咖啡', '飲料', '餐', '吃'], target: '餐飲' },
    { keywords: ['捷運', '公車', 'uber', '計程車', '高鐵', '火車', '交通'], target: '交通' },
    { keywords: ['蝦皮', 'momo', '購物', '買'], target: '購物' },
    { keywords: ['日常', '生活用品', '雜貨', '日用品', '家用'], target: '日常生活' },
    { keywords: ['電影', '遊戲', 'netflix', '娛樂'], target: '娛樂' },
    { keywords: ['薪水', '薪資', '發薪'], target: '薪資' },
    { keywords: ['兼職', '打工'], target: '兼職' },
    { keywords: ['紅包'], target: '紅包' },
    { keywords: ['投資', '股票', 'etf'], target: '投資' },
    { keywords: ['food', 'meal', 'restaurant', 'lunch', 'dinner'], target: '餐飲' },
    { keywords: ['transport', 'taxi', 'bus', 'train'], target: '交通' },
    { keywords: ['shopping', 'shop'], target: '購物' },
    { keywords: ['entertainment', 'movie', 'game'], target: '娛樂' },
    { keywords: ['salary', 'income'], target: '薪資' },
  ];

  for (const item of aliasMap) {
    if (!item.keywords.some((k) => text.includes(k))) continue;
    const found = allowedCategories.find((tag) => normalizeTagText(tag) === normalizeTagText(item.target));
    if (found) return found;
  }
  return null;
}

function extractBudgetFromDecision(decision) {
  if (decision?.action === 'set_budget' && typeof decision.amount === 'number' && decision.amount > 0) {
    return decision.amount;
  }
  return null;
}

function extractReminderTimeFromDecision(decision) {
  if (decision?.action === 'set_reminder_time' && decision.reminderTime) {
    const normalized = normalizeTime(decision.reminderTime);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeTime(value) {
  const match = String(value).trim().match(/^([01]?\d|2[0-3])[:：]?([0-5]\d)$/);
  if (!match) return null;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

function parseTimeFromText(content) {
  const text = String(content || '').trim();
  if (!text) return null;

  // 23:30 / 23：30
  let match = text.match(/\b(2[0-3]|[01]?\d)\s*[:：]\s*([0-5]?\d)\b/);
  if (match) {
    return formatTime(match[1], match[2]);
  }

  // 23點 / 23點30 / 23點30分 / 9點半
  match = text.match(/(2[0-3]|[01]?\d)\s*點(?:\s*([0-5]?\d)\s*分?)?/);
  if (match) {
    let minute = match[2];
    if (!minute && /點半/.test(text)) minute = '30';
    return formatTime(match[1], minute || '0');
  }

  // 純 4 碼：0930, 2130
  match = text.match(/\b([01]\d|2[0-3])([0-5]\d)\b/);
  if (match) {
    return formatTime(match[1], match[2]);
  }

  return null;
}

function formatTime(hourText, minuteText) {
  const hour = Number(hourText);
  const minute = Number(minuteText || '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function extractGenderFromDecision(decision) {
  if (decision?.action === 'set_gender' && typeof decision.gender === 'string') {
    const normalized = normalizeGender(decision.gender);
    if (normalized) return normalized;
  }
  return null;
}

function extractTitleFromDecision(decision) {
  if (decision?.action !== 'set_title') return null;
  const candidates = [decision.title, decision.note, decision.category]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  if (!candidates.length) return null;
  const value = candidates[0];
  if (value.length > 20) return value.slice(0, 20);
  return value;
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
      return '🧭 初始化尚未完成：請先回覆你的性別（男 / 女 / 其他）。';
    case 'await_title':
      return '🧭 初始化尚未完成：請先回覆你希望我使用的稱呼（例如：柏丞）。';
    case 'await_split_books':
      return '🧭 初始化流程已更新：請先回覆你的性別（男 / 女 / 其他）。';
    default:
      return '🧭 初始化尚未完成，請先依序回答設定問題。';
  }
}

function logFallbackOnly(mode, setupState, content) {
  const diagnostics = {
    mode,
    setupState,
    numeric: extractNumeric(content),
    time: parseTimeFromText(content),
    gender: normalizeGender(content),
  };
  console.warn('LLM unavailable, fallback is log-only:', diagnostics);
}

function extractNumeric(content) {
  const match = String(content || '').match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function getFirstImageAttachment(message) {
  if (!message?.attachments || typeof message.attachments.values !== 'function') return null;
  for (const attachment of message.attachments.values()) {
    const contentType = String(attachment.contentType || '').toLowerCase();
    const isImageByType = contentType.startsWith('image/');
    const isImageByName = /\.(png|jpe?g|webp|gif)$/i.test(String(attachment.name || ''));
    if (isImageByType || isImageByName) return attachment;
  }
  return null;
}

function resolveAnalysisPlan(content, decision) {
  if (isCategoryAnalysisQuery(content)) {
    return { analysisType: 'category_breakdown' };
  }

  const metric = normalizeMetric(decision?.metric) || inferMetricFromText(content);
  const periodA = normalizePeriod(decision?.periodA);
  const periodB = normalizePeriod(decision?.periodB);

  if (periodA && periodB) {
    return { metric, periodA, periodB };
  }

  // 針對常見句型的保底：昨天 vs 今天
  if (/昨天/.test(content) && /今天/.test(content)) {
    return { metric, periodA: 'yesterday', periodB: 'today' };
  }

  // 這週 vs 上週
  if (/這週|本週/.test(content) && /上週/.test(content)) {
    return { metric, periodA: 'last_week', periodB: 'this_week' };
  }

  // 這個月 vs 上個月
  if (/(這個月|本月)/.test(content) && /(上個月|上月)/.test(content)) {
    return { metric, periodA: 'last_month', periodB: 'this_month' };
  }

  const singlePreset = inferSinglePeriodPreset(content);
  if (singlePreset) {
    return {
      analysisType: 'single_range',
      metric,
      targetRange: { preset: singlePreset },
    };
  }

  return null;
}

function isCategoryAnalysisQuery(content) {
  const text = String(content || '');
  return /(分類|標籤|占比|圓餅|最多|top)/i.test(text);
}

function normalizeMetric(metric) {
  const text = String(metric || '').trim().toLowerCase();
  if (['expense', 'income', 'net', 'count'].includes(text)) return text;
  return null;
}

function inferMetricFromText(content) {
  const text = String(content || '');
  if (/收入|賺/.test(text)) return 'income';
  if (/筆數|幾筆|次數/.test(text)) return 'count';
  if (/淨額|淨收支|結餘/.test(text)) return 'net';
  return 'expense';
}

function normalizePeriod(period) {
  const text = String(period || '').trim().toLowerCase();
  const allowed = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'];
  return allowed.includes(text) ? text : null;
}

function inferSinglePeriodPreset(content) {
  const text = String(content || '');
  if (!text) return null;
  if (/昨天/.test(text) && /今天/.test(text)) return null;
  if (/昨天/.test(text)) return 'yesterday';
  if (/今天/.test(text)) return 'today';
  return null;
}

function shouldUseSingleRangeCard(content, analysisType, singlePreset) {
  if (!singlePreset) return false;
  if (analysisType === 'compare_ranges') return false;
  if (isCategoryAnalysisQuery(content)) return false;
  if (/(趨勢|走勢|每天|日趨勢)/.test(String(content || ''))) return false;
  if (/(比較|相比|差多少|差異|vs|VS|跟.+比|和.+比)/.test(String(content || ''))) return false;
  return true;
}

function getRangeFromPreset(preset) {
  const now = new Date();

  if (preset === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { label: '今天', startIso: start.toISOString(), endIso: end.toISOString() };
  }

  if (preset === 'yesterday') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    return { label: '昨天', startIso: start.toISOString(), endIso: end.toISOString() };
  }

  if (preset === 'this_week' || preset === 'last_week') {
    const day = now.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const thisWeekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday, 0, 0, 0, 0);
    const start = new Date(thisWeekStart);
    if (preset === 'last_week') start.setDate(start.getDate() - 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return {
      label: preset === 'this_week' ? '本週' : '上週',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    };
  }

  if (preset === 'this_month' || preset === 'last_month') {
    const shift = preset === 'last_month' ? -1 : 0;
    const start = new Date(now.getFullYear(), now.getMonth() + shift, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + shift + 1, 1, 0, 0, 0, 0);
    return {
      label: preset === 'this_month' ? '本月' : '上月',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    };
  }

  return null;
}

function resolveRangeSpec(rangeSpec, content = '') {
  if (rangeSpec && typeof rangeSpec === 'object') {
    const preset = normalizePeriod(rangeSpec.preset);
    if (preset) return getRangeFromPreset(preset);

    const year = Number(rangeSpec.year);
    const month = Number(rangeSpec.month);
    if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
      const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
      const end = new Date(year, month, 1, 0, 0, 0, 0);
      return {
        label: `${year}年${month}月`,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
      };
    }
  }

  const textMonth = parseYearMonthFromText(content);
  if (textMonth) {
    const start = new Date(textMonth.year, textMonth.month - 1, 1, 0, 0, 0, 0);
    const end = new Date(textMonth.year, textMonth.month, 1, 0, 0, 0, 0);
    return {
      label: `${textMonth.year}年${textMonth.month}月`,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    };
  }

  return null;
}

function metricToLabel(metric) {
  if (metric === 'income') return '收入';
  if (metric === 'net') return '淨額';
  if (metric === 'count') return '筆數';
  return '支出';
}

function formatMetric(metric, value) {
  if (metric === 'count') return `${Number(value).toLocaleString()} 筆`;
  return `NT$ ${Number(value).toLocaleString()}`;
}

function parseYearMonthFromText(content) {
  const match = String(content || '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function isChannelReadyForMessage(channelSettings) {
  if (!channelSettings) return false;
  // 初始化進行中：允許回覆初始化對話
  if (channelSettings.setup_state) return true;
  // 初始化已完成：允許正常記帳與聊天
  return Boolean(channelSettings.setup_completed_at);
}

async function sendMonthlyBudgetUsageMessage(message) {
  const settings = getChannelSettings(message.channel.id);
  const budget = Number(settings?.budget || 0);

  if (!budget || budget <= 0) {
    const embed = new EmbedBuilder()
      .setColor(0x6c757d)
      .setTitle('📊 本月預算使用量')
      .setDescription('尚未設定預算（可用 `/預算` 設定）。')
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  const spent = getChannelMonthlyExpense(message.channel.id);
  const ratio = spent / budget;
  const percent = Math.max(0, Math.round(ratio * 100));
  const bar = buildProgressBar(ratio, 20);
  const remaining = Math.max(0, budget - spent);
  const statusColor = ratio >= 1 ? 0xe74c3c : ratio >= 0.8 ? 0xf39c12 : 0x2ecc71;

  const embed = new EmbedBuilder()
    .setColor(statusColor)
    .setTitle('📊 本月預算使用量')
    .addFields(
      { name: '進度', value: `${bar} ${percent}%`, inline: false },
      { name: '已用 / 預算', value: `NT$ ${spent.toLocaleString()} / NT$ ${budget.toLocaleString()}`, inline: true },
      { name: '剩餘', value: `NT$ ${remaining.toLocaleString()}`, inline: true }
    )
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

function buildProgressBar(ratio, width) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

function buildCategoryShareBar(rows, width = 20) {
  if (!Array.isArray(rows) || !rows.length) return '無分類資料';
  const symbols = ['🟦', '🟩', '🟨', '🟧', '🟪', '🟥'];
  const totals = rows.map((row) => Math.max(0, Math.abs(Number(row.total || 0))));
  const sum = totals.reduce((acc, value) => acc + value, 0);
  if (!sum) return '無分類資料';

  const slots = totals.map((value) => Math.round((value / sum) * width));
  let used = slots.reduce((acc, value) => acc + value, 0);
  while (used < width) {
    let idx = 0;
    for (let i = 1; i < totals.length; i += 1) {
      if (totals[i] > totals[idx]) idx = i;
    }
    slots[idx] += 1;
    used += 1;
  }
  while (used > width) {
    let idx = 0;
    for (let i = 1; i < slots.length; i += 1) {
      if (slots[i] > slots[idx]) idx = i;
    }
    if (slots[idx] === 0) break;
    slots[idx] -= 1;
    used -= 1;
  }

  return slots
    .map((count, idx) => symbols[idx % symbols.length].repeat(count))
    .join('');
}

function parseSharedLedgerTransferIntent(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  if (!/(共同[賬帳]本|共同[賬帳]號)/.test(text)) return null;
  if (!/(添加|加|匯|轉|給|入賬|入帳)/.test(text)) return null;
  const amountMatch = text.match(/(\d+(?:\.\d+)?)/);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount: Math.round(amount) };
}

function parsePersonalLedgerTransferIntent(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  if (/(共同[賬帐]本|共同[賬帐]號)/.test(text)) return null;
  if (!/(轉給|轉帳給|匯給|給)/.test(text)) return null;
  const amountMatch = text.match(/(\d+(?:\.\d+)?)/);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const targetMatch = text.match(/(?:轉給|轉帳給|匯給|給)\s*([^\d\s，,。!！?？]+)/);
  if (!targetMatch) return null;
  const targetRaw = String(targetMatch[1] || '').trim();
  const targetHint = normalizeTransferTargetName(targetRaw);
  if (!targetHint) return null;

  return {
    amount: Math.round(amount),
    targetHint,
  };
}

async function handleSharedLedgerTransfer(message, amount) {
  const guildId = message.guild?.id;
  if (!guildId) return false;
  const sharedChannelId = getGuildSharedLedgerChannelId(guildId);
  if (!sharedChannelId) {
    await message.reply('⚠️ 這個伺服器尚未設定共同賬本，請先使用 `/初始化-共同記賬`。');
    return true;
  }
  if (sharedChannelId === message.channel.id) {
    await message.reply('ℹ️ 目前頻道就是共同賬本，不需要再轉入。');
    return true;
  }

  const sharedSettings = getChannelSettings(sharedChannelId);
  if (!isChannelReadyForMessage(sharedSettings)) {
    await message.reply('⚠️ 共同賬本尚未完成初始化，請先在共同賬本頻道完成設定。');
    return true;
  }

  const sourceSettings = getChannelSettings(message.channel.id);
  const actorName = String(sourceSettings?.user_title || message.member?.displayName || message.author?.username || '使用者');
  const { run } = require('../db/database');
  const nowIso = new Date().toISOString();
  run(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    message.channel.id,
    message.author.id,
    amount,
    '轉帳',
    `轉入共同賬本`,
    'expense',
    nowIso,
  ]);
  run(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    sharedChannelId,
    message.author.id,
    amount,
    '共同轉入',
    `來自 ${actorName}`,
    'income',
    nowIso,
  ]);

  const sourceBalance = getChannelNetBalance(message.channel.id);
  const sharedBalance = getChannelNetBalance(sharedChannelId);
  void updateChannelBalanceName(message.channel);
  try {
    const sharedChannel = await message.guild.channels.fetch(sharedChannelId);
    if (sharedChannel) void updateChannelBalanceName(sharedChannel);
  } catch (error) {
    console.log('共同賬本頻道更新失敗:', error.message);
  }

  await sendEmbed(message, {
    title: '🏦 轉入共同賬本成功',
    fields: [
      { name: '金額', value: `NT$ ${amount.toLocaleString()}`, inline: true },
      { name: '來源頻道餘額', value: `NT$ ${sourceBalance.toLocaleString()}`, inline: true },
      { name: '共同賬本餘額', value: `NT$ ${sharedBalance.toLocaleString()}`, inline: true },
      { name: '共同賬本頻道', value: `<#${sharedChannelId}>`, inline: false },
    ],
  });

  try {
    const sharedChannel = await message.guild.channels.fetch(sharedChannelId);
    if (sharedChannel && typeof sharedChannel.send === 'function') {
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🏦 收到共同轉入')
        .addFields(
          { name: '來源', value: `${actorName}`, inline: false },
          { name: '金額', value: `+NT$ ${amount.toLocaleString()}`, inline: true },
          { name: '共同賬本餘額', value: `NT$ ${sharedBalance.toLocaleString()}`, inline: true }
        )
        .setTimestamp();
      await sharedChannel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.log('共同賬本發送轉入通知失敗:', error.message);
  }
  return true;
}

async function handlePersonalLedgerTransfer(message, transfer) {
  const { amount, targetHint } = transfer || {};
  if (!amount || !targetHint) return false;

  const guild = message.guild;
  if (!guild) return false;

  const sourceSettings = getChannelSettings(message.channel.id);
  const sourceLedgerName = buildLedgerDisplayName(sourceSettings, message.channel.name || '來源賬本');
  const actorName = String(sourceSettings?.user_title || message.member?.displayName || message.author?.username || '使用者');

  const matched = await findTargetPersonalLedgerChannels(guild, message.channel.id, targetHint);
  if (!matched.length) {
    await message.reply(`⚠️ 找不到「${targetHint}」對應的個人賬本，請確認對方已完成初始化且稱呼正確。`);
    return true;
  }
  if (matched.length > 1) {
    const options = matched.slice(0, 5).map((item) => item.ledgerName).join('、');
    await message.reply(`⚠️ 找到多個相符賬本（${options}），請改用更精準稱呼。`);
    return true;
  }

  const target = matched[0];
  if (target.channelId === message.channel.id) {
    await message.reply('ℹ️ 你指定的是目前這個賬本，不需要轉帳。');
    return true;
  }

  const { run } = require('../db/database');
  const nowIso = new Date().toISOString();
  run(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    message.channel.id,
    message.author.id,
    amount,
    '轉帳',
    `轉給 ${target.ledgerName}`,
    'expense',
    nowIso,
  ]);
  run(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    target.channelId,
    message.author.id,
    amount,
    '轉入',
    `來自 ${sourceLedgerName}（${actorName}）`,
    'income',
    nowIso,
  ]);

  const sourceBalance = getChannelNetBalance(message.channel.id);
  const targetBalance = getChannelNetBalance(target.channelId);
  void updateChannelBalanceName(message.channel);
  if (target.channel) {
    void updateChannelBalanceName(target.channel);
  }

  await sendEmbed(message, {
    title: '💸 轉帳成功',
    fields: [
      { name: '轉入目標', value: target.ledgerName, inline: false },
      { name: '金額', value: `NT$ ${amount.toLocaleString()}`, inline: true },
      { name: '來源賬本餘額', value: `NT$ ${sourceBalance.toLocaleString()}`, inline: true },
      { name: '目標賬本餘額', value: `NT$ ${targetBalance.toLocaleString()}`, inline: true },
    ],
  });

  if (target.channel && typeof target.channel.send === 'function') {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x38bdf8)
        .setTitle('💸 收到轉入')
        .addFields(
          { name: '來源', value: `${sourceLedgerName}（${actorName}）`, inline: false },
          { name: '金額', value: `+NT$ ${amount.toLocaleString()}`, inline: true },
          { name: '目前餘額', value: `NT$ ${targetBalance.toLocaleString()}`, inline: true }
        )
        .setTimestamp();
      await target.channel.send({ embeds: [embed] });
    } catch (error) {
      console.log('目標個人賬本發送轉入通知失敗:', error.message);
    }
  }

  return true;
}

async function findTargetPersonalLedgerChannels(guild, sourceChannelId, targetHint) {
  const { all } = require('../db/database');
  const rows = all(`
    SELECT channel_id, type, user_title, setup_completed_at
    FROM channel_settings
    WHERE setup_completed_at IS NOT NULL
      AND type = 'personal'
      AND user_title IS NOT NULL
      AND TRIM(user_title) <> ''
      AND channel_id <> ?
  `, [sourceChannelId]);

  const hintNorm = normalizeTransferTargetName(targetHint);
  const candidates = [];
  for (const row of rows) {
    const title = String(row.user_title || '').trim();
    const titleNorm = normalizeTransferTargetName(title);
    if (!titleNorm) continue;
    if (!(titleNorm === hintNorm || titleNorm.includes(hintNorm) || hintNorm.includes(titleNorm))) continue;
    try {
      const channel = await guild.channels.fetch(row.channel_id);
      if (!channel) continue;
      candidates.push({
        channelId: row.channel_id,
        ledgerName: `${title}的賬本`,
        title,
        channel,
      });
    } catch (error) {
      // 略過無法讀取的頻道
    }
  }
  return candidates;
}

function normalizeTransferTargetName(value) {
  return String(value || '')
    .trim()
    .replace(/^(給|轉給|轉帳給|匯給)/, '')
    .replace(/(的)?(個人)?[賬帐](本|戶|號)$/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function startTypingIndicator(channel) {
  if (!channel || typeof channel.sendTyping !== 'function') {
    return () => {};
  }

  let active = true;
  channel.sendTyping().catch(() => {});

  const interval = setInterval(() => {
    if (!active) return;
    channel.sendTyping().catch(() => {});
  }, 8000);

  return () => {
    active = false;
    clearInterval(interval);
  };
}

module.exports = { handleMessage };
