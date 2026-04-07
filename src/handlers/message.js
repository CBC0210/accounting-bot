const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  getChannelSettings,
  getGuildSharedLedgerChannelId,
  setChannelSetupState,
  setChannelBudget,
  setChannelReminderTime,
  setChannelReminderEnabled,
  setChannelCategoryBudgets,
  setChannelCategoryRules,
  setChannelGender,
  setChannelTitle,
  completeChannelSetup,
  getChannelMonthlyExpense,
  getChannelMonthlyExpenseByCategory,
  getChannelMonthlyNet,
  getChannelTodayExpense,
  getChannelNetBalance,
  getChannelRangeSummary,
  getChannelMetricTotal,
  getChannelCategoryBreakdown,
  getChannelDailyMetricSeries,
  getChannelTransactionsInRange,
  setTransactionExcludeFromBudget,
  getTransactionById,
} = require('../db/queries');
const {
  generateResponse,
  generateChatResponse,
  decideActionWithLLM,
  generateDataAnalysisResponse,
  parseTransactionFromImageWithLLM,
  planDataQueryWithLLM,
  planTransactionActionWithLLM,
} = require('../llm/generator');
const { transcribeAudioAttachment } = require('../services/voice-transcription');
const { restoreLatestStep } = require('../services/undo-step');
const { listBackups, restoreBackupByFilename, createBackup, getBackupConfig } = require('../services/db-backup');
const { sendEmbed } = require('../utils/embed');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { updateChannelBalanceName } = require('./channel');
const {
  parseCategoryRulesText,
  stringifyCategoryRules,
  matchUserCategoryRule,
  upsertCategoryRule,
  parseCategoryRuleTeachIntent,
  resolveCategoryAgainstAllowed,
} = require('../utils/category-rules');

// 分頁會話：由 handleComponentInteraction (slash.js) 統一處理
const paginationSessions = new Map();
const PAGINATION_SESSION_TTL = 30 * 60 * 1000; // 30 分鐘

function buildPageRow(sessionId, index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${sessionId}:prev`)
      .setLabel('上一頁')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index <= 0),
    new ButtonBuilder()
      .setCustomId(`${sessionId}:next`)
      .setLabel('下一頁')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index >= total - 1),
  );
}

const DEFAULT_ALLOWED_CATEGORIES = [
  '餐飲', '交通', '購物', '娛樂', '房租/帳單', '住宿', '日常生活', '醫療', '教育', '投資', '禮物', '其他',
  '薪資', '兼職', '被動收入', '紅包', '生活費',
];
const DEFAULT_INCOME_CATEGORY_SET = new Set(['薪資', '兼職', '被動收入', '紅包', '生活費', '收入']);

const channelMessageQueues = new Map();
const pendingTransactionActions = new Map();
const pendingMealPeriodActions = new Map();
const pendingBackupRestoreActions = new Map();
const pendingClarificationContexts = new Map();
const recentQueryContexts = new Map();
const recentDialogueCache = new Map();
const dialogueWriteQueues = new Map();
const DIALOGUE_HISTORY_DIR = path.resolve(process.cwd(), 'data', 'dialogue-history');
const DIALOGUE_CACHE_LIMIT = 80;
const CLARIFICATION_TTL_MS = 5 * 60 * 1000;
let ensureDialogueDirPromise = null;

async function handleMessage(message) {
  const channelId = message?.channel?.id;
  if (!channelId) return;
  const text = String(message?.content || '').trim();
  const audioAttachment = !text ? getFirstAudioAttachment(message) : null;
  if (audioAttachment) {
    void handleVoiceMessage(message, audioAttachment);
    return;
  }

  const previousTask = channelMessageQueues.get(channelId) || Promise.resolve();
  const nextTask = previousTask
    .catch(() => {})
    .then(() => handleMessageCore(message, {}));

  channelMessageQueues.set(channelId, nextTask);
  try {
    await nextTask;
  } catch (error) {
    console.error('handleMessage queue task failed:', error);
    try {
      await message.reply('⚠️ 剛剛處理訊息時發生錯誤，請再試一次。');
    } catch (_) {
      // 忽略回覆失敗，避免中斷後續訊息佇列
    }
  } finally {
    if (channelMessageQueues.get(channelId) === nextTask) {
      channelMessageQueues.delete(channelId);
    }
  }
}

async function handleVoiceMessage(message, audioAttachment) {
  const channelSettings = getChannelSettings(message?.channel?.id);
  if (!isChannelReadyForMessage(channelSettings)) return;
  patchOutgoingTrackers(message);
  const stopTyping = startTypingIndicator(message.channel);
  try {
    const transcriptRaw = await transcribeAudioAttachment({
      url: audioAttachment.url,
      name: audioAttachment.name,
    });
    if (!transcriptRaw) {
      await message.reply('⚠️ 語音辨識失敗，請改用文字或重新上傳語音。');
      return;
    }
    const transcript = normalizeVoiceTranscriptLight(String(transcriptRaw || '').trim());
    console.log('[VOICE TRANSCRIPT]', JSON.stringify({
      channelId: message.channel.id,
      messageId: message.id,
      raw: String(transcriptRaw || '').slice(0, 120),
      normalized: transcript.slice(0, 120),
    }));

    const previousTask = channelMessageQueues.get(message.channel.id) || Promise.resolve();
    const nextTask = previousTask
      .catch(() => {})
      .then(() => handleMessageCore(message, {
        forcedContent: transcript,
        skipVoiceTranscribe: true,
      }));
    channelMessageQueues.set(message.channel.id, nextTask);
    try {
      await nextTask;
    } catch (error) {
      console.error('voice queue task failed:', error);
      await message.reply('⚠️ 語音訊息處理失敗，請再試一次。');
    } finally {
      if (channelMessageQueues.get(message.channel.id) === nextTask) {
        channelMessageQueues.delete(message.channel.id);
      }
    }
  } catch (error) {
    console.error('voice transcription failed:', error);
    const raw = String(error?.message || '未知錯誤');
    const firstLine = raw.split(/\r?\n/)[0].trim();
    if (firstLine.includes('voice_transcription_failed')) {
      await message.reply('⚠️ 語音辨識失敗：雲端轉寫失敗，已記錄錯誤日誌。請稍後重試或改用文字。');
      return;
    }
    await message.reply(`⚠️ 語音辨識失敗：${firstLine || '未知錯誤'}`);
  } finally {
    stopTyping();
  }
}

function normalizeVoiceTranscriptLight(text) {
  let value = String(text || '').trim();
  if (!value) return '';
  const replacements = [
    [/工車|公車車|供車|宮車/gi, '公車'],
    [/買當勞|賣當勞|麥當樓|賣當樓/gi, '麥當勞'],
    [/收搖飲|手要飲|手謠飲|手遙飲/gi, '手搖飲'],
    [/再稅五分鐘|在稅五分鐘|在睡五分鐘/gi, '再睡五分鐘'],
  ];
  for (const [pattern, target] of replacements) {
    value = value.replace(pattern, target);
  }
  value = value
    .replace(/[，,。；;：:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 只做輕量口語去除，盡量保留品牌與關鍵詞
  value = value
    .replace(/^(?:我|我在|我剛|我剛剛|今天|剛剛|就是|然後|想說|幫我|請|我去)\s*/i, '')
    .replace(/\s*(?:花了|花費了|消費了)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value;
}

async function handleMessageCore(message, options = {}) {
  console.log(`收到訊息: ${message.content} from ${message.author.username}`);

  let stopTyping = () => {};
  try {
    let content = typeof options.forcedContent === 'string'
      ? String(options.forcedContent || '').trim()
      : String(message.content || '').trim();
    const skipVoiceTranscribe = Boolean(options.skipVoiceTranscribe);
    const channelSettings = getChannelSettings(message.channel.id);
    if (!isChannelReadyForMessage(channelSettings)) {
      // 未初始化頻道保持靜默，不主動回覆任何訊息
      return;
    }
    patchOutgoingTrackers(message);
    const undoIntent = parseUndoIntent(content);
    if (undoIntent) {
      const maxSteps = Math.max(1, Math.min(5, Number(undoIntent.steps || 1)));
      const lines = [];
      let success = 0;
      for (let i = 0; i < maxSteps; i += 1) {
        const result = restoreLatestStep(message.channel.id);
        if (!result.ok) {
          if (i === 0) {
            await message.reply(`⚠️ ${result.message}`);
            return;
          }
          break;
        }
        success += 1;
        lines.push(`- ${result.message}`);
      }
      await message.reply(`↩️ 已還原 ${success} 步：\n${lines.join('\n')}`);
      return;
    }

    const backupHandled = await handleBackupDialogIntent(message, content);
    if (backupHandled) return;
    if (!content && !skipVoiceTranscribe) {
      const audioAttachment = getFirstAudioAttachment(message);
      if (audioAttachment) {
        const transcript = await transcribeAudioAttachment({
          url: audioAttachment.url,
          name: audioAttachment.name,
        });
        if (transcript) {
          content = transcript;
          console.log('[VOICE TRANSCRIPT]', JSON.stringify({
            channelId: message.channel.id,
            messageId: message.id,
            text: transcript.slice(0, 180),
          }));
        } else {
          await message.reply('⚠️ 語音辨識失敗，請改用文字或重新上傳語音。');
          return;
        }
      }
    }
    if (!content) return;
    const inferredOccurredAtIso = inferTransactionOccurredAt(content, message.createdAt || new Date());
    void appendDialogueTurn(message.channel.id, {
      role: 'user',
      content,
      speakerId: message.author.id,
      messageId: message.id,
      timestamp: message.createdAt ? new Date(message.createdAt).toISOString() : new Date().toISOString(),
    });
    stopTyping = startTypingIndicator(message.channel);
    const allowedCategories = parseConfiguredCategories(channelSettings?.categories_text);
    const userCategoryRules = parseCategoryRulesText(channelSettings?.category_rules_text);
    const styleTags = parseStyleTags(channelSettings?.chat_style_tags_text);
    const setupState = channelSettings?.setup_state || null;
    const setupUserId = channelSettings?.setup_user_id || null;
    const isSetupMode = Boolean(setupState);
    const isSharedLedger = String(channelSettings?.type || 'personal') === 'shared';
    const categoryBudgetIntent = !isSetupMode ? parseCategoryBudgetIntent(content) : null;
    if (categoryBudgetIntent) {
      const handled = await handleCategoryBudgetIntent(message, categoryBudgetIntent, channelSettings, allowedCategories);
      if (handled) return;
    }
    const reminderToggleIntent = !isSetupMode ? parseReminderToggleIntent(content) : null;
    if (reminderToggleIntent) {
      const handled = await handleReminderToggleIntent(message, reminderToggleIntent, channelSettings);
      if (handled) return;
    }

    const categoryRuleTeachQuick = !isSetupMode ? parseCategoryRuleTeachIntent(content) : null;
    if (categoryRuleTeachQuick) {
      await handleCategoryRuleTeach(message, categoryRuleTeachQuick, allowedCategories);
      return;
    }

    const mealSettingHandled = !isSetupMode
      ? await handleMealPeriodSettingConversation(message, content, channelSettings)
      : false;
    if (mealSettingHandled) return;

    // 共同帳本不需要性別/稱呼：若還停在舊流程狀態，直接完成初始化
    if (isSetupMode && isSharedLedger && ['await_gender', 'await_title', 'await_split_books'].includes(setupState)) {
      completeChannelSetup(message.channel.id);
      void updateChannelBalanceName(message.channel);
      const current = getChannelSettings(message.channel.id);
      await message.reply(
        `✅ 已自動完成共同帳本初始化（共同帳本不需性別與稱呼）。\n` +
        `- 每月預算：NT$ ${(current?.budget || 0).toLocaleString()}\n` +
        `- 每日提醒：${current?.reminder_time || '未設定'}`
      );
      return;
    }

    const sharedPayout = !isSetupMode ? parseSharedLedgerPayoutIntent(content) : null;
    if (sharedPayout) {
      const handled = await handleSharedLedgerPayout(message, sharedPayout);
      if (handled) return;
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
    const pendingActionHandled = !isSetupMode
      ? await handlePendingTransactionActionSelection(message, content)
      : false;
    if (pendingActionHandled) return;

    const managementIntent = !isSetupMode ? await parseTransactionManagementIntent(message, content, allowedCategories) : null;
    if (managementIntent) {
      const managed = await handleTransactionManagementIntent(message, managementIntent);
      if (managed) return;
    }

    const routingHistory = await fetchRecentDialogueForLLM(message, 10);

    // 清理過期的追問上下文
    const channelId = message.channel.id;
    const pendingClarification = pendingClarificationContexts.get(channelId);
    if (pendingClarification && Date.now() > pendingClarification.expiresAt) {
      pendingClarificationContexts.delete(channelId);
    }
    const activeClarification = pendingClarificationContexts.get(channelId) || null;

    const llmDecision = await decideActionWithLLM(content, {
      isSetupMode,
      setupState,
      allowedCategories,
      history: routingHistory,
      pendingClarification: activeClarification?.partialDecision || null,
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

    if (llmDecision?.action === 'set_category_rule') {
      pendingClarificationContexts.delete(channelId);
      const kw = llmDecision.ruleKeyword || llmDecision.note;
      const cat = llmDecision.ruleCategory || llmDecision.category;
      if (kw && cat) {
        await handleCategoryRuleTeach(message, { keyword: kw, category: cat }, allowedCategories);
      } else if (llmDecision.needsClarification && llmDecision.followUpQuestion) {
        pendingClarificationContexts.set(channelId, {
          partialDecision: llmDecision,
          expiresAt: Date.now() + CLARIFICATION_TTL_MS,
        });
        await message.reply(llmDecision.followUpQuestion);
      } else {
        await message.reply('⚠️ 請說明要記住的關鍵字與分類，例如：以後「星巴克」視為「餐飲」類別。');
      }
      return;
    }

    // 初始化完成後，允許透過自然語句修改常用設定（以 embed 回覆）
    if (llmDecision?.action && ['set_budget', 'set_reminder_time', 'set_gender', 'set_title'].includes(llmDecision.action)) {
      pendingClarificationContexts.delete(channelId);
      const handled = await handleSettingUpdateByConversation(message, llmDecision, content);
      if (handled) return;
    }

    // LLM 判斷為共同帳本轉入
    if (llmDecision?.action === 'shared_ledger_transfer') {
      const amount = Number(llmDecision.amount || 0);
      if (amount > 0) {
        pendingClarificationContexts.delete(channelId);
        await handleSharedLedgerTransfer(message, amount);
        return;
      }
      pendingClarificationContexts.set(channelId, {
        partialDecision: llmDecision,
        expiresAt: Date.now() + CLARIFICATION_TTL_MS,
      });
      await message.reply('請問要轉入共同帳本多少金額？');
      return;
    }

    // LLM 判斷為共同帳本轉出/提領
    if (llmDecision?.action === 'shared_ledger_payout') {
      const amount = Number(llmDecision.amount || 0);
      if (amount > 0) {
        pendingClarificationContexts.delete(channelId);
        await handleSharedLedgerPayout(message, { amount, targetHint: null, raw: content });
        return;
      }
      pendingClarificationContexts.set(channelId, {
        partialDecision: llmDecision,
        expiresAt: Date.now() + CLARIFICATION_TTL_MS,
      });
      await message.reply('請問要從共同帳本提領多少金額？');
      return;
    }

    if (llmDecision?.action === 'record_transaction') {
      pendingClarificationContexts.delete(channelId);
      const transactions = resolveRecordTransactions(llmDecision, content, allowedCategories, inferredOccurredAtIso, userCategoryRules);
      if (transactions.length > 1) {
        await processTransactionsBatch(message, transactions, styleTags);
        return;
      }
      if (transactions.length === 1) {
        await processTransaction(message, transactions[0], styleTags);
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
          content,
          inferredOccurredAtIso,
          userCategoryRules
        );
        if (merged) {
          pendingClarificationContexts.delete(channelId);
          await processTransaction(message, merged, styleTags);
          return;
        }
      }
    }

    const shouldForceQuery = shouldForceQueryAnalysisFallback(content, llmDecision);
    if (llmDecision?.action === 'query_analysis' || shouldForceQuery) {
      pendingClarificationContexts.delete(channelId);
      console.log('[QUERY ROUTE]', JSON.stringify({
        content,
        action: llmDecision?.action || null,
        forced: shouldForceQuery,
      }));
      const handled = await handleQueryAnalysis(message, content, llmDecision);
      if (handled) return;
    }

    // LLM 低信心時，優先追問並儲存追問上下文，不直接硬判
    if (llmDecision?.needsClarification && llmDecision.followUpQuestion) {
      pendingClarificationContexts.set(channelId, {
        partialDecision: llmDecision,
        expiresAt: Date.now() + CLARIFICATION_TTL_MS,
      });
      await message.reply(llmDecision.followUpQuestion);
      return;
    }
    pendingClarificationContexts.delete(channelId);

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
  const history = await fetchRecentDialogueForLLM(message, 10);
  // 用 LLM 回應
  const response = await generateChatResponse(content, { styleTags, history });
  await message.reply(response);
}

async function handleMealPeriodSettingConversation(message, content, channelSettings) {
  const key = `${message.channel.id}:${message.author.id}`;
  const text = String(content || '').trim();
  if (!text) return false;

  let pending = pendingMealPeriodActions.get(key) || null;
  if (pending && Date.now() > Number(pending.expiresAt || 0)) {
    pendingMealPeriodActions.delete(key);
    pending = null;
  }
  const parsed = parseMealPeriodSettingIntent(text);
  const hasSettingCue = /(餐期|時段|早餐|午餐|晚餐|宵夜).*(設定|修改|更改|調整|改成|改為)|(?:設定|修改|更改|調整).*(餐期|時段|早餐|午餐|晚餐|宵夜)/.test(text);

  if (!pending && !parsed.range && !hasSettingCue) {
    return false;
  }

  const current = parseConfiguredMealPeriods(channelSettings?.meal_periods_text);
  const targetPeriod = parsed.period || pending?.period || null;
  const range = parsed.range || null;

  if (!targetPeriod && !range) {
    pendingMealPeriodActions.set(key, {
      period: null,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    await sendEmbed(message, {
      title: '🍽️ 餐期設定',
      fields: [
        { name: '目前時段', value: formatMealPeriodsForDisplay(current), inline: false },
        { name: '請提供修改內容', value: '可說：`午餐時段改成 11:00-15:59`', inline: false },
      ],
    });
    return true;
  }

  if (targetPeriod && !range) {
    pendingMealPeriodActions.set(key, {
      period: targetPeriod,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    await sendEmbed(message, {
      title: '🍽️ 請提供新時段',
      fields: [
        { name: '目標餐期', value: mealPeriodLabel(targetPeriod), inline: true },
        { name: '目前設定', value: `${current[targetPeriod].start}-${current[targetPeriod].end}`, inline: true },
        { name: '格式', value: '請回覆 `HH:mm-HH:mm`（例如：11:00-15:59）', inline: false },
      ],
    });
    return true;
  }

  if (!targetPeriod || !range) {
    await sendEmbed(message, {
      title: '⚠️ 餐期設定未完成',
      fields: [
        { name: '說明', value: '請指定餐期與時間，例如：`晚餐時段改成 16:00-21:59`', inline: false },
      ],
    });
    return true;
  }

  const next = { ...current, [targetPeriod]: range };
  const { run } = require('../db/database');
  run(`
    UPDATE channel_settings
    SET meal_periods_text = ?, updated_at = ?
    WHERE channel_id = ?
  `, [JSON.stringify(next), new Date().toISOString(), message.channel.id]);
  pendingMealPeriodActions.delete(key);

  await sendEmbed(message, {
    title: '✅ 餐期設定已更新',
    fields: [
      { name: '餐期', value: mealPeriodLabel(targetPeriod), inline: true },
      { name: '變更', value: `${current[targetPeriod].start}-${current[targetPeriod].end} -> ${range.start}-${range.end}`, inline: false },
      { name: '目前完整設定', value: formatMealPeriodsForDisplay(next), inline: false },
    ],
  });
  return true;
}

async function handleSettingUpdateByConversation(message, decision, content) {
  const action = String(decision?.action || '');
  if (!action) return false;
  const before = getChannelSettings(message.channel.id) || {};
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${message.channel.id}`;

  if (action === 'set_budget') {
    const amount = extractBudgetFromDecision(decision);
    if (amount === null) {
      if (decision?.needsClarification && decision?.followUpQuestion) {
        await message.reply(decision.followUpQuestion);
      } else {
        await sendEmbed(message, {
          title: '⚙️ 設定未完成',
          fields: [
            { name: '項目', value: '每月預算', inline: true },
            { name: '說明', value: '請提供有效金額（例如：預算改成 42000）', inline: false },
          ],
        });
      }
      return true;
    }
    setChannelBudget(message.channel.id, amount);
    const after = getChannelSettings(message.channel.id) || {};
    await sendEmbed(message, {
      title: '✅ 設定已更新',
      fields: [
        { name: '項目', value: '每月預算', inline: true },
        { name: '變更', value: `NT$ ${Number(before.budget || 0).toLocaleString()} -> NT$ ${Number(after.budget || 0).toLocaleString()}`, inline: false },
        { name: 'Dashboard', value: `[查看設定](${dashboardUrl})`, inline: false },
      ],
    });
    return true;
  }

  if (action === 'set_reminder_time') {
    const reminderTime = extractReminderTimeFromDecision(decision);
    if (!reminderTime) {
      if (decision?.needsClarification && decision?.followUpQuestion) {
        await message.reply(decision.followUpQuestion);
      } else {
        await sendEmbed(message, {
          title: '⚙️ 設定未完成',
          fields: [
            { name: '項目', value: '每日提醒時間', inline: true },
            { name: '說明', value: '請使用 HH:mm（例如：提醒時間改成 21:30）', inline: false },
          ],
        });
      }
      return true;
    }
    setChannelReminderTime(message.channel.id, reminderTime);
    const after = getChannelSettings(message.channel.id) || {};
    await sendEmbed(message, {
      title: '✅ 設定已更新',
      fields: [
        { name: '項目', value: '每日提醒時間', inline: true },
        { name: '變更', value: `${before.reminder_time || '未設定'} -> ${after.reminder_time || '未設定'}`, inline: false },
        { name: 'Dashboard', value: `[查看設定](${dashboardUrl})`, inline: false },
      ],
    });
    return true;
  }

  if (action === 'set_gender') {
    const gender = extractGenderFromDecision(decision);
    if (!gender) {
      if (decision?.needsClarification && decision?.followUpQuestion) {
        await message.reply(decision.followUpQuestion);
      } else {
        await sendEmbed(message, {
          title: '⚙️ 設定未完成',
          fields: [
            { name: '項目', value: '性別', inline: true },
            { name: '說明', value: '請回覆 男 / 女 / 其他', inline: false },
          ],
        });
      }
      return true;
    }
    setChannelGender(message.channel.id, gender);
    const after = getChannelSettings(message.channel.id) || {};
    await sendEmbed(message, {
      title: '✅ 設定已更新',
      fields: [
        { name: '項目', value: '性別', inline: true },
        { name: '變更', value: `${formatGender(before.user_gender)} -> ${formatGender(after.user_gender)}`, inline: false },
        { name: 'Dashboard', value: `[查看設定](${dashboardUrl})`, inline: false },
      ],
    });
    return true;
  }

  if (action === 'set_title') {
    const title = extractTitleFromDecision(decision);
    if (!title) {
      if (decision?.needsClarification && decision?.followUpQuestion) {
        await message.reply(decision.followUpQuestion);
      } else {
        await sendEmbed(message, {
          title: '⚙️ 設定未完成',
          fields: [
            { name: '項目', value: '稱呼', inline: true },
            { name: '說明', value: '請提供想使用的稱呼（例如：稱呼改成 小柏）', inline: false },
          ],
        });
      }
      return true;
    }
    setChannelTitle(message.channel.id, title);
    const after = getChannelSettings(message.channel.id) || {};
    await sendEmbed(message, {
      title: '✅ 設定已更新',
      fields: [
        { name: '項目', value: '稱呼', inline: true },
        { name: '變更', value: `${before.user_title || '未設定'} -> ${after.user_title || '未設定'}`, inline: false },
        { name: 'Dashboard', value: `[查看設定](${dashboardUrl})`, inline: false },
      ],
    });
    void updateChannelBalanceName(message.channel);
    return true;
  }

  return false;
}

