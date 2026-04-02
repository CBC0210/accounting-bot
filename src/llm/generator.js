async function fetchCompat(url, options) {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(url, options);
  }
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch(url, options);
}

function buildAuthCandidates(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return [];
  const candidates = [];
  if (key.toLowerCase().startsWith('bearer ')) {
    candidates.push(key);
    candidates.push(key.slice(7).trim());
  } else {
    candidates.push(`Bearer ${key}`);
    candidates.push(key);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function extractRawApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return '';
  return key.toLowerCase().startsWith('bearer ') ? key.slice(7).trim() : key;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function resolveAnthropicBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return '';
  if (normalized.endsWith('/anthropic')) return normalized;
  if (normalized.endsWith('/v1')) return normalized.replace(/\/v1$/, '/anthropic');
  return `${normalized}/anthropic`;
}

function getTextFromAnthropicContent(content) {
  if (!Array.isArray(content)) return null;
  const textBlocks = content
    .filter((block) => block && (
      (block.type === 'text' && typeof block.text === 'string')
      || (typeof block.text === 'string')
    ))
    .map((block) => block.text.trim())
    .filter(Boolean);
  return textBlocks.length ? textBlocks.join('\n') : null;
}

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_API_STYLE = process.env.MINIMAX_API_STYLE || 'anthropic';
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.5';
const MINIMAX_STANDARD_BASE_URL = process.env.MINIMAX_STANDARD_BASE_URL || 'https://api.minimax.io';
const MINIMAX_STANDARD_MODEL = process.env.MINIMAX_STANDARD_MODEL || 'M2-her';

async function callMiniMaxAnthropic(prompt, systemPrompt) {
  const baseUrl = resolveAnthropicBaseUrl(MINIMAX_BASE_URL);
  const rawKey = extractRawApiKey(MINIMAX_API_KEY);
  if (!baseUrl || !rawKey) return null;

  const response = await fetchCompat(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': rawKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      max_tokens: 1024,
      temperature: 0.1,
      // 嘗試關閉思考模式，避免只回傳 thinking 區塊導致無法解析
      thinking: { type: 'disabled' },
      system: systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    }),
  });

  const data = await response.json();
  const statusCode = data?.base_resp?.status_code ?? null;
  const success = response.ok && (statusCode === null || statusCode === 0);
  if (!success) {
    console.error('MiniMax Anthropic API Error:', response.status, data);
    return null;
  }

  const text = getTextFromAnthropicContent(data?.content);
  if (!text) {
    console.error('MiniMax Anthropic API 無可用文字內容:', data);
    return null;
  }
  return text;
}

async function callMiniMaxStandard(prompt, systemPrompt) {
  const baseUrl = normalizeBaseUrl(MINIMAX_STANDARD_BASE_URL);
  const authCandidates = buildAuthCandidates(MINIMAX_API_KEY);
  let lastData = null;
  let lastStatus = null;

  for (const authValue of authCandidates) {
    const response = await fetchCompat(`${baseUrl}/v1/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authValue,
      },
      body: JSON.stringify({
        model: MINIMAX_STANDARD_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const data = await response.json();
    lastData = data;
    lastStatus = response.status;
    const statusCode = data?.base_resp?.status_code ?? null;
    const success = response.ok && (statusCode === null || statusCode === 0);
    if (!success) continue;

    const content = data?.choices?.[0]?.message?.content || data?.reply || null;
    if (content) return content;
  }

  if (lastStatus !== null) {
    console.error('MiniMax Standard API Error:', lastStatus, lastData);
  }
  return null;
}

async function callMiniMax(prompt, systemPrompt = '你是一個記帳機器人助手，會調侃使用者，風格簡短有趣') {
  if (!MINIMAX_API_KEY) {
    console.log('沒有 MiniMax API Key');
    return null;
  }

  try {
    if (MINIMAX_API_STYLE === 'anthropic') {
      const anthropicResult = await callMiniMaxAnthropic(prompt, systemPrompt);
      if (anthropicResult) return anthropicResult;
      // anthropic 解析失敗時，嘗試標準端點，提升穩定性
      const standardResult = await callMiniMaxStandard(prompt, systemPrompt);
      if (standardResult) return standardResult;
      return null;
    }
    if (MINIMAX_API_STYLE === 'standard') {
      return await callMiniMaxStandard(prompt, systemPrompt);
    }

    const anthropicResult = await callMiniMaxAnthropic(prompt, systemPrompt);
    if (anthropicResult) return anthropicResult;

    const standardResult = await callMiniMaxStandard(prompt, systemPrompt);
    if (standardResult) return standardResult;

    console.error('MiniMax API Error: auto mode both endpoints failed');
    return null;
  } catch (error) {
    console.error('MiniMax API Error:', error);
    return null;
  }
}

function sanitizeShortReply(text) {
  let value = String(text || '').trim();
  if (!value) return '';
  // 移除模型可能外露的 think 區塊（含大小寫與多行）
  value = value
    .replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, '')
    .replace(/&lt;\s*think\s*&gt;[\s\S]*?&lt;\s*\/\s*think\s*&gt;/gi, '')
    .trim();
  // 移除模型偶爾附帶的字數註記，例如： （14字）
  value = value.replace(/\s*[（(]\s*\d+\s*字\s*[）)]\s*$/u, '').trim();
  // 移除整句外層引號
  if (
    (value.startsWith('「') && value.endsWith('」'))
    || (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('“') && value.endsWith('”'))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

async function generateResponse(transaction, balance, context = {}) {
  const budget = Number(context.budget || 0);
  const monthlySpent = Number(context.monthlySpent || 0);
  const budgetUsage = budget > 0 ? Math.round((monthlySpent / budget) * 100) : null;
  const styleTags = Array.isArray(context.styleTags) ? context.styleTags.filter(Boolean) : [];
  const styleHint = styleTags.length ? styleTags.join('、') : '輕鬆、自然';
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthProgress = daysInMonth > 0 ? day / daysInMonth : 0;
  const monthProgressPercent = Math.round(monthProgress * 100);
  const expectedSpendByToday = budget > 0 ? Math.round(budget * monthProgress) : null;
  const budgetPaceDelta = expectedSpendByToday !== null ? monthlySpent - expectedSpendByToday : null;

  const prompt = `使用者記錄了一筆消費：
- 類型：${transaction.type}
- 金額：NT$ ${transaction.amount}
- 分類：${transaction.category}
- 備註：${transaction.note || '無'}
- 餘額：NT$ ${balance}
- 每月預算：${budget > 0 ? `NT$ ${budget}` : '未設定'}
- 本月已支出：NT$ ${monthlySpent}
- 預算使用率：${budgetUsage === null ? '未知' : `${budgetUsage}%`}
- 對話風格標籤：${styleHint}
- 當前日期：${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}
- 本月進度：第 ${day} / ${daysInMonth} 天（約 ${monthProgressPercent}%）
- 依月進度推估今天合理累積支出：${expectedSpendByToday === null ? '未知' : `NT$ ${expectedSpendByToday}`}
- 與合理累積支出的差距：${budgetPaceDelta === null ? '未知' : `NT$ ${budgetPaceDelta >= 0 ? '+' : ''}${budgetPaceDelta}`}

請給出一句簡短有趣的回應（不超過20字），可以調侃或關心。

規則：
1) 主要依據「預算使用率」給回饋（節制/超支/健康）。
2) 餘額只能當次要參考，不要用餘額當主要調侃點。
3) 必須結合「本月時間進度」判斷，不可忽略現在是月初或月底。
4) 月初低使用率是合理現象，不要硬酸太省；月底低使用率才可輕鬆調侃。
5) 若預算未設定，提醒可先設定預算（語氣輕鬆）。`;

  const response = await callMiniMax(prompt);
  if (response) {
    const cleaned = sanitizeShortReply(response);
    if (cleaned) return cleaned;
  }

  const responses = ['記好了', 'OK', '收到', '行'];
  return responses[Math.floor(Math.random() * responses.length)];
}

async function parseWithLLM(content) {
  const prompt = `分析以下訊息是否是記帳指令，如果是請解析出金額、分類、類型（expense/income）和備註：

訊息：${content}

請用以下 JSON 格式回覆，如果不是記帳指令回覆 null：
{"amount": 數字, "type": "expense"或"income", "category": "分類", "note": "備註"}`;

  try {
    const response = await callMiniMax(prompt, '你是一個JSON解析器，只回覆JSON不要其他文字');
    const match = response && response.match(/\{[\s\S]*\}/);
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

function safeParseJsonFromText(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    return null;
  }
}

async function parseTransactionFromImageWithLLM(imageUrl, context = {}) {
  const rawKey = extractRawApiKey(MINIMAX_API_KEY);
  const baseUrl = resolveAnthropicBaseUrl(MINIMAX_BASE_URL);
  if (!imageUrl || !rawKey || !baseUrl) return null;

  try {
    const imageResponse = await fetchCompat(imageUrl);
    if (!imageResponse.ok) return null;
    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const allowedCategories = Array.isArray(context.allowedCategories) ? context.allowedCategories : [];
    const categoryHint = allowedCategories.length ? allowedCategories.join('、') : '未設定';

    const prompt = `請從這張發票或收據圖片中，提取一筆記帳資料。