async function processTransaction(message, transaction, styleTags = [], options = {}) {
  const {
    skipBudgetUsageMessage = false,
    skipSuccessEmbed = false,
    skipFeedback = false,
  } = options;
  const { amount, category, note, type, itemName, timestamp } = transaction;
  
  // 儲存到資料庫
  const { run, get } = require('../db/database');
  const txTimestamp = timestamp || new Date().toISOString();
  run(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [message.channel.id, message.author.id, amount, category, note, type, txTimestamp]);
  const insertedRow = get(`
    SELECT id
    FROM transactions
    WHERE channel_id = ?
      AND user_id = ?
      AND amount = ?
      AND category = ?
      AND note = ?
      AND type = ?
      AND timestamp = ?
    ORDER BY id DESC
    LIMIT 1
  `, [message.channel.id, message.author.id, amount, category, note, type, txTimestamp]);
  const transactionId = Number(insertedRow?.id || 0);
  
  // 取得當月結餘
  const balance = getChannelMonthlyNet(message.channel.id);
  const settings = getChannelSettings(message.channel.id);
  const budget = getEffectiveMonthlyBudget(settings);
  const monthlySpent = getChannelMonthlyExpense(message.channel.id);
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${message.channel.id}`;
  // 頻道改名可能觸發 Discord rate limit，改為背景更新避免阻塞回覆
  void updateChannelBalanceName(message.channel);

  // 1) 本月預算使用量
  if (!skipBudgetUsageMessage) {
    await sendMonthlyBudgetUsageMessage(message, { transaction });
  }

  // 2) 發送記帳成功訊息
  if (!skipSuccessEmbed) {
    const recordTimeText = formatDateTimeForDisplay(txTimestamp);
    const excludeRow = transactionId > 0
      ? getTransactionById(message.channel.id, transactionId)
      : null;
    const isFlagSet = excludeRow?.exclude_from_budget === 1;
    const isIncome = type === 'income';
    const excludeButton = transactionId > 0
      ? new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`exclude_budget:${transactionId}:${message.channel.id}`)
            .setLabel(isIncome
              ? (isFlagSet ? '已計入預算 ✓' : '計入預算')
              : (isFlagSet ? '已排除預算 ✓' : '不計入預算'))
            .setStyle(isFlagSet ? ButtonStyle.Secondary : ButtonStyle.Primary)
            .setEmoji(isIncome ? '💰' : '🚫'),
        )
      : null;
    await sendEmbed(message, {
      title: '✅ 記帳成功',
      fields: [
        { name: 'ID', value: transactionId > 0 ? String(transactionId) : '-', inline: true },
        { name: '項目', value: itemName || category || '未分類', inline: true },
        { name: '金額', value: `${type === 'income' ? '+' : '-'}${amount}`, inline: true },
        { name: '分類', value: category, inline: true },
        { name: '時間', value: recordTimeText, inline: true },
        { name: '當月結餘', value: balance.toString(), inline: false },
        { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false },
      ],
      ...(excludeButton ? { components: [excludeButton] } : {}),
    });
  }

  // 3) 發送閒聊回饋
  if (!skipFeedback) {
    const feedback = await generateResponse(transaction, balance, { budget, monthlySpent, styleTags });
    await message.channel.send(feedback);
  }
  return { id: transactionId };
}

async function processTransactionsBatch(message, transactions, styleTags = []) {
  const safeList = Array.isArray(transactions) ? transactions.filter(Boolean) : [];
  if (!safeList.length) return;

  const inserted = [];
  for (const tx of safeList) {
    const result = await processTransaction(message, tx, styleTags, {
      skipBudgetUsageMessage: true,
      skipSuccessEmbed: true,
      skipFeedback: true,
    });
    inserted.push({ tx, id: Number(result?.id || 0) });
  }

  const balance = getChannelMonthlyNet(message.channel.id);
  const settings = getChannelSettings(message.channel.id);
  const budget = getEffectiveMonthlyBudget(settings);
  const monthlySpent = getChannelMonthlyExpense(message.channel.id);
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${message.channel.id}`;

  await sendMonthlyBudgetUsageMessage(message);

  const lines = inserted
    .slice(0, 8)
    .map(({ tx, id }, idx) => `${idx + 1}. [ID ${id > 0 ? id : '-'}] ${tx.itemName || tx.note || tx.category || '未分類'} ${tx.type === 'income' ? '+' : '-'}${tx.amount}`)
    .join('\n');
  const moreCount = safeList.length - 8;

  await sendEmbed(message, {
    title: `✅ 記帳成功（共 ${safeList.length} 筆）`,
    fields: [
      { name: '明細', value: moreCount > 0 ? `${lines}\n... 其餘 ${moreCount} 筆` : lines, inline: false },
      { name: '當月結餘', value: balance.toString(), inline: true },
      { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: true },
    ],
  });

  const summaryTx = {
    amount: safeList.reduce((sum, tx) => sum + (tx.type === 'income' ? Number(tx.amount || 0) : -Number(tx.amount || 0)), 0),
    type: 'expense',
    category: '批次記帳',
    note: `一次記錄 ${safeList.length} 筆`,
    itemName: '批次記帳',
  };
  const feedback = await generateResponse(summaryTx, balance, { budget, monthlySpent, styleTags });
  await message.channel.send(feedback);
}