若圖片不是可辨識的交易資料，請回傳 {"is_transaction": false}。

限制：
- category 必須優先使用以下分類：${categoryHint}
- 若無法判斷分類，category 請回 null
- amount 只要數字，不含幣別符號
- type 只能是 income 或 expense
- note 可為空

只回 JSON：
{
  "is_transaction": true/false,
  "amount": number|null,
  "type": "income|expense|null",
  "category": "string|null",
  "note": "string|null"
}`;

    const response = await fetchCompat(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': rawKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        max_tokens: 512,
        system: '你是票據辨識與記帳解析助手，只回傳 JSON',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              source: { type: 'base64', media_type: contentType, data: base64 },
            },
          ],
        }],
      }),
    });

    const data = await response.json();
    const statusCode = data?.base_resp?.status_code ?? null;
    const success = response.ok && (statusCode === null || statusCode === 0);
    if (!success) {
      console.error('MiniMax Vision API Error:', response.status, data);
      return null;
    }

    const text = getTextFromAnthropicContent(data?.content);
    const parsed = safeParseJsonFromText(text || '');
    if (!parsed || !parsed.is_transaction) return null;
    if (typeof parsed.amount !== 'number' || parsed.amount <= 0) return null;

    return {
      amount: parsed.amount,
      type: parsed.type === 'income' ? 'income' : 'expense',
      category: parsed.category || null,
      note: parsed.note || '',
    };
  } catch (error) {
    console.error('MiniMax Vision parse failed:', error.message);
    return null;
  }
}

async function decideActionWithLLM(content, context = {}) {
  const {
    isSetupMode = false,
    setupState = null,
    allowedCategories = [],
    history = [],
    pendingClarification = null,
  } = context;
  const categoryHint = Array.isArray(allowedCategories) && allowedCategories.length
    ? allowedCategories.join('、')
    : '（未設定）';
  const historyText = Array.isArray(history) && history.length
    ? history.slice(-10).map((item) => {
      const role = item?.role === 'assistant' ? '機器人' : '使用者';
      return `${role}：${String(item?.content || '').trim()}`;
    }).join('\n')
    : '（無）';
  const pendingHint = pendingClarification
    ? `\n- 追問上下文（使用者正在回答這個追問，請結合上下文推斷完整意圖）：action=${pendingClarification.action || ''}，amount=${pendingClarification.amount ?? 'null'}，type=${pendingClarification.type || 'null'}，category=${pendingClarification.category || 'null'}，note=${pendingClarification.note || 'null'}`
    : '';
  const prompt = `請分析使用者訊息，判斷應採取的 action。

可用 action:
- "set_budget": 使用者是在回答初始化問題中的每月預算
- "set_reminder_time": 使用者是在回答每日提醒時間
- "set_gender": 使用者是在回答性別設定
- "set_title": 使用者是在回答稱呼設定
- "set_category_rule": 使用者要「記住」某關鍵字/店家/說法之後對應哪個分類（例如：以後星巴克算餐飲、把 XX 歸類為 YY）
- "record_transaction": 使用者是在記帳（收入/支出）
- "shared_ledger_transfer": 使用者要把錢轉入共同帳本（個人→共同）
- "shared_ledger_payout": 使用者要從共同帳本提領/轉回個人帳本（共同→個人）
- "query_analysis": 使用者想查詢/比較區間資料並要分析結論
- "chat": 一般聊天

上下文:
- isSetupMode: ${isSetupMode}
- setupState: ${setupState || 'none'}
- allowedCategories: ${categoryHint}
- 最近對話（最多10段）：
${historyText}${pendingHint}

使用者訊息:
${content}

請只回傳 JSON：
{
  "action": "set_budget|set_reminder_time|set_gender|set_title|set_category_rule|record_transaction|shared_ledger_transfer|shared_ledger_payout|query_analysis|chat",
  "confidence": 0-1 的數字,
  "needs_clarification": true/false,
  "follow_up_question": "若需要追問，給一句簡短追問，否則 null",
  "amount": 數字或null,
  "reminder_time": "HH:mm 或 null",
  "gender": "male|female|other|null",
  "title": "稱呼字串或null",
  "type": "income|expense|null",
  "category": "字串或null",
  "note": "字串或null",
  "metric": "expense|income|net|count|null",
  "period_a": "today|yesterday|this_week|last_week|this_month|last_month|null",
  "period_b": "today|yesterday|this_week|last_week|this_month|last_month|null",
  "rule_keyword": "若 action=set_category_rule：要記住的關鍵字/片語，否則 null",
  "rule_category": "若 action=set_category_rule：要對應到的分類（必須在 allowedCategories），否則 null"
}`;

  const response = await callMiniMax(
    prompt,
    `你是嚴格的工具路由器，只輸出 JSON，不要多餘文字。