async function handleQueryAnalysis(message, content, decision) {
  const channelSettings = getChannelSettings(message.channel.id);
  const mealPeriods = parseConfiguredMealPeriods(channelSettings?.meal_periods_text);
  const allowedCategories = parseConfiguredCategories(channelSettings?.categories_text);
  const forcedPlan = decision && decision.__forceSingleRange ? decision : null;
  const analysisRequested = isAnalysisIntentQuery(content);
  // 查詢區間優先交給 LLM 規劃；失敗再 fallback
  const llmPlan = forcedPlan ? null : await planDataQueryWithLLM(content);
  const fallbackPlan = resolveAnalysisPlan(content, decision);
  const plan = forcedPlan || llmPlan || fallbackPlan;
  if (!plan) {
    console.log('[QUERY PLAN MISS]', JSON.stringify({
      content,
      action: decision?.action || null,
      analysisRequested,
      hasLlmPlan: Boolean(llmPlan),
      hasFallbackPlan: Boolean(fallbackPlan),
      forcedPlan: Boolean(forcedPlan),
    }));
    return false;
  }

  const compareRequested = isCompareIntentQuery(content);
  const explicitDateRange = parseExplicitDateRangeFromText(content);
  const analysisType = plan.analysisType || 'compare_ranges';
  const metricFromPlan = normalizeMetric(plan.metric);
  let metric = metricFromPlan || null;
  let rawCategory = typeof plan.category === 'string' && plan.category.trim() ? plan.category.trim() : null;
  let mealPeriod = inferMealPeriodFromQuery(content, message.createdAt || new Date(), mealPeriods);
  const inheritedContext = getRecentQueryContext(message);
  const inheritState = shouldInheritLastQueryContext(content, {
    explicitDateRange: Boolean(explicitDateRange),
    rawCategory,
    mealPeriod,
    compareRequested,
    fromDifferentSpeaker: Boolean(inheritedContext && inheritedContext.speakerId && inheritedContext.speakerId !== message.author.id),
  });
  let inheritedRangeSpec = null;
  if (inheritState.inherit && inheritedContext) {
    if (!rawCategory && inheritedContext.category) rawCategory = inheritedContext.category;
    if (!mealPeriod && inheritedContext.mealPeriod) mealPeriod = inheritedContext.mealPeriod;
    if (!metric && inheritedContext.metric) metric = inheritedContext.metric;
    const planRange = resolveRangeSpec(plan.targetRange, content);
    if (!explicitDateRange && !planRange && inheritedContext.targetRangeSpec) {
      inheritedRangeSpec = inheritedContext.targetRangeSpec;
    }
    console.log('[QUERY CONTEXT INHERIT]', JSON.stringify({
      channelId: message.channel.id,
      currentUserId: message.author.id,
      previousSpeakerId: inheritedContext.speakerId || null,
      mode: inheritState.mode,
      inheritedCategory: !rawCategory && Boolean(inheritedContext.category),
      inheritedMeal: !mealPeriod && Boolean(inheritedContext.mealPeriod),
      inheritedMetric: !metricFromPlan && Boolean(inheritedContext.metric),
      inheritedRange: Boolean(inheritedRangeSpec),
    }));
  }
  metric = metric || 'expense';
  const normalizedCategory = shouldIgnoreMealWordAsCategory(rawCategory, mealPeriod)
    ? null
    : normalizeQueryCategory(rawCategory, content, allowedCategories);
  // 問「早餐/午餐/晚餐/宵夜」時，直接視為餐飲類別查詢
  const category = mealPeriod ? '餐飲' : normalizedCategory;
  const showMealPeriodsInEmbed = Boolean(mealPeriod && category === '餐飲');
  const mealLabel = mealPeriod ? mealPeriodLabel(mealPeriod) : '';
  const singlePreset = inferSinglePeriodPreset(content);
  const effectiveAnalysisType = shouldUseSingleRangeCard(content, analysisType, singlePreset)
    ? 'single_range'
    : analysisType;
  console.log('[QUERY PLAN]', JSON.stringify({
    content,
    analysisRequested,
    compareRequested,
    analysisType,
    effectiveAnalysisType,
    metric,
    category,
    singlePreset,
    hasLlmPlan: Boolean(llmPlan),
    hasFallbackPlan: Boolean(fallbackPlan),
    forcedPlan: Boolean(forcedPlan),
  }));

  if (effectiveAnalysisType === 'single_range') {
    const targetRange = resolveRangeSpec(plan.targetRange, content)
      || (inheritedRangeSpec ? resolveRangeSpec(inheritedRangeSpec, '') : null)
      || (singlePreset ? getRangeFromPreset(singlePreset) : null);
    if (!targetRange) return false;

    const mealTxs = mealPeriod
      ? getMealFilteredTransactions(message.channel.id, targetRange.startIso, targetRange.endIso, mealPeriod, mealPeriods)
      : null;
    const summary = mealTxs
      ? buildSummaryFromTransactions(mealTxs)
      : getChannelRangeSummary(message.channel.id, targetRange.startIso, targetRange.endIso);
    const metricValue = mealTxs
      ? getMetricTotalFromTransactions(mealTxs, metric, category)
      : getChannelMetricTotal(
        message.channel.id,
        targetRange.startIso,
        targetRange.endIso,
        metric,
        category
      );
    const rows = category
      ? []
      : (mealTxs
        ? getCategoryBreakdownFromTransactions(mealTxs, metric)
        : getChannelCategoryBreakdown(message.channel.id, targetRange.startIso, targetRange.endIso, metric))
        .slice(0, 4);
    const rowsTotal = rows.reduce((sum, row) => sum + Math.abs(Number(row.total || 0)), 0);
    const metricLabel = metricToLabel(metric);

    const analysisText = analysisRequested
      ? await generateDataAnalysisResponse({
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
      })
      : null;

    const color = metric === 'income' ? 0x2ecc71 : metric === 'net' ? 0x3498db : metric === 'count' ? 0x7f8c8d : 0xe67e22;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`📊 ${targetRange.label}${mealLabel ? ` · ${mealLabel}` : ''} ${metricLabel}摘要`)
      .addFields(
        { name: '區間結餘', value: formatMetric('net', summary.net), inline: true },
        { name: '區收', value: formatMetric('income', summary.income), inline: true },
        { name: '區支', value: formatMetric('expense', summary.expense), inline: true },
        { name: `${metricLabel}${category ? `（${category}）` : ''}`, value: formatMetric(metric, metricValue), inline: false }
      )
      .setTimestamp();
    if (showMealPeriodsInEmbed) {
      embed.addFields({
        name: '🍽️ 餐期設定',
        value: formatMealPeriodsForDisplay(mealPeriods),
        inline: false,
      });
    }

    if (rows.length > 0) {
      const categoryLines = rows.map((row, idx) => {
        const part = rowsTotal > 0 ? Math.round((Math.abs(Number(row.total || 0)) / rowsTotal) * 100) : 0;
        const marker = getCategoryShareMarker(idx);
        return `${marker} ${row.category} ${part}%`;
      });
      const bar = buildCategoryShareBar(rows, 20);
      embed.addFields({
        name: '區間分類分析',
        value: `${bar}\n${categoryLines.join('\n')}`,
        inline: false,
      });
    }
    const rawTxs = mealTxs || getChannelTransactionsInRange(message.channel.id, targetRange.startIso, targetRange.endIso);
    const detailTxs = filterTransactionsForMetric(rawTxs, metric, category);
    const detailEmbeds = buildRangeEntriesEmbeds(
      `${targetRange.label}${mealLabel ? ` · ${mealLabel}` : ''}`,
      detailTxs,
      metricLabel,
      category
    );
    console.log('[QUERY SEND] single_range summary', JSON.stringify({
      channelId: message.channel.id,
      metric,
      category,
      range: targetRange.label,
      detailCount: detailTxs.length,
    }));
    await message.reply({
      content: analysisText || undefined,
      embeds: [embed],
    });
    await sendPagedDetailEmbeds(message.channel, message.author.id, detailEmbeds);
    setRecentQueryContext(message, {
      metric,
      category,
      mealPeriod,
      targetRangeSpec: {
        startDate: targetRange.startIso,
        endDate: targetRange.endIso,
        label: targetRange.label,
      },
    });
    console.log('[QUERY SENT] single_range done');
    return true;
  }

  if (effectiveAnalysisType === 'category_breakdown') {
    if (!analysisRequested) {
      // 未明確要求分析時，優先退回單區間查詢卡，避免一般查詢被回覆成「分析文」
      const targetRange = resolveRangeSpec(plan.targetRange, content)
        || (inheritedRangeSpec ? resolveRangeSpec(inheritedRangeSpec, '') : null)
        || (singlePreset ? getRangeFromPreset(singlePreset) : null)
        || resolveRangeSpec({ preset: 'today' }, content);
      if (targetRange) {
        const fallbackPlanForSingle = {
          __forceSingleRange: true,
          analysisType: 'single_range',
          metric,
          targetRange: { preset: normalizePeriod(plan?.targetRange?.preset) || (singlePreset || 'today') },
          category,
        };
        return handleQueryAnalysis(message, content, fallbackPlanForSingle);
      }
    }
    const targetRange = resolveRangeSpec(plan.targetRange, content)
      || (inheritedRangeSpec ? resolveRangeSpec(inheritedRangeSpec, '') : null)
      || resolveRangeSpec({ preset: 'this_month' }, content);
    if (!targetRange) return false;
    const mealTxs = mealPeriod
      ? getMealFilteredTransactions(message.channel.id, targetRange.startIso, targetRange.endIso, mealPeriod, mealPeriods)
      : null;
    const rows = mealTxs
      ? getCategoryBreakdownFromTransactions(mealTxs, metric)
      : getChannelCategoryBreakdown(message.channel.id, targetRange.startIso, targetRange.endIso, metric);
    const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
    const topN = Math.max(1, Math.min(20, Number(plan.topN || 8)));
    const top = rows.slice(0, topN);
    const metricLabel = metricToLabel(metric);

    const analysisText = analysisRequested
      ? await generateDataAnalysisResponse({
        userQuery: content,
        data: {
          analysisType,
          metric,
          metricLabel,
          range: targetRange,
          total,
          topCategories: top,
        },
      })
      : null;

    const lines = top.length
      ? top.map((row) => `- ${row.category}：${formatMetric(metric, row.total)}（${Math.round((Math.abs(row.total) / Math.max(Math.abs(total), 1)) * 100)}%）`).join('\n')
      : '- 此區間尚無資料';
    const header =
      `📊 ${targetRange.label}${mealLabel ? ` · ${mealLabel}` : ''} 分類分析（${metricLabel}）\n` +
      `總計：${formatMetric(metric, total)}\n${lines}`;
    await message.reply(analysisText ? `${header}\n\n${analysisText}` : header);
    return true;
  }

  if (effectiveAnalysisType === 'trend') {
    if (!analysisRequested) {
      const targetRange = resolveRangeSpec(plan.targetRange, content)
        || (singlePreset ? getRangeFromPreset(singlePreset) : null)
        || resolveRangeSpec({ preset: 'today' }, content);
      if (targetRange) {
        const fallbackPlanForSingle = {
          __forceSingleRange: true,
          analysisType: 'single_range',
          metric,
          targetRange: { preset: normalizePeriod(plan?.targetRange?.preset) || (singlePreset || 'today') },
          category,
        };
        return handleQueryAnalysis(message, content, fallbackPlanForSingle);
      }
    }
    const targetRange = resolveRangeSpec(plan.targetRange, content) || resolveRangeSpec({ preset: 'this_month' }, content);
    if (!targetRange) return false;
    const mealTxs = mealPeriod
      ? getMealFilteredTransactions(message.channel.id, targetRange.startIso, targetRange.endIso, mealPeriod, mealPeriods)
      : null;
    const series = mealTxs
      ? getDailyMetricSeriesFromTransactions(mealTxs, metric, category)
      : getChannelDailyMetricSeries(message.channel.id, targetRange.startIso, targetRange.endIso, metric, category);
    const metricLabel = metricToLabel(metric);
    const total = series.reduce((sum, point) => sum + Number(point.value || 0), 0);
    const head = series.slice(0, 12);
    const lines = head.length
      ? head.map((point) => `- ${point.day}：${formatMetric(metric, point.value)}`).join('\n')
      : '- 此區間尚無資料';

    const analysisText = analysisRequested
      ? await generateDataAnalysisResponse({
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
      })
      : null;

    const header =
      `📈 ${targetRange.label}${mealLabel ? ` · ${mealLabel}` : ''} 趨勢（${metricLabel}${category ? ` / ${category}` : ''}）\n` +
      `合計：${formatMetric(metric, total)}\n${lines}`;
    await message.reply(analysisText ? `${header}\n\n${analysisText}` : header);
    return true;
  }

  if (!compareRequested && singlePreset) {
    // 僅查單區間但被 LLM 判成 compare 時，回到單區間 embed
    const forcedSinglePlan = {
      __forceSingleRange: true,
      analysisType: 'single_range',
      metric,
      targetRange: { preset: singlePreset },
      category,
    };
    return handleQueryAnalysis(message, content, forcedSinglePlan);
  }

  const rangeA = resolveRangeSpec(plan.rangeA, content) || resolveRangeSpec({ preset: plan.periodA }, content);
  const rangeB = resolveRangeSpec(plan.rangeB, content) || resolveRangeSpec({ preset: plan.periodB }, content);
  if (!rangeA || !rangeB) {
    await message.reply('我需要兩個比較區間，例如「昨天和今天的消費差多少」。');
    return true;
  }

  const mealTxA = mealPeriod ? getMealFilteredTransactions(message.channel.id, rangeA.startIso, rangeA.endIso, mealPeriod, mealPeriods) : null;
  const mealTxB = mealPeriod ? getMealFilteredTransactions(message.channel.id, rangeB.startIso, rangeB.endIso, mealPeriod, mealPeriods) : null;
  const valueA = mealTxA
    ? getMetricTotalFromTransactions(mealTxA, metric, category)
    : getChannelMetricTotal(message.channel.id, rangeA.startIso, rangeA.endIso, metric, category);
  const valueB = mealTxB
    ? getMetricTotalFromTransactions(mealTxB, metric, category)
    : getChannelMetricTotal(message.channel.id, rangeB.startIso, rangeB.endIso, metric, category);
  const diff = valueB - valueA;
  const absDiff = Math.abs(diff);
  const direction = diff === 0 ? '持平' : diff > 0 ? '增加' : '減少';
  const metricLabel = metricToLabel(metric);
  const detailTxA = mealTxA || getChannelTransactionsInRange(message.channel.id, rangeA.startIso, rangeA.endIso);
  const detailTxB = mealTxB || getChannelTransactionsInRange(message.channel.id, rangeB.startIso, rangeB.endIso);

  const analysisText = analysisRequested
    ? await generateDataAnalysisResponse({
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
    })
    : null;

  const summaryEmbed = new EmbedBuilder()
    .setColor(diff > 0 ? 0xe67e22 : diff < 0 ? 0x2ecc71 : 0x95a5a6)
    .setTitle(`📊 區間比較：${rangeA.label} vs ${rangeB.label}${mealLabel ? `（${mealLabel}）` : ''}`)
    .addFields(
      { name: `${rangeA.label}`, value: formatMetric(metric, valueA), inline: true },
      { name: `${rangeB.label}`, value: formatMetric(metric, valueB), inline: true },
      { name: '差異', value: `${direction} ${formatMetric(metric, absDiff)}`, inline: true }
    )
    .addFields(...(
      showMealPeriodsInEmbed
        ? [{
          name: '🍽️ 餐期設定',
          value: formatMealPeriodsForDisplay(mealPeriods),
          inline: false,
        }]
        : []
    ))
    .setTimestamp();

  const detailA = filterTransactionsForMetric(detailTxA, metric, category);
  const detailB = filterTransactionsForMetric(detailTxB, metric, category);
  const embedsA = buildRangeEntriesEmbeds(`${rangeA.label}${mealLabel ? ` · ${mealLabel}` : ''}`, detailA, metricLabel, category);
  const embedsB = buildRangeEntriesEmbeds(`${rangeB.label}${mealLabel ? ` · ${mealLabel}` : ''}`, detailB, metricLabel, category);
  console.log('[QUERY SEND] compare summary', JSON.stringify({
    channelId: message.channel.id,
    metric,
    category,
    rangeA: rangeA.label,
    rangeB: rangeB.label,
    detailCountA: detailA.length,
    detailCountB: detailB.length,
  }));
  await message.reply({
    content: analysisText || undefined,
    embeds: [summaryEmbed],
  });
  await sendPagedDetailEmbeds(message.channel, message.author.id, [...embedsA, ...embedsB]);
  setRecentQueryContext(message, {
    metric,
    category,
    mealPeriod,
    targetRangeSpec: {
      startDate: rangeA.startIso,
      endDate: rangeA.endIso,
      label: rangeA.label,
    },
  });
  console.log('[QUERY SENT] compare done');
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
          `🎉 共同帳本初始化完成！\n` +
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

function normalizeDecisionToTransaction(decision, allowedCategories = [], content = '', fallbackTimestampIso = null, userCategoryRules = []) {
  if (!decision || typeof decision.amount !== 'number') return null;
  const rawAmount = Number(decision.amount);
  if (!Number.isFinite(rawAmount)) return null;
  const amount = Math.round(Math.abs(rawAmount));
  const type = inferTransactionTypeFromContext({
    explicitType: decision.type,
    rawAmount,
    note: decision.note,
    category: decision.category,
    content,
  });
  const normalizedNote = stripLeadingDateTimePrefix(normalizeOptionalNote(decision.note));
  const contentPrimaryNote = extractPrimaryNoteFromContent(content);
  const finalNote = pickBetterNote(normalizedNote, contentPrimaryNote);
  const typedAllowedCategories = getAllowedCategoriesByType(allowedCategories, type);
  const normalizedCategory = normalizeTransactionCategory(
    decision.category,
    typedAllowedCategories,
    `${finalNote || normalizedNote || ''} ${content || ''}`,
    userCategoryRules
  );
  const category = normalizedCategory || (type === 'income' ? '收入' : '未分類');
  const itemName = finalNote || normalizedNote || category;
  return {
    amount,
    type,
    category,
    note: finalNote || normalizedNote,
    itemName,
    timestamp: fallbackTimestampIso || new Date().toISOString(),
  };
}

function extractPrimaryNoteFromContent(content) {
  let text = stripLeadingDateTimePrefix(String(content || '').trim());
  if (!text) return '';
  // 去掉尾端金額（例如：手搖飲 再睡五分鐘 75塊 -> 手搖飲 再睡五分鐘）
  text = text
    .replace(/[，,、。；;：:]\s*$/, '')
    .replace(/\s*[+-]?\d+(?:\.\d+)?\s*(?:元|塊|塊錢|台幣|nt\$?|ntd)?\s*$/i, '')
    .trim();
  return text;
}

function pickBetterNote(primary, secondary) {
  const a = String(primary || '').trim();
  const b = String(secondary || '').trim();
  if (!a && !b) return '';
  if (!a) return b;
  if (!b) return a;
  // 若其中一個包含另一個，優先較完整版本，避免只剩「五分鐘」這種縮短
  if (a.includes(b) && a.length >= b.length) return a;
  if (b.includes(a) && b.length >= a.length) return b;
  // 若 primary 很短且 secondary 明顯更完整，優先 secondary
  if (a.length <= 4 && b.length >= a.length + 2) return b;
  return a;
}

function resolveRecordTransactions(decision, content = '', allowedCategories = [], fallbackTimestampIso = null, userCategoryRules = []) {
  if (!decision) return [];

  // 支援 LLM 直接回傳多筆交易
  if (Array.isArray(decision.transactions) && decision.transactions.length) {
    const fromDecision = decision.transactions
      .map((item) => normalizeDecisionToTransaction(item, allowedCategories, content, fallbackTimestampIso, userCategoryRules))
      .filter(Boolean);
    if (fromDecision.length) return fromDecision;
  }

  // 文字中包含多個「項目+金額」時，拆成多筆（例：滷味 55 飲料50）
  const fromText = parseMultipleTransactionsFromText(content, allowedCategories, decision, fallbackTimestampIso, userCategoryRules);
  if (fromText.length > 1) return fromText;

  const single = normalizeDecisionToTransaction(decision, allowedCategories, content, fallbackTimestampIso, userCategoryRules);
  return single ? [single] : [];
}

function parseMultipleTransactionsFromText(content, allowedCategories = [], decision = null, fallbackTimestampIso = null, userCategoryRules = []) {
  // 先移除開頭的日期/時間前綴（例如 4/3、2026/4/3），避免 "4/3 coco -130" 被拆成兩筆
  const text = stripLeadingDateTimePrefix(String(content || '').trim());
  if (!text) return [];

  const regex = /([^\d+\-]{1,40}?)\s*([+-]?\d+(?:\.\d+)?)(?=(?:\s+[^\d+\-]{1,40}\s*[+-]?\d+(?:\.\d+)?)|$)/g;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const rawNote = String(match[1] || '').trim().replace(/[，,、。；;：:]+$/g, '');
    const cleanedNote = stripLeadingDateTimePrefix(rawNote);
    const amount = Number(match[2]);
    if (!(cleanedNote || rawNote) || !Number.isFinite(amount) || amount === 0) continue;
    matches.push({ rawNote: cleanedNote || rawNote, amount: Math.abs(amount), rawAmountText: String(match[2]) });
  }
  if (matches.length <= 1) return [];

  const defaultType = inferTransactionTypeFromContext({
    explicitType: decision?.type,
    rawAmount: Number(decision?.amount || 0),
    note: decision?.note,
    category: decision?.category,
    content,
  });
  return matches.map((item) => {
    const inferredType = inferTransactionTypeFromContext({
      explicitType: defaultType,
      rawAmount: item.rawAmountText.startsWith('-') ? -item.amount : item.amount,
      note: item.rawNote,
      category: null,
      content: `${content} ${item.rawNote}`,
    });
    const typedAllowedCategories = getAllowedCategoriesByType(allowedCategories, inferredType);
    const category = normalizeTransactionCategory(item.rawNote, typedAllowedCategories, item.rawNote, userCategoryRules);
    return {
      amount: Math.round(item.amount),
      type: inferredType,
      category: category || (inferredType === 'income' ? '收入' : '未分類'),
      note: item.rawNote,
      itemName: item.rawNote,
      timestamp: fallbackTimestampIso || new Date().toISOString(),
    };
  });
}

function inferTransactionTypeFromContext({ explicitType = null, rawAmount = 0, note = '', category = '', content = '' } = {}) {
  if (rawAmount < 0) return 'expense';
  if (rawAmount > 0 && rawAmount !== 0 && String(explicitType || '').trim() === 'income') return 'income';
  if (rawAmount > 0 && rawAmount !== 0 && String(explicitType || '').trim() === 'expense') return 'expense';

  const text = `${note || ''} ${category || ''} ${content || ''}`.toLowerCase();
  const incomeHints = [
    '收入', '入帳', '薪水', '薪資', '發薪', '獎金', '紅包', '退款', '回饋', '賺', '兼職', '被動收入', '生活費', '補助', '收款',
    'income', 'salary', 'bonus', 'refund', 'cashback', 'deposit',
  ];
  const expenseHints = [
    '支出', '花', '花了', '買', '付款', '付了', '繳', '扣款', '消費', '晚餐', '午餐', '早餐', '宵夜', '交通', '房租',
    'expense', 'spent', 'pay', 'paid', 'buy', 'purchase',
  ];
  if (incomeHints.some((k) => text.includes(k))) return 'income';
  if (expenseHints.some((k) => text.includes(k))) return 'expense';
  return 'expense';
}

function getAllowedCategoriesByType(allowedCategories = [], type = 'expense') {
  const safeAllowed = Array.isArray(allowedCategories) && allowedCategories.length
    ? allowedCategories
    : [...DEFAULT_ALLOWED_CATEGORIES];
  const income = safeAllowed.filter((tag) => DEFAULT_INCOME_CATEGORY_SET.has(String(tag || '').trim()));
  const expense = safeAllowed.filter((tag) => !DEFAULT_INCOME_CATEGORY_SET.has(String(tag || '').trim()));
  if (type === 'income') {
    return income.length ? income : safeAllowed;
  }
  return expense.length ? expense : safeAllowed;
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

function stripLeadingDateTimePrefix(text) {
  let value = String(text || '').trim();
  if (!value) return '';
  const original = value;

  // 連續移除前綴中的日期與時間（例如：3/2 15:49，）
  for (let i = 0; i < 4; i += 1) {
    const before = value;
    value = value.replace(/^[\s，,、。；;：:]+/, '');
    value = value.replace(/^(?:今天|昨天|前天)\s*/i, '');
    value = value.replace(/^\d{4}\s*[\/\-年]\s*\d{1,2}\s*[\/\-月]\s*\d{1,2}\s*日?\s*/i, '');
    value = value.replace(/^\d{1,2}\s*[\/\-月]\s*\d{1,2}\s*日?\s*/i, '');
    value = value.replace(/^(?:上午|下午|晚上|中午|凌晨|早上|傍晚|am|pm)?\s*(?:[01]?\d|2[0-3])\s*(?:[:：]\s*[0-5]\d|點\s*(?:半|[0-5]?\d\s*分?)?)\s*/i, '');
    value = value.replace(/^[\s，,、。；;：:]+/, '');
    if (value === before) break;
  }

  return value || original;
}

function normalizeTransactionCategory(rawCategory, allowedCategories, contextText = '', userCategoryRules = []) {
  const safeAllowed = Array.isArray(allowedCategories) && allowedCategories.length
    ? allowedCategories
    : [...DEFAULT_ALLOWED_CATEGORIES];

  const ruleCategory = matchUserCategoryRule(contextText, userCategoryRules, safeAllowed);
  if (ruleCategory) return ruleCategory;

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

function inferTransactionOccurredAt(content, referenceDate = new Date()) {
  const text = String(content || '').trim();
  if (!text) return null;

  const ref = new Date(referenceDate);
  if (Number.isNaN(ref.getTime())) return null;

  let year = ref.getFullYear();
  let month = ref.getMonth() + 1;
  let day = ref.getDate();
  let hasDate = false;

  let m = text.match(/(\d{4})\s*[\/\-年]\s*(\d{1,2})\s*[\/\-月]\s*(\d{1,2})\s*日?/);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
    hasDate = true;
  } else {
    m = text.match(/(^|[^\d])(\d{1,2})\s*[\/\-月]\s*(\d{1,2})\s*日?/);
    if (m) {
      year = ref.getFullYear();
      month = Number(m[2]);
      day = Number(m[3]);
      hasDate = true;
    } else if (/前天/.test(text)) {
      const d = new Date(ref);
      d.setDate(d.getDate() - 2);
      year = d.getFullYear();
      month = d.getMonth() + 1;
      day = d.getDate();
      hasDate = true;
    } else if (/昨天/.test(text)) {
      const d = new Date(ref);
      d.setDate(d.getDate() - 1);
      year = d.getFullYear();
      month = d.getMonth() + 1;
      day = d.getDate();
      hasDate = true;
    } else if (/今天|剛剛|剛才|方才/.test(text)) {
      hasDate = true;
    }
  }

  const parsedTime = parseClockTimeFromText(text);
  const hasTime = Boolean(parsedTime);

  if (!hasDate && !hasTime) return null;

  const d = new Date(ref);
  if (hasDate) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    d.setFullYear(year, month - 1, day);
  }

  if (hasTime) {
    d.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
  } else if (hasDate) {
    d.setHours(0, 0, 0, 0);
  } else {
    return null;
  }

  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseClockTimeFromText(text) {
  let m = String(text || '').match(/(上午|早上|清晨|凌晨|中午|下午|晚上|傍晚|am|pm)?\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)/i);
  if (m) {
    return applyMeridiemToHour({
      meridiem: m[1] || '',
      hour: Number(m[2]),
      minute: Number(m[3]),
    });
  }

  m = String(text || '').match(/(上午|早上|清晨|凌晨|中午|下午|晚上|傍晚|am|pm)?\s*(\d{1,2})\s*點\s*([0-5]?\d)?\s*(分)?/i);
  if (m) {
    const minute = m[3] !== undefined && m[3] !== '' ? Number(m[3]) : (/點半/.test(text) ? 30 : 0);
    return applyMeridiemToHour({
      meridiem: m[1] || '',
      hour: Number(m[2]),
      minute,
    });
  }
  return null;
}