規則：
1) 若 action=record_transaction，category 必須從 allowedCategories 中選一個。
2) 若無法判定對應分類，category 請回 null，並把 needs_clarification=true，給簡短追問。
3) 禁止自創分類名稱。
4) 若 action=set_category_rule，請填 rule_keyword 與 rule_category（皆從 allowedCategories 選分類名稱）；若資訊不足則 needs_clarification=true。`
  );
  const parsed = safeParseJsonFromText(response);
  if (!parsed || !parsed.action) return null;

  return {
    action: parsed.action,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    needsClarification: Boolean(parsed.needs_clarification),
    followUpQuestion: typeof parsed.follow_up_question === 'string' ? parsed.follow_up_question : null,
    amount: typeof parsed.amount === 'number' ? parsed.amount : null,
    reminderTime: typeof parsed.reminder_time === 'string' ? parsed.reminder_time : null,
    gender: typeof parsed.gender === 'string' ? parsed.gender : null,
    title: typeof parsed.title === 'string' ? parsed.title : null,
    type: parsed.type || null,
    category: parsed.category || null,
    note: parsed.note || null,
    metric: parsed.metric || null,
    periodA: parsed.period_a || null,
    periodB: parsed.period_b || null,
    ruleKeyword: typeof parsed.rule_keyword === 'string' ? parsed.rule_keyword : null,
    ruleCategory: typeof parsed.rule_category === 'string' ? parsed.rule_category : null,
  };
}

async function generateDataAnalysisResponse(input) {
  const prompt = `你要根據已計算好的資料，用繁體中文給使用者一段重點分析。

使用者問題：
${input.userQuery}

資料：
${JSON.stringify(input.data, null, 2)}

請輸出 2-4 句：
1) 先給明確答案（差多少、增加或減少）
2) 再補一句原因推測或觀察
3) 最後可加一句實用建議

限制：
- 不要編造資料
- 金額請用 NT$ 並加千分位
- 簡潔但自然`;

  const response = await callMiniMax(prompt, '你是理財分析助理，只能基於提供資料回答');
  return response || null;
}

async function planDataQueryWithLLM(userQuery) {
  const prompt = `你是資料查詢規劃器，請把使用者問題轉成查詢計畫 JSON。

使用者問題：
${userQuery}

可用分析類型：
- compare_ranges：比較兩個區間
- category_breakdown：某個區間按分類拆解
- trend：某區間按日趨勢

可用 metric：
- expense
- income
- net
- count

可用區間 preset：
- today
- yesterday
- this_week
- last_week
- this_month
- last_month

只回傳 JSON：
{
  "analysis_type": "compare_ranges|category_breakdown|trend",
  "metric": "expense|income|net|count",
  "range_a": { "preset": "today|yesterday|this_week|last_week|this_month|last_month|null", "year": number|null, "month": number|null },
  "range_b": { "preset": "today|yesterday|this_week|last_week|this_month|last_month|null", "year": number|null, "month": number|null },
  "target_range": { "preset": "today|yesterday|this_week|last_week|this_month|last_month|null", "year": number|null, "month": number|null },
  "category": "字串或null",
  "group_by": "day|category|null",
  "top_n": 數字或null
}

規則：
1) 若提到「某年某月」，請填 year/month。
2) 若提到「分類占比、標籤、圓餅、最多類別」，analysis_type 應為 category_breakdown。
3) 若提到「趨勢、每天、走勢」，analysis_type 應為 trend 且 group_by=day。
4) 若比較兩段（例如昨天 vs 今天），analysis_type 應為 compare_ranges。`;

  const response = await callMiniMax(prompt, '你是嚴格 JSON 輸出器，只回 JSON');
  const parsed = safeParseJsonFromText(response);
  if (!parsed || !parsed.analysis_type) return null;
  return {
    analysisType: parsed.analysis_type,
    metric: parsed.metric || 'expense',
    rangeA: parsed.range_a || null,
    rangeB: parsed.range_b || null,
    targetRange: parsed.target_range || null,
    category: parsed.category || null,
    groupBy: parsed.group_by || null,
    topN: typeof parsed.top_n === 'number' ? parsed.top_n : null,
  };
}

async function planTransactionActionWithLLM(content, context = {}) {
  const allowedCategories = Array.isArray(context.allowedCategories) ? context.allowedCategories : [];
  const categoryHint = allowedCategories.length ? allowedCategories.join('、') : '（未設定）';
  const referencedId = Number(context.referencedId || 0) || null;
  const prompt = `你是交易管理意圖解析器，請把使用者句子解析成 JSON 計畫。