function applyMeridiemToHour(input) {
  let hour = Number(input?.hour);
  const minute = Number(input?.minute);
  const meridiem = String(input?.meridiem || '').toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  if ((/下午|晚上|傍晚|pm/.test(meridiem)) && hour < 12) hour += 12;
  if ((/凌晨/.test(meridiem)) && hour === 12) hour = 0;
  if ((/中午/.test(meridiem)) && hour >= 1 && hour <= 11) hour += 12;

  if (hour < 0 || hour > 23) return null;
  return { hour, minute };
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

function parseUndoIntent(content) {
  const text = String(content || '').trim().toLowerCase();
  if (!text) return null;
  const isUndo = /(還原|復原|撤銷|回復|undo)/.test(text);
  const hasStepHint = /(上一步|上一筆|最近|最後|剛剛|上個)/.test(text);
  if (!isUndo || !hasStepHint) return null;
  const stepMatch = text.match(/(\d+)\s*(步|次|筆)/);
  const steps = stepMatch ? Number(stepMatch[1]) : 1;
  return { steps };
}

function parseBackupIntent(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  const normalized = text.toLowerCase();

  const hasBackupKeyword = /(備份|backup)/i.test(text);
  const hasRestoreKeyword = /(回檔|還原備份|恢復備份|還原資料庫|restore)/i.test(text);
  const askList = /(列出|清單|有哪些|列表|查看)/.test(text);
  const createNow = /(現在|立刻|馬上|立即|手動|做一份|建立一份|建立|產生)/.test(text);

  if (hasBackupKeyword && !hasRestoreKeyword && (createNow || /備份一下|先備份/.test(text))) {
    return { action: 'create' };
  }
  if (hasBackupKeyword && askList) {
    return { action: 'list' };
  }

  if (hasRestoreKeyword) {
    if (/(最新|上一份|最近|latest)/i.test(normalized)) {
      return { action: 'restore', mode: 'latest' };
    }
    const matchIndex = text.match(/第\s*(\d+)\s*(份|個|筆)?/);
    if (matchIndex) {
      return { action: 'restore', mode: 'index', index: Number(matchIndex[1]) };
    }
    return { action: 'restore', mode: 'pick' };
  }

  const directPick = text.match(/^(?:回檔|還原)\s*(\d+)\s*$/);
  if (directPick) {
    return { action: 'restore', mode: 'index', index: Number(directPick[1]) };
  }

  return null;
}

function formatBackupListLines(backups, limit = 8) {
  const top = (Array.isArray(backups) ? backups : []).slice(0, limit);
  if (!top.length) return '目前沒有可用備份。';
  return top.map((row, idx) => {
    const when = formatIsoToTaipei(row.createdAt || row.updatedAt);
    const sizeMb = Number(row.sizeBytes || 0) / (1024 * 1024);
    return `${idx + 1}. ${row.filename}\n   時間：${when}｜大小：${sizeMb.toFixed(2)} MB`;
  }).join('\n');
}

function formatIsoToTaipei(isoText) {
  const d = new Date(isoText || Date.now());
  if (Number.isNaN(d.getTime())) return String(isoText || '-');
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

async function handleBackupDialogIntent(message, content) {
  const key = `${message.channel.id}:${message.author.id}`;
  const now = Date.now();
  const pending = pendingBackupRestoreActions.get(key);
  if (pending && now > Number(pending.expiresAt || 0)) {
    pendingBackupRestoreActions.delete(key);
  }

  let intent = parseBackupIntent(content);
  const activePending = pendingBackupRestoreActions.get(key) || null;

  if (!intent && activePending) {
    const pick = String(content || '').trim().match(/^(\d{1,2})$/);
    if (!pick) return false;
    intent = { action: 'restore', mode: 'index', index: Number(pick[1]) };
  }
  if (!intent) return false;

  if (intent.action === 'create') {
    const created = createBackup({ reason: 'discord_manual' });
    const config = getBackupConfig();
    await sendEmbed(message, {
      title: '💾 備份完成',
      fields: [
        { name: '檔名', value: created.filename, inline: false },
        { name: '時間', value: formatIsoToTaipei(created.createdAt), inline: true },
        { name: '大小', value: `${(Number(created.sizeBytes || 0) / (1024 * 1024)).toFixed(2)} MB`, inline: true },
        { name: '每日自動備份時間', value: String(config.dailyTime || '03:30'), inline: true },
      ],
    });
    return true;
  }

  const backups = listBackups({ limit: 20 });
  if (!backups.length) {
    await message.reply('⚠️ 目前沒有可用備份，請先說「現在備份」建立第一份。');
    return true;
  }

  if (intent.action === 'list' || intent.mode === 'pick') {
    pendingBackupRestoreActions.set(key, { expiresAt: Date.now() + 10 * 60 * 1000 });
    await sendEmbed(message, {
      title: '🗂️ 可回檔備份清單',
      fields: [
        { name: '最近備份', value: formatBackupListLines(backups, 8), inline: false },
        { name: '操作方式', value: '回覆 `回檔 第2份`、`回檔 最新`，或直接輸入數字 `2`', inline: false },
      ],
    });
    return true;
  }

  let selected = null;
  if (intent.mode === 'latest') {
    selected = backups[0];
  } else if (intent.mode === 'index') {
    const index = Math.max(1, Math.min(backups.length, Number(intent.index || 1)));
    selected = backups[index - 1];
  }

  if (!selected) {
    await message.reply('⚠️ 找不到你指定的備份，請先說「列出備份」。');
    return true;
  }

  const result = restoreBackupByFilename(selected.filename, { createSafetyBackup: true });
  pendingBackupRestoreActions.delete(key);
  await sendEmbed(message, {
    title: '♻️ 回檔完成',
    fields: [
      { name: '已回檔版本', value: result.restored.filename, inline: false },
      { name: '版本時間', value: formatIsoToTaipei(result.restored.createdAt), inline: true },
      { name: '安全備份', value: result.safetyBackup?.filename || '無', inline: true },
      { name: '提醒', value: '這是全資料庫回檔，建議 1-2 秒後再查詢資料。', inline: false },
    ],
  });
  return true;
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

function getFirstAudioAttachment(message) {
  if (!message?.attachments || typeof message.attachments.values !== 'function') return null;
  for (const attachment of message.attachments.values()) {
    const contentType = String(attachment.contentType || '').toLowerCase();
    const isAudioByType = contentType.startsWith('audio/');
    const isAudioByName = /\.(ogg|oga|mp3|wav|m4a|webm|aac|flac)$/i.test(String(attachment.name || ''));
    if (isAudioByType || isAudioByName) return attachment;
  }
  return null;
}

function resolveAnalysisPlan(content, decision) {
  if (isCategoryAnalysisQuery(content)) {
    return { analysisType: 'category_breakdown' };
  }

  const explicitRange = parseExplicitDateRangeFromText(content);
  if (explicitRange) {
    return {
      analysisType: 'single_range',
      metric: normalizeMetric(decision?.metric) || inferMetricFromText(content),
      targetRange: explicitRange,
    };
  }

  const metric = normalizeMetric(decision?.metric) || inferMetricFromText(content);
  const periodA = normalizePeriod(decision?.periodA);
  const periodB = normalizePeriod(decision?.periodB);

  if (periodA && periodB) {
    return { metric, periodA, periodB };
  }

  // 針對常見句型的保底：昨天 vs 今天
  if (/(昨天|昨日)/.test(content) && /(今天|今日)/.test(content)) {
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
  if (/(昨天|昨日)/.test(text) && /(今天|今日)/.test(text)) return null;
  if (/(昨天|昨日)/.test(text)) return 'yesterday';
  if (/(今天|今日)/.test(text)) return 'today';
  return null;
}

function shouldForceQueryAnalysisFallback(content, decision) {
  const action = String(decision?.action || '').trim();
  // 交易/設定流程不介入，避免誤攔截正常記帳
  if (action === 'record_transaction') return false;
  if (action === 'set_budget' || action === 'set_reminder_time' || action === 'set_gender' || action === 'set_title') return false;

  const text = String(content || '').trim();
  if (!text) return false;

  // 明確查詢關鍵字（即使沒有問號，也視為查詢）
  const directQueryPattern = /(今日|今天|昨日|昨天|本週|上週|本月|上月).*(消費|開銷|支出|收入|淨額|筆數|分類|占比|趨勢)|((消費|開銷|支出|收入).*(多少|總和|合計|比較|差多少))/;
  if (directQueryPattern.test(text)) return true;

  // 句尾/語氣像在詢問查帳
  const asksForAnalysis = /(多少|幾筆|差多少|比較|分析|統計|查(詢|帳)|占比|趨勢|\?+|嗎)$/.test(text);
  const hasRangeOrMetric = /(今天|昨日|昨天|本週|上週|本月|上月|\d{4}\s*年\s*\d{1,2}\s*月|消費|開銷|支出|收入|淨額|筆數|分類)/.test(text);
  return asksForAnalysis && hasRangeOrMetric;
}

function shouldUseSingleRangeCard(content, analysisType, singlePreset) {
  if (!singlePreset) return false;
  if (analysisType === 'compare_ranges' && isCompareIntentQuery(content)) return false;
  if (isCategoryAnalysisQuery(content)) return false;
  if (/(趨勢|走勢|每天|日趨勢)/.test(String(content || ''))) return false;
  if (/(比較|相比|差多少|差異|vs|VS|跟.+比|和.+比)/.test(String(content || ''))) return false;
  return true;
}

function isAnalysisIntentQuery(content) {
  const text = String(content || '');
  return /(分析|洞察|解讀|占比|趨勢|走勢|比較|相比|差多少|差異|top|排行|圓餅)/i.test(text);
}

function isCompareIntentQuery(content) {
  const text = String(content || '');
  return /(比較|相比|差多少|差異|vs|VS|跟.+比|和.+比)/.test(text);
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
    if (typeof rangeSpec.startDate === 'string' && typeof rangeSpec.endDate === 'string') {
      const start = new Date(rangeSpec.startDate);
      const end = new Date(rangeSpec.endDate);
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
        return {
          label: String(rangeSpec.label || `${String(rangeSpec.startDate).slice(0, 10)} ~ ${String(rangeSpec.endDate).slice(0, 10)}`),
          startIso: start.toISOString(),
          endIso: end.toISOString(),
        };
      }
    }
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

  const explicitRange = parseExplicitDateRangeFromText(content);
  if (explicitRange) {
    return resolveRangeSpec(explicitRange, '');
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

function getRecentQueryContext(message) {
  const key = String(message.channel.id);
  const item = recentQueryContexts.get(key);
  if (!item) return null;
  if (Date.now() > Number(item.expiresAt || 0)) {
    recentQueryContexts.delete(key);
    return null;
  }
  return item;
}

function setRecentQueryContext(message, ctx) {
  const key = String(message.channel.id);
  recentQueryContexts.set(key, {
    speakerId: message.author.id,
    metric: ctx?.metric || null,
    category: ctx?.category || null,
    mealPeriod: ctx?.mealPeriod || null,
    targetRangeSpec: ctx?.targetRangeSpec || null,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
}

function shouldInheritLastQueryContext(text, options = {}) {
  const source = String(text || '').trim();
  if (!source) return { inherit: false, mode: 'none' };
  const hasDate = Boolean(options.explicitDateRange);
  const hasCategory = Boolean(options.rawCategory);
  const hasMeal = Boolean(options.mealPeriod);
  const hasCompare = Boolean(options.compareRequested);
  const fromDifferentSpeaker = Boolean(options.fromDifferentSpeaker);
  const strongFollowUp = /(我是說|我是指|我說的是|更正|修正|改查|重查|剛剛那個|上一句|同樣條件|一樣條件|不是.*是.*|那(前一天|後一天|天|週|月)?呢)/.test(source);
  const weakFollowUp = /(查詢.*的$|的$|那.*呢$|改成|換成|只看|改看)/.test(source);

  if (hasCompare) return { inherit: false, mode: 'none' };
  if (!hasDate && !strongFollowUp && !weakFollowUp) return { inherit: false, mode: 'none' };
  if (hasCategory && hasMeal) return { inherit: false, mode: 'none' };

  // 不同人發話時，只允許強承接語句避免誤套用前文條件
  if (fromDifferentSpeaker) {
    if (!strongFollowUp) return { inherit: false, mode: 'different_speaker_blocked' };
    if (hasCategory || hasMeal) return { inherit: false, mode: 'different_speaker_explicit' };
    return { inherit: true, mode: 'different_speaker_strong' };
  }

  // 同一說話者可較寬鬆承接：日期補述或簡短追問都可沿用前文條件
  if (hasDate && !hasCategory && !hasMeal) return { inherit: true, mode: 'same_speaker_date_patch' };
  if (strongFollowUp && !hasCategory && !hasMeal) return { inherit: true, mode: 'same_speaker_strong' };
  if (weakFollowUp && !hasCategory && !hasMeal) return { inherit: true, mode: 'same_speaker_weak' };
  return { inherit: false, mode: 'none' };
}

function parseExplicitDateRangeFromText(content) {
  const text = String(content || '').trim();
  if (!text) return null;

  // 例如：2026-03-01、2026/3/1
  const ymd = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s*(?:到|至|~|-)\s*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2}))?/);
  if (ymd) {
    const y1 = Number(ymd[1]);
    const m1 = Number(ymd[2]);
    const d1 = Number(ymd[3]);
    const y2 = Number(ymd[4] || y1);
    const m2 = Number(ymd[5] || m1);
    const d2 = Number(ymd[6] || d1);
    const start = new Date(y1, m1 - 1, d1, 0, 0, 0, 0);
    const endBase = new Date(y2, m2 - 1, d2, 0, 0, 0, 0);
    if (Number.isNaN(start.getTime()) || Number.isNaN(endBase.getTime())) return null;
    const end = new Date(endBase);
    end.setDate(end.getDate() + 1);
    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      label: ymd[4] ? `${y1}/${m1}/${d1} ~ ${y2}/${m2}/${d2}` : `${y1}/${m1}/${d1}`,
    };
  }

  // 例如：3/1、3-1、3/1~3/3（年份用當年）
  const md = text.match(/(\d{1,2})[\/\-](\d{1,2})(?:\s*(?:到|至|~|-)\s*(\d{1,2})[\/\-](\d{1,2}))?/);
  if (md) {
    const now = new Date();
    const year = now.getFullYear();
    const m1 = Number(md[1]);
    const d1 = Number(md[2]);
    const m2 = Number(md[3] || m1);
    const d2 = Number(md[4] || d1);
    const start = new Date(year, m1 - 1, d1, 0, 0, 0, 0);
    const endBase = new Date(year, m2 - 1, d2, 0, 0, 0, 0);
    if (Number.isNaN(start.getTime()) || Number.isNaN(endBase.getTime())) return null;
    const end = new Date(endBase);
    end.setDate(end.getDate() + 1);
    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      label: md[3] ? `${m1}/${d1} ~ ${m2}/${d2}` : `${m1}/${d1}`,
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

function defaultMealPeriods() {
  return {
    breakfast: { start: '05:00', end: '10:59' },
    lunch: { start: '11:00', end: '15:59' },
    dinner: { start: '16:00', end: '21:59' },
    late_night: { start: '22:00', end: '04:59' },
  };
}

function parseConfiguredMealPeriods(text) {
  const fallback = defaultMealPeriods();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(String(text || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const out = {};
    Object.keys(fallback).forEach((key) => {
      const src = parsed[key] || {};
      const start = String(src.start || '').trim();
      const end = String(src.end || '').trim();
      const validStart = /^([01]\d|2[0-3]):([0-5]\d)$/.test(start) ? start : fallback[key].start;
      const validEnd = /^([01]\d|2[0-3]):([0-5]\d)$/.test(end) ? end : fallback[key].end;
      out[key] = { start: validStart, end: validEnd };
    });
    return out;
  } catch (_) {
    return fallback;
  }
}

function parseMealPeriodSettingIntent(text) {
  const source = String(text || '');
  const range = parseClockRangeFromText(source);
  const period = inferMealPeriodTargetFromText(source);
  return { period, range };
}

function parseClockRangeFromText(text) {
  const match = String(text || '').match(/([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|~|到|至)\s*([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  const h1 = String(match[1]).padStart(2, '0');
  const m1 = String(match[2]).padStart(2, '0');
  const h2 = String(match[3]).padStart(2, '0');
  const m2 = String(match[4]).padStart(2, '0');
  return { start: `${h1}:${m1}`, end: `${h2}:${m2}` };
}

function inferMealPeriodTargetFromText(text) {
  const source = String(text || '');
  if (/早餐/.test(source)) return 'breakfast';
  if (/午餐/.test(source)) return 'lunch';
  if (/晚餐/.test(source)) return 'dinner';
  if (/宵夜/.test(source)) return 'late_night';
  return null;
}

function formatMealPeriodsForDisplay(periods) {
  const p = periods || defaultMealPeriods();
  return [
    `早餐 ${p.breakfast.start}-${p.breakfast.end}`,
    `午餐 ${p.lunch.start}-${p.lunch.end}`,
    `晚餐 ${p.dinner.start}-${p.dinner.end}`,
    `宵夜 ${p.late_night.start}-${p.late_night.end}`,
  ].join('\n');
}

function shouldIgnoreMealWordAsCategory(category, mealPeriod) {
  if (!category || !mealPeriod) return false;
  const text = String(category).trim().toLowerCase();
  return ['早餐', '午餐', '晚餐', '宵夜', 'breakfast', 'lunch', 'dinner', 'late_night', 'latenight'].includes(text);
}

function normalizeQueryCategory(rawCategory, contextText, allowedCategories = []) {
  if (!rawCategory) return null;
  const safeAllowed = Array.isArray(allowedCategories) && allowedCategories.length
    ? allowedCategories
    : [...DEFAULT_ALLOWED_CATEGORIES];
  const normalizedRaw = normalizeTagText(rawCategory);
  if (!normalizedRaw) return null;

  const exact = safeAllowed.find((tag) => normalizeTagText(tag) === normalizedRaw);
  if (exact) return exact;

  const partial = safeAllowed.find((tag) => {
    const normalizedTag = normalizeTagText(tag);
    return normalizedTag.includes(normalizedRaw) || normalizedRaw.includes(normalizedTag);
  });
  if (partial) return partial;

  const alias = inferCategoryAlias(`${rawCategory || ''} ${contextText || ''}`, safeAllowed);
  return alias || null;
}

function inferMealPeriodFromQuery(content, referenceDate = new Date(), mealPeriods = defaultMealPeriods()) {
  const text = String(content || '');
  if (!text) return null;

  if (/早餐|早上|morning|breakfast/i.test(text)) return 'breakfast';
  if (/午餐|中午|noon|lunch/i.test(text)) return 'lunch';
  if (/晚餐|晚飯|dinner/i.test(text)) return 'dinner';
  if (/宵夜|夜食|late\s*night|midnight/i.test(text)) return 'late_night';

  // 問「這餐/現在」時，依發問時間判斷餐別
  if (/(這餐|這頓|現在|剛剛|吃了多少|這餐花|這頓花)/.test(text)) {
    const hour = new Date(referenceDate).getHours();
    if (isHourInRange(hour, mealPeriods?.breakfast?.start, mealPeriods?.breakfast?.end)) return 'breakfast';
    if (isHourInRange(hour, mealPeriods?.lunch?.start, mealPeriods?.lunch?.end)) return 'lunch';
    if (isHourInRange(hour, mealPeriods?.dinner?.start, mealPeriods?.dinner?.end)) return 'dinner';
    return 'late_night';
  }
  return null;
}

function mealPeriodLabel(period) {
  if (period === 'breakfast') return '早餐';
  if (period === 'lunch') return '午餐';
  if (period === 'dinner') return '晚餐';
  if (period === 'late_night') return '宵夜';
  return '';
}

function hourFromTimeText(timeText, fallback = 0) {
  const text = String(timeText || '').trim();
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return fallback;
  return Number(match[1]);
}

function isHourInRange(hour, startText, endText) {
  const start = hourFromTimeText(startText, 0);
  const end = hourFromTimeText(endText, 23);
  if (start <= end) {
    return hour >= start && hour <= end;
  }
  // 跨日區間，例如 22:00~04:59
  return hour >= start || hour <= end;
}

function isTimestampInMealPeriod(timestamp, period, mealPeriods = defaultMealPeriods()) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return false;
  const hour = date.getHours();
  if (period === 'breakfast') return isHourInRange(hour, mealPeriods?.breakfast?.start, mealPeriods?.breakfast?.end);
  if (period === 'lunch') return isHourInRange(hour, mealPeriods?.lunch?.start, mealPeriods?.lunch?.end);
  if (period === 'dinner') return isHourInRange(hour, mealPeriods?.dinner?.start, mealPeriods?.dinner?.end);
  if (period === 'late_night') return isHourInRange(hour, mealPeriods?.late_night?.start, mealPeriods?.late_night?.end);
  return true;
}

function getMealFilteredTransactions(channelId, startIso, endIso, mealPeriod, mealPeriods = defaultMealPeriods()) {
  const txs = getChannelTransactionsInRange(channelId, startIso, endIso);
  return txs.filter((tx) => {
    if (!isTimestampInMealPeriod(tx.timestamp, mealPeriod, mealPeriods)) return false;
    return String(tx.category || '').trim() === '餐飲';
  });
}

function buildSummaryFromTransactions(transactions) {
  const list = Array.isArray(transactions) ? transactions : [];
  const income = list
    .filter((tx) => tx.type === 'income')
    .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const expense = list
    .filter((tx) => tx.type === 'expense')
    .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  return {
    income,
    expense,
    net: income - expense,
    count: list.length,
  };
}

function getMetricTotalFromTransactions(transactions, metric = 'expense', category = null) {
  const list = (Array.isArray(transactions) ? transactions : []).filter((tx) => {
    if (!category) return true;
    return String(tx.category || '') === String(category);
  });
  if (metric === 'count') return list.length;
  if (metric === 'income') {
    return list.filter((tx) => tx.type === 'income').reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  }
  if (metric === 'net') {
    return list.reduce((sum, tx) => sum + (tx.type === 'income' ? Number(tx.amount || 0) : -Number(tx.amount || 0)), 0);
  }
  return list.filter((tx) => tx.type === 'expense').reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
}

function getCategoryBreakdownFromTransactions(transactions, metric = 'expense') {
  const groups = new Map();
  (Array.isArray(transactions) ? transactions : []).forEach((tx) => {
    const key = String(tx.category || '未分類');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tx);
  });
  return Array.from(groups.entries())
    .map(([category, list]) => ({ category, total: getMetricTotalFromTransactions(list, metric, null) }))
    .sort((a, b) => Math.abs(Number(b.total || 0)) - Math.abs(Number(a.total || 0)));
}

function getDailyMetricSeriesFromTransactions(transactions, metric = 'expense', category = null) {
  const groups = new Map();
  (Array.isArray(transactions) ? transactions : []).forEach((tx) => {
    if (category && String(tx.category || '') !== String(category)) return;
    const day = String(tx.timestamp || '').slice(0, 10);
    if (!day) return;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(tx);
  });
  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, list]) => {
      const income = list
        .filter((tx) => tx.type === 'income')
        .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
      const expense = list
        .filter((tx) => tx.type === 'expense')
        .reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
      const count = list.length;
      let value = expense;
      if (metric === 'income') value = income;
      if (metric === 'net') value = income - expense;
      if (metric === 'count') value = count;
      return { day, value, income, expense, count };
    });
}

function buildExpenseDetailLines(transactions, category = null, limit = 6) {
  const list = (Array.isArray(transactions) ? transactions : [])
    .filter((tx) => tx.type === 'expense')
    .filter((tx) => !category || String(tx.category || '') === String(category))
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
    .slice(0, limit);
  if (!list.length) return '（無支出細項）';

  const lines = list.map((tx) => {
    const date = String(tx.timestamp || '').slice(5, 10) || '----';
    const note = String(tx.note || tx.category || '未分類').trim() || '未分類';
    return `• ${date} ${note} - NT$ ${Number(tx.amount || 0).toLocaleString()}`;
  });

  const text = lines.join('\n');
  if (text.length <= 1000) return text;
  return `${text.slice(0, 980)}\n...`;
}

function filterTransactionsForMetric(transactions, metric = 'expense', category = null) {
  let list = Array.isArray(transactions) ? transactions : [];
  if (category) {
    list = list.filter((tx) => String(tx.category || '') === String(category));
  }
  if (metric === 'income') {
    return list.filter((tx) => tx.type === 'income');
  }
  if (metric === 'expense') {
    return list.filter((tx) => tx.type === 'expense');
  }
  // net/count 顯示全部交易
  return list;
}

function buildRangeEntriesEmbeds(rangeLabel, transactions, metricLabel, category = null) {
  const list = Array.isArray(transactions) ? [...transactions] : [];
  list.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  if (!list.length) {
    return [
      new EmbedBuilder()
        .setColor(0x6c757d)
        .setTitle(`🧾 ${rangeLabel} 條目`)
        .setDescription(`無符合條目（${metricLabel}${category ? ` / ${category}` : ''}）`)
        .setTimestamp(),
    ];
  }

  const lines = list.map((tx) => {
    const d = new Date(tx.timestamp);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const sign = tx.type === 'income' ? '+' : '-';
    const note = String(tx.note || '').trim() || '-';
    return `ID ${tx.id}｜${month}/${day} ${hh}:${mm}｜${tx.category}｜${sign}NT$ ${Number(tx.amount || 0).toLocaleString()}｜${note}`;
  });

  const MAX_LINES_PER_PAGE = 15;
  const pages = [];
  let current = [];
  let currentLen = 0;
  lines.forEach((line) => {
    const nextLen = currentLen + line.length + 1;
    if ((nextLen > 3500 || current.length >= MAX_LINES_PER_PAGE) && current.length) {
      pages.push(current);
      current = [line];
      currentLen = line.length + 1;
      return;
    }
    current.push(line);
    currentLen = nextLen;
  });
  if (current.length) pages.push(current);

  return pages.map((pageLines, index) => new EmbedBuilder()
    .setColor(0x4f46e5)
    .setTitle(`🧾 ${rangeLabel} 條目（第 ${index + 1}/${pages.length} 頁）`)
    .setDescription(pageLines.join('\n'))
    .setFooter({ text: `${metricLabel}${category ? ` / ${category}` : ''}` })
    .setTimestamp());
}

async function sendPagedDetailEmbeds(channel, ownerUserId, embeds) {
  const validEmbeds = (Array.isArray(embeds) ? embeds : []).filter(Boolean);
  if (!validEmbeds.length) return;
  if (validEmbeds.length === 1) {
    await channel.send({ embeds: [validEmbeds[0]] });
    return;
  }
  const sessionId = `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const total = validEmbeds.length;

  paginationSessions.set(sessionId, { embeds: validEmbeds, currentIndex: 0, total, ownerUserId });
  setTimeout(() => paginationSessions.delete(sessionId), PAGINATION_SESSION_TTL);

  await channel.send({
    embeds: [validEmbeds[0]],
    components: [buildPageRow(sessionId, 0, total)],
  });
}

function isChannelReadyForMessage(channelSettings) {
  if (!channelSettings) return false;
  // 初始化進行中：允許回覆初始化對話
  if (channelSettings.setup_state) return true;
  // 初始化已完成：允許正常記帳與聊天
  return Boolean(channelSettings.setup_completed_at);
}

async function sendMonthlyBudgetUsageMessage(message, context = {}) {
  const settings = getChannelSettings(message.channel.id);
  const budget = getEffectiveMonthlyBudget(settings);

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
  const todaySpent = getChannelTodayExpense(message.channel.id);
  const ratio = spent / budget;
  const percent = Math.max(0, Math.round(ratio * 100));
  const bar = buildProgressBar(ratio, 20);
  const remaining = Math.max(0, budget - spent);
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const remainingDays = Math.max(1, daysInMonth - now.getDate() + 1);
  const dailyBudgetAvailable = remaining / remainingDays;
  const categoryBudgets = parseCategoryBudgets(settings?.category_budgets_text);
  const txCategory = String(context?.transaction?.category || '').trim();
  const isExpenseTx = context?.transaction?.type === 'expense';
  const categoryBudget = isExpenseTx && txCategory ? Number(categoryBudgets[txCategory] || 0) : 0;
  const categorySpent = categoryBudget > 0
    ? getChannelMonthlyExpenseByCategory(message.channel.id, txCategory)
    : 0;
  const categoryRatio = categoryBudget > 0 ? categorySpent / categoryBudget : 0;
  const categoryPercent = Math.max(0, Math.round(categoryRatio * 100));
  const categoryBar = buildProgressBar(categoryRatio, 16);
  const statusColor = ratio >= 1 ? 0xe74c3c : ratio >= 0.8 ? 0xf39c12 : 0x2ecc71;

  const embed = new EmbedBuilder()
    .setColor(statusColor)
    .setTitle('📊 本月預算使用量')
    .addFields(
      { name: '進度', value: `${bar} ${percent}%`, inline: false },
      { name: '已用 / 預算', value: `NT$ ${spent.toLocaleString()} / NT$ ${budget.toLocaleString()}`, inline: true },
      { name: '剩餘', value: `NT$ ${remaining.toLocaleString()}`, inline: true },
      { name: '日均可用', value: `NT$ ${Math.round(dailyBudgetAvailable).toLocaleString()}（剩餘 ${remainingDays} 天）\n本日已用：NT$ ${todaySpent.toLocaleString()}`, inline: false }
    )
    .setTimestamp();

  if (categoryBudget > 0) {
    embed.addFields({
      name: `分類預算：${txCategory}`,
      value: `${categoryBar} ${categoryPercent}%\nNT$ ${categorySpent.toLocaleString()} / NT$ ${categoryBudget.toLocaleString()}`,
      inline: false,
    });
  }

  await message.reply({ embeds: [embed] });
}

function parseCategoryBudgets(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(String(text || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    Object.entries(parsed).forEach(([k, v]) => {
      const key = String(k || '').trim();
      const amount = Number(v);
      if (!key || !Number.isFinite(amount) || amount <= 0) return;
      out[key] = Math.round(amount);
    });
    return out;
  } catch (_) {
    return {};
  }
}

function parseMonthlyBudgets(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(String(text || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    Object.entries(parsed).forEach(([k, v]) => {
      const key = String(k || '').trim();
      const amount = Number(v);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return;
      if (!Number.isFinite(amount) || amount < 0) return;
      out[key] = Math.round(amount);
    });
    return out;
  } catch (_) {
    return {};
  }
}

function toMonthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function getEffectiveMonthlyBudget(settings, date = new Date()) {
  const globalBudget = Number(settings?.budget || 0);
  const overrides = parseMonthlyBudgets(settings?.monthly_budgets_text);
  const monthKey = toMonthKey(date);
  if (Object.prototype.hasOwnProperty.call(overrides, monthKey)) {
    return Number(overrides[monthKey] || 0);
  }
  return globalBudget;
}

function parseCategoryBudgetIntent(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  const clearMatch = text.match(/^(?:取消|刪除|清除|移除)(.+?)(?:分類)?預算$/);
  if (clearMatch) {
    return { action: 'clear', categoryRaw: String(clearMatch[1] || '').trim(), amount: null };
  }
  const clearAltMatch = text.match(/^(.+?)(?:分類)?預算(?:不設定|取消|清除|刪除)$/);
  if (clearAltMatch) {
    return { action: 'clear', categoryRaw: String(clearAltMatch[1] || '').trim(), amount: null };
  }
  const setMatch = text.match(/^(?:設定|設|把)?\s*(.+?)(?:分類)?預算(?:設為|改為|=|是|為)?\s*(\d+(?:\.\d+)?)$/);
  if (setMatch) {
    return {
      action: 'set',
      categoryRaw: String(setMatch[1] || '').trim(),
      amount: Math.round(Number(setMatch[2])),
    };
  }
  return null;
}

function parseReminderToggleIntent(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  if (!/提醒/.test(text)) return null;
  if (/(關閉|關掉|停用|不要|取消|停止|先不要)/.test(text)) {
    return { enabled: false };
  }
  if (/(開啟|打開|啟用|開始|恢復)/.test(text)) {
    return { enabled: true };
  }
  return null;
}

async function handleCategoryBudgetIntent(message, intent, channelSettings, allowedCategories) {
  const categoryRaw = String(intent?.categoryRaw || '').trim();
  if (!categoryRaw) return false;
  const normalizedInput = normalizeTagText(categoryRaw);
  const normalizedCategory = (allowedCategories || []).find((tag) => {
    const t = normalizeTagText(tag);
    return t === normalizedInput || t.includes(normalizedInput) || normalizedInput.includes(t);
  });
  if (!normalizedCategory) {
    await message.reply('⚠️ 我找不到對應的分類，請先在設定中建立分類後再試。');
    return true;
  }
  if (DEFAULT_INCOME_CATEGORY_SET.has(String(normalizedCategory || '').trim())) {
    await message.reply('⚠️ 分類預算目前僅支援「支出分類」，收入分類不需設定分類預算。');
    return true;
  }
  const categoryBudgets = parseCategoryBudgets(channelSettings?.category_budgets_text);
  const monthlyBudget = getEffectiveMonthlyBudget(channelSettings);

  if (intent.action === 'clear') {
    delete categoryBudgets[normalizedCategory];
    setChannelCategoryBudgets(message.channel.id, JSON.stringify(categoryBudgets));
    await message.reply(`✅ 已取消「${normalizedCategory}」的分類預算。`);
    return true;
  }

  const amount = Number(intent.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    await message.reply('⚠️ 分類預算金額需為正數。');
    return true;
  }

  categoryBudgets[normalizedCategory] = Math.round(amount);
  const total = Object.values(categoryBudgets).reduce((sum, v) => sum + Number(v || 0), 0);
  if (monthlyBudget > 0 && total > monthlyBudget) {
    await message.reply(
      `⚠️ 分類預算總和 NT$ ${total.toLocaleString()} 超過每月預算 NT$ ${monthlyBudget.toLocaleString()}，已取消本次設定。`
    );
    return true;
  }

  setChannelCategoryBudgets(message.channel.id, JSON.stringify(categoryBudgets));
  await message.reply(
    `✅ 已設定分類預算：${normalizedCategory} = NT$ ${Math.round(amount).toLocaleString()}\n` +
    `目前分類預算總和：NT$ ${total.toLocaleString()} / 月預算 NT$ ${monthlyBudget.toLocaleString()}`
  );
  return true;
}

async function handleCategoryRuleTeach(message, { keyword, category }, allowedCategories) {
  const kw = String(keyword || '').trim();
  const rawCat = String(category || '').trim();
  if (!kw || !rawCat) {
    await message.reply('⚠️ 請同時提供關鍵字與分類，例如：以後「星巴克」視為「餐飲」。');
    return;
  }
  if (kw.length > 40) {
    await message.reply('⚠️ 關鍵字請勿超過 40 字。');
    return;
  }
  const resolvedCat = resolveCategoryAgainstAllowed(rawCat, allowedCategories);
  if (!resolvedCat) {
    await sendEmbed(message, {
      title: '⚠️ 無法設定分類記憶',
      fields: [
        { name: '原因', value: `找不到分類「${rawCat}」`, inline: false },
        { name: '提示', value: '請使用你已設定的分類名稱（與 Dashboard 分類清單一致）。', inline: false },
      ],
    });
    return;
  }
  const current = getChannelSettings(message.channel.id);
  const existing = parseCategoryRulesText(current?.category_rules_text);
  const { rules } = upsertCategoryRule(existing, kw, resolvedCat);
  setChannelCategoryRules(message.channel.id, stringifyCategoryRules(rules));
  await sendEmbed(message, {
    title: '✅ 已記住分類偏好',
    fields: [
      { name: '關鍵字', value: kw, inline: true },
      { name: '分類', value: resolvedCat, inline: true },
      { name: '說明', value: '之後記帳內容若包含此關鍵字，會優先套用此分類（可覆蓋模型誤判）。', inline: false },
    ],
  });
}

async function handleReminderToggleIntent(message, intent, channelSettings) {
  if (!intent || typeof intent.enabled !== 'boolean') return false;
  const enabled = Boolean(intent.enabled);
  if (enabled && !String(channelSettings?.reminder_time || '').trim()) {
    await message.reply('⏰ 目前尚未設定提醒時間，請先設定例如：`提醒時間改成 21:30`。');
    return true;
  }
  setChannelReminderEnabled(message.channel.id, enabled);
  await sendEmbed(message, {
    title: '⏰ 提醒設定已更新',
    fields: [
      { name: '每日提醒', value: enabled ? '開啟' : '關閉', inline: true },
      { name: '提醒時間', value: String(channelSettings?.reminder_time || '未設定'), inline: true },
    ],
  });
  return true;
}

function buildProgressBar(ratio, width) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

function buildCategoryShareBar(rows, width = 20) {
  if (!Array.isArray(rows) || !rows.length) return '無分類資料';
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
    .map((count, idx) => getCategoryShareMarker(idx).repeat(count))
    .join('');
}

function getCategoryShareMarker(index) {
  const symbols = ['🟦', '🟩', '🟨', '🟧', '🟪', '🟥'];
  return symbols[Math.abs(Number(index || 0)) % symbols.length];
}

function parseSharedLedgerTransferIntent(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  if (!/(共同[帳账]本|共同[帳账]號|共[帳账])/.test(text)) return null;
  // 轉出/提領意圖需排除，避免誤判
  if (/(轉出|轉回|提領|領回|取出|拿出|領出)/.test(text)) return null;
  // 轉入/存入語意
  if (!/(添加|加到?|匯入|轉入|入帳|入账|轉到|放入|存入|加入|丟入|丟到|存到)/.test(text)) return null;
  const amountMatch = text.match(/(\d+(?:\.\d+)?)/);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount: Math.round(amount) };
}

function parseSharedLedgerPayoutIntent(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  if (!/(共同[帳账]本|共同[帳账]號|共[帳账])/.test(text)) return null;
  if (!/(轉出|轉回|轉給|匯給|提領|領回|取出|拿出|領出|從.*取|從.*拿)/.test(text)) return null;
  const amountMatch = text.match(/(\d+(?:\.\d+)?)/);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const targetMatch = text.match(/(?:轉給|匯給|轉回給?)\s*([^\d\s，,。!！?？]+)/);
  const targetRaw = targetMatch ? String(targetMatch[1] || '').trim() : '';
  const targetHint = normalizeTransferTargetName(targetRaw);
  return {
    amount: Math.round(amount),
    targetHint: targetHint || null,
    raw: text,
  };
}

function parsePersonalLedgerTransferIntent(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  if (/(共同[帳账]本|共同[帳账]號)/.test(text)) return null;
  // 避免把一般句子（例如「男朋友給我車費432」）誤判為轉帳
  if (!/^(轉給|轉帳給|匯給|給)\s*/.test(text)) return null;
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
    await message.reply('⚠️ 這個伺服器尚未設定共同帳本，請先使用 `/初始化-共同記帳`。');
    return true;
  }
  if (sharedChannelId === message.channel.id) {
    await message.reply('ℹ️ 目前頻道就是共同帳本，不需要再轉入。');
    return true;
  }

  const sharedSettings = getChannelSettings(sharedChannelId);
  if (!isChannelReadyForMessage(sharedSettings)) {
    await message.reply('⚠️ 共同帳本尚未完成初始化，請先在共同帳本頻道完成設定。');
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
    `轉入共同帳本`,
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

  const sourceBalance = getChannelMonthlyNet(message.channel.id);
  const sharedBalance = getChannelMonthlyNet(sharedChannelId);
  void updateChannelBalanceName(message.channel);
  try {
    const sharedChannel = await message.guild.channels.fetch(sharedChannelId);
    if (sharedChannel) void updateChannelBalanceName(sharedChannel);
  } catch (error) {
    console.log('共同帳本頻道更新失敗:', error.message);
  }

  await sendEmbed(message, {
    title: '🏦 轉入共同帳本成功',
    fields: [
      { name: '金額', value: `NT$ ${amount.toLocaleString()}`, inline: true },
      { name: '來源頻道當月結餘', value: `NT$ ${sourceBalance.toLocaleString()}`, inline: true },
      { name: '共同帳本當月結餘', value: `NT$ ${sharedBalance.toLocaleString()}`, inline: true },
      { name: '共同帳本頻道', value: `<#${sharedChannelId}>`, inline: false },
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
          { name: '共同帳本當月結餘', value: `NT$ ${sharedBalance.toLocaleString()}`, inline: true }
        )
        .setTimestamp();
      await sharedChannel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.log('共同帳本發送轉入通知失敗:', error.message);
  }
  return true;
}

async function handleSharedLedgerPayout(message, intent) {
  const guildId = message.guild?.id;
  if (!guildId) return false;
  const sharedChannelId = getGuildSharedLedgerChannelId(guildId);
  if (!sharedChannelId) {
    await message.reply('⚠️ 這個伺服器尚未設定共同帳本，請先使用 `/初始化-共同記帳`。');
    return true;
  }

  const sharedSettings = getChannelSettings(sharedChannelId);
  if (!isChannelReadyForMessage(sharedSettings)) {
    await message.reply('⚠️ 共同帳本尚未完成初始化，請先在共同帳本頻道完成設定。');
    return true;
  }

  const amount = Number(intent?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    await message.reply('⚠️ 轉出金額需為正數。');
    return true;
  }

  const guild = message.guild;
  const sourceBalance = getChannelNetBalance(sharedChannelId);
  if (sourceBalance < amount) {
    await message.reply(`⚠️ 共同帳本餘額不足（目前 NT$ ${sourceBalance.toLocaleString()}）。`);
    return true;
  }

  const sourceChannel = await guild.channels.fetch(sharedChannelId).catch(() => null);
  if (!sourceChannel) {
    await message.reply('⚠️ 無法讀取共同帳本頻道。');
    return true;
  }

  // 目標優先：明確指定對象 > 若在個人頻道發起則預設回到當前頻道
  let target = null;
  if (intent?.targetHint) {
    const matched = await findTargetPersonalLedgerChannels(guild, sharedChannelId, intent.targetHint);
    if (matched.length > 1) {
      const options = matched.slice(0, 5).map((item) => item.ledgerName).join('、');
      await message.reply(`⚠️ 找到多個相符帳本（${options}），請改用更精準稱呼。`);
      return true;
    }
    target = matched[0] || null;
  } else {
    const currentSettings = getChannelSettings(message.channel.id);
    if (String(currentSettings?.type || 'personal') === 'personal' && isChannelReadyForMessage(currentSettings)) {
      target = {
        channelId: message.channel.id,
        ledgerName: buildLedgerDisplayName(currentSettings, message.channel.name || '個人帳本'),
        channel: message.channel,
      };
    }
  }

  if (!target) {
    await message.reply('⚠️ 請指定要轉回的個人帳本，例如：「共同帳本轉給 CBC 2000」。');
    return true;
  }
  if (target.channelId === sharedChannelId) {
    await message.reply('ℹ️ 目標不能是共同帳本本身。');
    return true;
  }

  const actorName = String(message.member?.displayName || message.author?.username || '使用者');
  const { run } = require('../db/database');
  const nowIso = new Date().toISOString();
  run(`
    INSERT INTO transactions (channel_id, user_id, amount, category, note, type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    sharedChannelId,
    message.author.id,
    amount,
    '共同轉出',
    `轉給 ${target.ledgerName}（${actorName}）`,
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
    '共同轉入',
    `來自 共同帳本（${actorName}）`,
    'income',
    nowIso,
  ]);

  const sharedBalanceAfter = getChannelMonthlyNet(sharedChannelId);
  const targetBalanceAfter = getChannelMonthlyNet(target.channelId);
  void updateChannelBalanceName(sourceChannel);
  if (target.channel) void updateChannelBalanceName(target.channel);

  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const sharedDashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${sharedChannelId}`;
  const targetDashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${target.channelId}`;

  await sendEmbed(message, {
    title: '🏦 共同帳本轉出成功',
    fields: [
      { name: '目標帳本', value: target.ledgerName, inline: false },
      { name: '金額', value: `NT$ ${amount.toLocaleString()}`, inline: true },
      { name: '共同帳本當月結餘', value: `NT$ ${sharedBalanceAfter.toLocaleString()}`, inline: true },
      { name: '目標帳本當月結餘', value: `NT$ ${targetBalanceAfter.toLocaleString()}`, inline: true },
      { name: '共同 Dashboard', value: `[查看](${sharedDashboardUrl})`, inline: true },
      { name: '目標 Dashboard', value: `[查看](${targetDashboardUrl})`, inline: true },
    ],
  });

  // 在共同帳本頻道同步通知（若不是在共同頻道發起）
  if (sourceChannel.id !== message.channel.id && typeof sourceChannel.send === 'function') {
    try {
      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle('🏦 共同帳本已轉出')
        .addFields(
          { name: '對象', value: target.ledgerName, inline: false },
          { name: '金額', value: `-NT$ ${amount.toLocaleString()}`, inline: true },
          { name: '當月結餘', value: `NT$ ${sharedBalanceAfter.toLocaleString()}`, inline: true }
        )
        .setTimestamp();
      await sourceChannel.send({ embeds: [embed] });
    } catch (_) {
      // ignore
    }
  }

  // 在目標個人帳本頻道通知
  if (target.channel && typeof target.channel.send === 'function') {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🏦 收到共同帳本轉入')
        .addFields(
          { name: '來源', value: '共同帳本', inline: false },
          { name: '金額', value: `+NT$ ${amount.toLocaleString()}`, inline: true },
          { name: '當月結餘', value: `NT$ ${targetBalanceAfter.toLocaleString()}`, inline: true }
        )
        .setTimestamp();
      await target.channel.send({ embeds: [embed] });
    } catch (_) {
      // ignore
    }
  }

  return true;
}

async function handlePendingTransactionActionSelection(message, content) {
  const key = `${message.channel.id}:${message.author.id}`;
  const pending = pendingTransactionActions.get(key);
  if (!pending) return false;
  if (Date.now() > Number(pending.expiresAt || 0)) {
    pendingTransactionActions.delete(key);
    await message.reply('⌛ 操作已逾時，請重新說一次要刪除或修改哪筆記錄。');
    return true;
  }

  const text = String(content || '').trim();
  if (/^(取消|算了|不要了)$/i.test(text)) {
    pendingTransactionActions.delete(key);
    await message.reply('✅ 已取消這次刪除/修改操作。');
    return true;
  }

  const idMatch = text.match(/^#?(\d{1,10})$/);
  const byReferenceKeyword = /^(這個|這筆|這條|這一筆)$/i.test(text);
  const referencedId = byReferenceKeyword ? await resolveReferencedTransactionId(message) : null;
  const txId = idMatch ? Number(idMatch[1]) : (referencedId || null);
  if (!txId) {
    await message.reply('請直接回覆要操作的 `id`（例如 `123`），或回覆目標訊息後輸入「這個」，或輸入「取消」。');
    return true;
  }

  if (!pending.candidateIds.includes(txId)) {
    await message.reply('⚠️ 這個 id 不在候選列表中，請回覆列表內的 id。');
    return true;
  }

  const result = executeTransactionActionById(message.channel.id, txId, pending);
  pendingTransactionActions.delete(key);
  if (!result || !result.success) {
    await message.reply(`⚠️ 操作失敗：${result?.error || '未知錯誤'}`);
    return true;
  }

  await sendTransactionActionSuccessEmbed(message, pending.action, result.before, result.after);
  void updateChannelBalanceName(message.channel);
  return true;
}

async function parseTransactionManagementIntent(message, content, allowedCategories = []) {
  const text = String(content || '').trim();
  if (!text) return null;
  const referencedId = await resolveReferencedTransactionId(message);

  const hasManagementCue = /(刪除|刪掉|删除|移除|修改|更改|調整|改成|改為|更正|修正|預算|不計|不要計|不算|排除|計入|納入|恢復|取消排除)/.test(text);
  const hasReplyReference = Boolean(referencedId && message?.reference?.messageId);
  if (!hasManagementCue && !hasReplyReference) return null;

  const llmPlan = await planTransactionActionWithLLM(text, {
    allowedCategories,
    referencedId,
  });

  const actionFromRegex = /(刪除|刪掉|删除|移除)/.test(text)
    ? 'delete'
    : (/(修改|更改|調整|改成|改為|更正|修正)/.test(text) ? 'update' : null);
  const validLlmActions = new Set(['delete', 'update', 'exclude_budget', 'include_budget']);
  const llmAction = validLlmActions.has(llmPlan?.action) ? llmPlan.action : null;
  const action = llmAction || actionFromRegex;
  if (!action) return null;
  const id = extractTransactionIdFromText(text) || llmPlan?.id || referencedId || null;
  const rangePreset = inferRangePresetFromText(text);
  const categoryFilter = extractCategoryFilterFromText(text, allowedCategories);
  const typeFilter = /(收入|income)/i.test(text) ? 'income' : /(支出|expense)/i.test(text) ? 'expense' : null;
  const regexUpdates = action === 'update' ? extractTransactionUpdatesFromText(text, allowedCategories) : {};
  const llmUpdates = normalizeLlmManagementUpdates(llmPlan?.updates, allowedCategories);
  const updates = action === 'update'
    ? { ...llmUpdates, ...regexUpdates }
    : {};

  return {
    action,
    id,
    filters: {
      rangePreset,
      category: categoryFilter,
      type: typeFilter,
    },
    updates,
    needsClarification: Boolean(llmPlan?.needsClarification),
    followUpQuestion: llmPlan?.followUpQuestion || null,
    referencedId: referencedId || null,
    rawText: text,
  };
}

async function handleTransactionManagementIntent(message, intent) {
  if (intent.action === 'exclude_budget' || intent.action === 'include_budget') {
    const txId = Number(intent.id || 0);
    if (!txId) {
      await message.reply('⚠️ 找不到對應的記帳條目，請回覆正確的記帳訊息。');
      return true;
    }
    const tx = getTransactionById(message.channel.id, txId);
    const isIncome = tx?.type === 'income';
    const flagValue = intent.action === 'exclude_budget';
    setTransactionExcludeFromBudget(message.channel.id, txId, flagValue);
    void updateChannelBalanceName(message.channel);
    if (isIncome) {
      await message.reply(flagValue
        ? `💰 已將收入 ID ${txId} 計入預算抵消（可減少預算消耗）。`
        : `✅ 已取消收入 ID ${txId} 的預算抵消。`
      );
    } else {
      await message.reply(flagValue
        ? `🚫 已將 ID ${txId} 排除於預算計算外（仍記錄在帳本中）。`
        : `✅ 已將 ID ${txId} 重新納入預算計算。`
      );
    }
    return true;
  }

  if (intent?.needsClarification && intent?.followUpQuestion && !intent.id && !Object.keys(intent.updates || {}).length) {
    await message.reply(intent.followUpQuestion);
    return true;
  }

  if (intent.action === 'update' && !intent.id && !Object.keys(intent.updates || {}).length) {
    await message.reply('⚠️ 請提供要修改的內容，例如：`修改 id 123 金額 200 類型 支出`');
    return true;
  }
  if (intent.action === 'update' && intent.id && !Object.keys(intent.updates || {}).length) {
    await message.reply('⚠️ 你有指定要修改的條目，但還沒提供修改內容。可說：`改成 70`、`分類改成 交通`、`備註改成 Uber`。');
    return true;
  }

  if (intent.id) {
    const result = executeTransactionActionById(message.channel.id, intent.id, intent);
    if (!result || !result.success) {
      await message.reply(`⚠️ 操作失敗：${result?.error || '找不到指定 id 或資料格式錯誤'}`);
      return true;
    }
    await sendTransactionActionSuccessEmbed(message, intent.action, result.before, result.after);
    void updateChannelBalanceName(message.channel);
    return true;
  }

  // 口語修正捷徑：例如「等等不對，改成70」自動套用到同頻道本人最近一筆交易
  if (intent.action === 'update' && !intent.id) {
    const autoHandled = await tryAutoApplyLatestTransactionUpdate(message, intent);
    if (autoHandled) return true;
  }

  const candidates = getCandidateTransactionsForIntent(message.channel.id, intent);
  if (!candidates.length) {
    await message.reply('找不到符合條件的條目，請換個分類/時間條件再試。');
    return true;
  }

  const embed = buildTransactionSelectionEmbed(intent, candidates);
  const key = `${message.channel.id}:${message.author.id}`;
  pendingTransactionActions.set(key, {
    action: intent.action,
    updates: intent.updates || {},
    candidateIds: candidates.map((tx) => Number(tx.id)),
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  await message.reply({ embeds: [embed] });
  return true;
}

function extractTransactionIdFromText(text) {
  const byLabel = text.match(/(?:id|編號)\s*#?(\d{1,10})/i);
  if (byLabel) return Number(byLabel[1]);
  const byHash = text.match(/#(\d{1,10})/);
  if (byHash) return Number(byHash[1]);
  const byAction = text.match(/(?:刪除|刪掉|删除|移除|修改|更改|調整)\s*#?(\d{1,10})/);
  if (byAction) return Number(byAction[1]);
  return null;
}

function normalizeLlmManagementUpdates(updates, allowedCategories = []) {
  if (!updates || typeof updates !== 'object') return {};
  const normalized = {};
  const amount = Number(updates.amount);
  if (Number.isFinite(amount) && amount >= 0) normalized.amount = Math.round(amount);
  const typeText = String(updates.type || '').toLowerCase();
  if (typeText === 'income' || typeText === 'expense') normalized.type = typeText;
  if (typeof updates.note === 'string') normalized.note = String(updates.note).trim();
  if (typeof updates.category === 'string') {
    const target = extractCategoryFilterFromText(String(updates.category), allowedCategories);
    if (target) normalized.category = target;
  }
  return normalized;
}

async function resolveReferencedTransactionId(message) {
  const refId = message?.reference?.messageId;
  if (!refId || !message?.channel?.messages?.fetch) return null;
  try {
    const ref = await message.channel.messages.fetch(refId);
    if (!ref) return null;

    const direct = extractTransactionIdFromText(String(ref.content || ''));
    if (direct) return direct;

    const embeds = Array.isArray(ref.embeds) ? ref.embeds : [];
    for (const embed of embeds) {
      const fields = Array.isArray(embed.fields) ? embed.fields : [];
      for (const field of fields) {
        const fieldName = String(field?.name || '').toLowerCase();
        const fieldValue = String(field?.value || '');
        if (fieldName.includes('id')) {
          const byField = extractTransactionIdFromText(fieldValue);
          if (byField) return byField;
          const numberOnly = fieldValue.match(/^\s*(\d{1,10})\s*$/);
          if (numberOnly) return Number(numberOnly[1]);
        }
      }
      const byDesc = extractTransactionIdFromText(String(embed.description || ''));
      if (byDesc) return byDesc;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function inferRangePresetFromText(text) {
  if (/今天/.test(text)) return 'today';
  if (/昨天/.test(text)) return 'yesterday';
  if (/本月|這個月/.test(text)) return 'this_month';
  if (/上月|上個月/.test(text)) return 'last_month';
  return null;
}

function extractCategoryFilterFromText(text, allowedCategories = []) {
  const match = allowedCategories.find((tag) => {
    const normalizedTag = normalizeTagText(tag);
    return normalizedTag && normalizeTagText(text).includes(normalizedTag);
  });
  return match || null;
}

function extractTransactionUpdatesFromText(text, allowedCategories = []) {
  const updates = {};
  const amountMatch = text.match(/金額(?:改成|改為|為)?\s*([+-]?\d+(?:\.\d+)?)/);
  if (amountMatch) {
    const amount = Number(amountMatch[1]);
    if (Number.isFinite(amount) && amount >= 0) updates.amount = Math.round(amount);
  }
  if (updates.amount === undefined) {
    const quickAmountMatch = text.match(/(?:改成|改為|更正成|更正為|修正成|修正為)\s*([+-]?\d+(?:\.\d+)?)/);
    if (quickAmountMatch) {
      const amount = Number(quickAmountMatch[1]);
      if (Number.isFinite(amount) && amount >= 0) updates.amount = Math.round(amount);
    }
  }

  const noteMatch = text.match(/備註(?:改成|改為|為)?\s*(.+)$/);
  if (noteMatch) {
    updates.note = String(noteMatch[1] || '').trim();
  }

  const typeMatch = text.match(/類型(?:改成|改為|為)?\s*(收入|支出|income|expense)/i);
  if (typeMatch) {
    const v = typeMatch[1].toLowerCase();
    updates.type = (v === '收入' || v === 'income') ? 'income' : 'expense';
  }

  const categoryMatch = text.match(/分類(?:改成|改為|為)?\s*([^\s，,。!！?？]+)/);
  if (categoryMatch) {
    const target = extractCategoryFilterFromText(String(categoryMatch[1] || ''), allowedCategories);
    if (target) updates.category = target;
  }
  return updates;
}

function isQuickCorrectionPhrase(text) {
  const source = String(text || '');
  if (!source) return false;
  if (!/(改成|改為|更正|修正)/.test(source)) return false;
  return /(等等|不對|打錯|寫錯|剛剛|上一筆|這筆|改一下|改成)/.test(source);
}

async function tryAutoApplyLatestTransactionUpdate(message, intent) {
  const updates = intent?.updates || {};
  if (!Object.keys(updates).length) return false;
  if (!isQuickCorrectionPhrase(intent?.rawText || '')) return false;

  const { get } = require('../db/database');
  const latest = get(`
    SELECT id, amount, category, note, type, timestamp
    FROM transactions
    WHERE channel_id = ?
      AND user_id = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `, [message.channel.id, message.author.id]);
  if (!latest?.id) return false;

  const latestTime = new Date(latest.timestamp);
  const ageMs = Number.isNaN(latestTime.getTime()) ? Number.POSITIVE_INFINITY : (Date.now() - latestTime.getTime());
  if (ageMs > 30 * 60 * 1000) return false;

  if (intent?.filters?.type && String(latest.type || '') !== String(intent.filters.type)) return false;
  if (intent?.filters?.category && String(latest.category || '') !== String(intent.filters.category)) return false;

  const patchedIntent = { ...intent, id: Number(latest.id) };
  const result = executeTransactionActionById(message.channel.id, Number(latest.id), patchedIntent);
  if (!result || !result.success) {
    await message.reply(`⚠️ 自動修正失敗：${result?.error || '未知錯誤'}`);
    return true;
  }

  await message.reply(`ℹ️ 已自動套用到你最近一筆交易（ID ${latest.id}）。`);
  await sendTransactionActionSuccessEmbed(message, 'update', result.before, result.after);
  void updateChannelBalanceName(message.channel);
  return true;
}

function getCandidateTransactionsForIntent(channelId, intent) {
  const { all } = require('../db/database');
  let rows = all(`
    SELECT id, amount, category, note, type, timestamp
    FROM transactions
    WHERE channel_id = ?
    ORDER BY timestamp DESC
    LIMIT 120
  `, [channelId]).map((row) => ({
    id: Number(row.id),
    amount: Number(row.amount || 0),
    category: row.category || '未分類',
    note: row.note || '',
    type: row.type === 'income' ? 'income' : 'expense',
    timestamp: row.timestamp,
  }));

  const preset = intent?.filters?.rangePreset;
  if (preset) {
    const range = getRangeFromPreset(preset);
    if (range) {
      rows = rows.filter((tx) => String(tx.timestamp || '') >= range.startIso && String(tx.timestamp || '') < range.endIso);
    }
  }
  if (intent?.filters?.category) {
    rows = rows.filter((tx) => String(tx.category || '') === String(intent.filters.category));
  }
  if (intent?.filters?.type) {
    rows = rows.filter((tx) => tx.type === intent.filters.type);
  }
  return rows.slice(0, 10);
}

function buildTransactionSelectionEmbed(intent, candidates) {
  const verb = intent.action === 'delete' ? '刪除' : '修改';
  const lines = candidates.map((tx) => {
    const date = formatDateTimeTextShort(tx.timestamp);
    const sign = tx.type === 'income' ? '+' : '-';
    return `ID ${tx.id}｜${date}｜${tx.category}｜${sign}NT$ ${tx.amount.toLocaleString()}｜${(tx.note || '-').slice(0, 20)}`;
  });
  return new EmbedBuilder()
    .setColor(intent.action === 'delete' ? 0xe67e22 : 0x3498db)
    .setTitle(`🧾 請選擇要${verb}的條目`)
    .setDescription(lines.join('\n'))
    .addFields({
      name: '回覆方式',
      value: '請直接回覆 `id`（例如：`123`），或輸入「取消」。',
      inline: false,
    })
    .setTimestamp();
}

function executeTransactionActionById(channelId, txId, intentLike) {
  const { get, run } = require('../db/database');
  const before = get(`
    SELECT id, amount, category, note, type, timestamp
    FROM transactions
    WHERE channel_id = ? AND id = ?
  `, [channelId, Number(txId)]);
  if (!before) return { success: false, error: '找不到該筆交易' };

  if (intentLike.action === 'delete') {
    run(`DELETE FROM transactions WHERE channel_id = ? AND id = ?`, [channelId, Number(txId)]);
    return { success: true, before, after: null };
  }

  const updates = intentLike.updates || {};
  const nextAmount = Number(updates.amount ?? before.amount);
  if (!Number.isFinite(nextAmount) || nextAmount < 0) {
    return { success: false, error: '更新金額無效' };
  }
  const nextCategory = String(updates.category ?? before.category ?? '未分類');
  const nextNote = String(updates.note ?? before.note ?? '');
  const nextType = updates.type === 'income' ? 'income' : updates.type === 'expense' ? 'expense' : before.type;
  run(`
    UPDATE transactions
    SET amount = ?, category = ?, note = ?, type = ?
    WHERE channel_id = ? AND id = ?
  `, [nextAmount, nextCategory, nextNote, nextType, channelId, Number(txId)]);
  const after = get(`
    SELECT id, amount, category, note, type, timestamp
    FROM transactions
    WHERE channel_id = ? AND id = ?
  `, [channelId, Number(txId)]);
  return { success: true, before, after };
}

async function sendTransactionActionSuccessEmbed(message, action, before, after) {
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
  const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${message.channel.id}`;
  if (action === 'delete') {
    await sendEmbed(message, {
      title: '🗑️ 刪除成功',
      fields: [
        { name: 'ID', value: String(before?.id || ''), inline: true },
        { name: '金額', value: `${before?.type === 'income' ? '+' : '-'}NT$ ${Number(before?.amount || 0).toLocaleString()}`, inline: true },
        { name: '分類', value: String(before?.category || '未分類'), inline: true },
        { name: '備註', value: String(before?.note || '-'), inline: false },
        { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false },
      ],
    });
    return;
  }
  const beforeAmount = Number(before?.amount || 0);
  const afterAmount = Number(after?.amount || 0);
  const beforeCategory = String(before?.category || '未分類');
  const afterCategory = String(after?.category || '未分類');
  const beforeNote = String(before?.note || '-');
  const afterNote = String(after?.note || '-');

  const changedFields = [];
  if (beforeAmount !== afterAmount) {
    changedFields.push({ name: '金額', value: `${beforeAmount} -> ${afterAmount}`, inline: true });
  }
  if (beforeCategory !== afterCategory) {
    changedFields.push({ name: '分類', value: `${beforeCategory} -> ${afterCategory}`, inline: true });
  }
  if (beforeNote !== afterNote) {
    changedFields.push({ name: '備註', value: `${beforeNote} -> ${afterNote}`, inline: false });
  }

  await sendEmbed(message, {
    title: '✏️ 修改成功',
    fields: [
      { name: 'ID', value: String(after?.id || before?.id || ''), inline: true },
      ...changedFields,
      ...(changedFields.length ? [] : [{ name: '說明', value: '本次沒有實際變更。', inline: false }]),
      { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false },
    ],
  });
}

function formatDateTimeTextShort(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return String(timestamp || '-');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hh}:${mm}`;
}

function formatDateTimeForDisplay(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return String(timestamp || '-');
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${day} ${hh}:${mm}`;
}

async function handlePersonalLedgerTransfer(message, transfer) {
  const { amount, targetHint } = transfer || {};
  if (!amount || !targetHint) return false;

  const guild = message.guild;
  if (!guild) return false;

  const sourceSettings = getChannelSettings(message.channel.id);
  const sourceLedgerName = buildLedgerDisplayName(sourceSettings, message.channel.name || '來源帳本');
  const actorName = String(sourceSettings?.user_title || message.member?.displayName || message.author?.username || '使用者');

  const matched = await findTargetPersonalLedgerChannels(guild, message.channel.id, targetHint);
  if (!matched.length) {
    await message.reply(`⚠️ 找不到「${targetHint}」對應的個人帳本，請確認對方已完成初始化且稱呼正確。`);
    return true;
  }
  if (matched.length > 1) {
    const options = matched.slice(0, 5).map((item) => item.ledgerName).join('、');
    await message.reply(`⚠️ 找到多個相符帳本（${options}），請改用更精準稱呼。`);
    return true;
  }

  const target = matched[0];
  if (target.channelId === message.channel.id) {
    await message.reply('ℹ️ 你指定的是目前這個帳本，不需要轉帳。');
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

  const sourceBalance = getChannelMonthlyNet(message.channel.id);
  const targetBalance = getChannelMonthlyNet(target.channelId);
  void updateChannelBalanceName(message.channel);
  if (target.channel) {
    void updateChannelBalanceName(target.channel);
  }

  await sendEmbed(message, {
    title: '💸 轉帳成功',
    fields: [
      { name: '轉入目標', value: target.ledgerName, inline: false },
      { name: '金額', value: `NT$ ${amount.toLocaleString()}`, inline: true },
      { name: '來源帳本當月結餘', value: `NT$ ${sourceBalance.toLocaleString()}`, inline: true },
      { name: '目標帳本當月結餘', value: `NT$ ${targetBalance.toLocaleString()}`, inline: true },
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
          { name: '當月結餘', value: `NT$ ${targetBalance.toLocaleString()}`, inline: true }
        )
        .setTimestamp();
      await target.channel.send({ embeds: [embed] });
    } catch (error) {
      console.log('目標個人帳本發送轉入通知失敗:', error.message);
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
        ledgerName: `${title}的帳本`,
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
    .replace(/(的)?(個人)?[帳账](本|戶|號)$/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function buildLedgerDisplayName(settings, fallbackName = '來源帳本') {
  const type = String(settings?.type || 'personal');
  if (type === 'shared') return '共同帳本';
  const title = String(settings?.user_title || '').trim();
  if (title) return `${title}的帳本`;
  const fallback = String(fallbackName || '')
    .trim()
    .replace(/_[+-]?\d+$/, '');
  return fallback || '個人帳本';
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

async function fetchRecentDialogueForLLM(message, limit = 10) {
  try {
    if (!message?.channel?.id) return [];
    const history = await getDialogueEntries(message.channel.id);
    const rows = history
      .filter((item) => item && item.messageId !== message.id)
      .slice(-Math.max(1, limit))
      .map((item) => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: String(item.content || ''),
      }))
      .filter((item) => item.content);
    if (rows.length > 0) return rows;

    // 只有本地無已保存對話時，才回退即時抓取 Discord 頻道訊息
    const liveRows = await fetchRecentDialogueFromChannel(message, limit);
    if (!liveRows.length) return [];
    for (const item of liveRows) {
      void appendDialogueTurn(message.channel.id, {
        role: item.role,
        content: item.content,
        speakerId: item.speakerId,
        messageId: item.messageId,
        timestamp: item.timestamp,
      });
    }
    return liveRows.map((item) => ({ role: item.role, content: item.content }));
  } catch (_) {
    return [];
  }
}

async function fetchRecentDialogueFromChannel(message, limit = 10) {
  try {
    if (!message?.channel || typeof message.channel.messages?.fetch !== 'function') return [];
    const fetched = await message.channel.messages.fetch({ limit: Math.max(10, limit + 6) });
    return Array.from(fetched.values())
      .filter((msg) => msg.id !== message.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((msg) => {
        const plain = String(msg.content || '').trim();
        const embedTitle = String(msg.embeds?.[0]?.title || '').trim();
        const embedDesc = String(msg.embeds?.[0]?.description || '').trim();
        const text = normalizeDialogueContent(plain || [embedTitle, embedDesc].filter(Boolean).join(' - '));
        if (!text) return null;
        return {
          role: msg.author?.bot ? 'assistant' : 'user',
          content: text,
          speakerId: msg.author?.id || null,
          messageId: msg.id,
          timestamp: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date(msg.createdTimestamp || Date.now()).toISOString(),
        };
      })
      .filter(Boolean)
      .slice(-Math.max(1, limit));
  } catch (_) {
    return [];
  }
}

async function ensureDialogueHistoryDir() {
  if (!ensureDialogueDirPromise) {
    ensureDialogueDirPromise = fsp.mkdir(DIALOGUE_HISTORY_DIR, { recursive: true }).catch(() => {});
  }
  await ensureDialogueDirPromise;
}

function getDialogueHistoryFilePath(channelId) {
  return path.join(DIALOGUE_HISTORY_DIR, `${channelId}.jsonl`);
}

function normalizeDialogueContent(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

async function getDialogueEntries(channelId) {
  const key = String(channelId || '');
  const cached = recentDialogueCache.get(key);
  if (cached) return cached.entries;

  await ensureDialogueHistoryDir();
  const filePath = getDialogueHistoryFilePath(key);
  let rows = [];
  try {
    if (fs.existsSync(filePath)) {
      const raw = await fsp.readFile(filePath, 'utf8');
      rows = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-DIALOGUE_CACHE_LIMIT);
    }
  } catch (_) {
    rows = [];
  }
  recentDialogueCache.set(key, { entries: rows });
  return rows;
}

function queueDialogueWrite(channelId, task) {
  const key = String(channelId || '');
  const prev = dialogueWriteQueues.get(key) || Promise.resolve();
  const next = prev
    .then(task)
    .catch(() => {});
  dialogueWriteQueues.set(key, next);
}

async function appendDialogueTurn(channelId, turn) {
  const key = String(channelId || '');
  if (!key) return;
  const content = normalizeDialogueContent(turn?.content);
  if (!content) return;

  const entry = {
    role: turn?.role === 'assistant' ? 'assistant' : 'user',
    content,
    speakerId: turn?.speakerId || null,
    messageId: turn?.messageId || null,
    timestamp: turn?.timestamp || new Date().toISOString(),
  };
  const rows = await getDialogueEntries(key);
  rows.push(entry);
  if (rows.length > DIALOGUE_CACHE_LIMIT) {
    rows.splice(0, rows.length - DIALOGUE_CACHE_LIMIT);
  }

  queueDialogueWrite(key, async () => {
    await ensureDialogueHistoryDir();
    const filePath = getDialogueHistoryFilePath(key);
    await fsp.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  });
}

function patchOutgoingTrackers(message) {
  if (!message || message.__dialogueTrackerPatched) return;
  message.__dialogueTrackerPatched = true;

  const originalReply = typeof message.reply === 'function' ? message.reply.bind(message) : null;
  if (originalReply) {
    message.reply = async (payload, ...rest) => {
      const sent = await originalReply(payload, ...rest);
      const text = extractOutgoingText(payload);
      if (text) {
        void appendDialogueTurn(message.channel.id, {
          role: 'assistant',
          content: text,
          speakerId: message.client?.user?.id || 'bot',
          messageId: sent?.id || null,
          timestamp: new Date().toISOString(),
        });
      }
      return sent;
    };
  }

  const channel = message.channel;
  const originalSend = channel && typeof channel.send === 'function' ? channel.send.bind(channel) : null;
  if (originalSend) {
    channel.send = async (payload, ...rest) => {
      const sent = await originalSend(payload, ...rest);
      const text = extractOutgoingText(payload);
      if (text) {
        void appendDialogueTurn(message.channel.id, {
          role: 'assistant',
          content: text,
          speakerId: message.client?.user?.id || 'bot',
          messageId: sent?.id || null,
          timestamp: new Date().toISOString(),
        });
      }
      return sent;
    };
  }
}

function extractOutgoingText(payload) {
  if (typeof payload === 'string') return normalizeDialogueContent(payload);
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  if (typeof payload.content === 'string') parts.push(payload.content);
  const embeds = Array.isArray(payload.embeds) ? payload.embeds : [];
  embeds.forEach((embed) => {
    if (!embed) return;
    const title = String(embed.title || embed.data?.title || '').trim();
    const description = String(embed.description || embed.data?.description || '').trim();
    if (title) parts.push(title);
    if (description) parts.push(description);
    const fields = Array.isArray(embed.fields || embed.data?.fields) ? (embed.fields || embed.data?.fields) : [];
    fields.slice(0, 3).forEach((f) => {
      const n = String(f?.name || '').trim();
      const v = String(f?.value || '').trim();
      if (!n && !v) return;
      parts.push(`${n}${n && v ? ':' : ''}${v}`);
    });
  });
  return normalizeDialogueContent(parts.join(' | '));
}

module.exports = { handleMessage, paginationSessions, buildPageRow };