使用者句子：
${content}

上下文：
- 可用分類：${categoryHint}
- 若使用者是「回覆某則訊息」：replied_transaction_id=${referencedId ?? 'null'}

請只回傳 JSON：
{
  "action": "update|delete|none",
  "id": 數字或null,
  "updates": {
    "amount": 數字或null,
    "type": "income|expense|null",
    "category": "字串或null",
    "note": "字串或null"
  },
  "needs_clarification": true/false,
  "follow_up_question": "若缺資訊則追問，否則 null"
}

規則：
1) 像「刪除、刪掉、移除」判為 delete。
2) 像「修改、改成、改為、更正、修正」判為 update。
3) 若句子沒有明確 id，但是回覆訊息且 action 不是 none，可把 id 設為 replied_transaction_id。
4) 若是 update 但缺更新內容，needs_clarification=true 並給追問。
5) category 必須優先使用可用分類，不能亂造。`;

  const response = await callMiniMax(prompt, '你是嚴格 JSON 輸出器，只回 JSON');
  const parsed = safeParseJsonFromText(response);
  if (!parsed || !parsed.action) return null;
  const updates = parsed.updates && typeof parsed.updates === 'object' ? parsed.updates : {};
  return {
    action: parsed.action,
    id: Number.isFinite(Number(parsed.id)) ? Number(parsed.id) : null,
    updates: {
      amount: Number.isFinite(Number(updates.amount)) ? Number(updates.amount) : null,
      type: typeof updates.type === 'string' ? updates.type : null,
      category: typeof updates.category === 'string' ? updates.category : null,
      note: typeof updates.note === 'string' ? updates.note : null,
    },
    needsClarification: Boolean(parsed.needs_clarification),
    followUpQuestion: typeof parsed.follow_up_question === 'string' ? parsed.follow_up_question : null,
  };
}

async function generateChatResponse(message, context = {}) {
  const styleTags = Array.isArray(context.styleTags) ? context.styleTags.filter(Boolean) : [];
  const styleHint = styleTags.length ? styleTags.join('、') : '輕鬆、友善';
  const history = Array.isArray(context.history) ? context.history : [];
  const historyText = history.length
    ? history.map((item) => {
      const role = item?.role === 'assistant' ? '機器人' : '使用者';
      return `${role}：${String(item?.content || '').trim()}`;
    }).join('\n')
    : '（無）';
  const prompt = `最近對話（最多10段）：
${historyText}

這是使用者的最新訊息：${message}

對話風格標籤：${styleHint}

請參考最近對話脈絡，回覆一段自然、連貫的短回應（不超過30字），可以調侃、關心、或正常聊天。`;
  const response = await callMiniMax(prompt);
  return sanitizeShortReply(response) || '哦';
}

async function generateMonthlyReport(userId, transactions) {
  const prompt = `使用者這個月的消費紀錄如下，請給出一段簡短的分析和建議（不超過100字）：\n\n${transactions.map((t) => `- ${t.category}: NT$ ${t.amount}`).join('\n')}`;
  return callMiniMax(prompt, '你是一個理財顧問，給出專業但親切的建議');
}

async function normalizeVoiceTranscriptWithLLM(rawText) {
  const source = String(rawText || '').trim();
  if (!source) return '';
  const prompt = `請把下面這句語音轉文字，整理成適合記帳的精簡文字。

原文：
${source}

規則：
1) 修正常見錯字或同音字（例：工車 -> 公車、買當勞 -> 麥當勞）。
2) 移除冗詞、口語贅字，保留關鍵資訊（時間詞/項目/金額/必要分類）。
3) 不要新增原文沒有的金額或事實。
4) 僅輸出整理後一句，不要解釋。

示例：
- 晚餐我在買當勞吃了101 -> 晚餐 麥當勞 101
- 我剛剛搭工車花35 -> 公車 35`;

  const cleaned = await callMiniMax(prompt, '你是記帳文字清洗器，只輸出整理後的一句文字，不要任何說明。');
  const text = String(cleaned || '').trim();
  return text || source;
}

module.exports = {
  generateResponse,
  callMiniMax,
  parseWithLLM,
  decideActionWithLLM,
  generateChatResponse,
  generateMonthlyReport,
  generateDataAnalysisResponse,
  parseTransactionFromImageWithLLM,
  planDataQueryWithLLM,
  planTransactionActionWithLLM,
  normalizeVoiceTranscriptWithLLM,
};
