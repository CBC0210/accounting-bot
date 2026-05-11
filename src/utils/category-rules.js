/**
 * 頻道自訂「分類記憶」：使用者指定關鍵字 → 對應分類（必須為已設定的類別之一）
 * 儲存格式：JSON 陣列 [{ "keyword": "星巴克", "category": "餐飲" }, ...]
 */

const MAX_RULES = 50;

function normalizeTagText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:、,，。!！?？\-_]/g, '');
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCategoryRulesText(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) => ({
      keyword: String(row?.keyword || '').trim(),
      category: String(row?.category || '').trim(),
    }))
    .filter((row) => row.keyword && row.category);
}

function stringifyCategoryRules(rules) {
  const safe = (Array.isArray(rules) ? rules : [])
    .map((row) => ({
      keyword: String(row?.keyword || '').trim(),
      category: String(row?.category || '').trim(),
    }))
    .filter((row) => row.keyword && row.category)
    .slice(0, MAX_RULES);
  return JSON.stringify(safe);
}

/**
 * 依關鍵字長度由長到短比對（較長的店家名優先）
 */
function matchUserCategoryRule(contextText, rules, allowedCategories) {
  const list = Array.isArray(rules) ? rules : [];
  if (!list.length || !contextText) return null;
  const haystack = normalizeForMatch(contextText);
  if (!haystack) return null;

  const allowedSet = new Set(
    (Array.isArray(allowedCategories) ? allowedCategories : []).map((t) => String(t || '').trim()).filter(Boolean)
  );
  if (!allowedSet.size) return null;

  const sorted = [...list].sort(
    (a, b) => String(b.keyword || '').length - String(a.keyword || '').length
  );

  for (const rule of sorted) {
    const kw = normalizeForMatch(rule.keyword);
    if (kw.length < 1) continue;
    if (!haystack.includes(kw)) continue;
    const cat = String(rule.category || '').trim();
    if (!allowedSet.has(cat)) continue;
    return cat;
  }
  return null;
}

function upsertCategoryRule(existingRules, keyword, category) {
  const kw = String(keyword || '').trim();
  const cat = String(category || '').trim();
  if (!kw || !cat) return { rules: existingRules, changed: false };

  const base = Array.isArray(existingRules) ? [...existingRules] : [];
  const idx = base.findIndex((r) => normalizeForMatch(r.keyword) === normalizeForMatch(kw));
  const entry = { keyword: kw, category: cat };
  if (idx >= 0) {
    base[idx] = entry;
  } else {
    base.unshift(entry);
  }
  const trimmed = base.slice(0, MAX_RULES);
  return { rules: trimmed, changed: true };
}

/**
 * 嘗試從自然語句解析「教學分類」意圖（不需 LLM）
 */
function parseCategoryRuleTeachIntent(content) {
  const text = String(content || '').trim();
  if (text.length < 4 || text.length > 200) return null;

  const cue = /(以後|從現在開始|之後|記住|請記住|幫我記)/.test(text);
  const actionCue = /(視為|歸類(?:成|為)?|分類為|當作|算成|算|用)/.test(text);
  if (!cue || !actionCue) {
    const mBracket = text.match(/^把\s*[「『]?(.+?)[」』]?\s*(?:歸類|分類)\s*(?:為|成)\s*[「『]?(.+?)[」』]?\s*$/);
    if (mBracket) {
      return {
        keyword: mBracket[1].trim(),
        category: mBracket[2].replace(/類別$|分類$/g, '').trim(),
      };
    }
    return null;
  }

  const patterns = [
    /^以後\s*[「『]?(.+?)[」』]?\s*(?:都|一律)?\s*(?:視為|算|歸類(?:成|為)?|當作|用)\s*[「『]?(.+?)[」』]?\s*(?:類別|分類)?\s*$/,
    /^以後\s*(.+?)\s+(?:都|一律)\s*(?:視為|算|歸類(?:成|為)?|當作)\s*(.+?)\s*(?:類別|分類)?\s*$/,
    /^(?:從現在開始|之後)[，,]?\s*[「『]?(.+?)[」』]?\s*(?:都|一律)?\s*(?:視為|算|歸類(?:成|為)?|當作)\s*[「『]?(.+?)[」』]?\s*(?:類別|分類)?\s*$/,
    /^記住[：:]\s*[「『]?(.+?)[」』]?\s*(?:是|為|→|->)\s*[「『]?(.+?)[」』]?\s*(?:類別|分類)?\s*$/,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      return {
        keyword: m[1].trim(),
        category: m[2].replace(/類別$|分類$/g, '').trim(),
      };
    }
  }

  return null;
}

function resolveCategoryAgainstAllowed(rawCategory, allowedCategories) {
  const safeAllowed = Array.isArray(allowedCategories) && allowedCategories.length
    ? allowedCategories
    : [];
  const target = String(rawCategory || '').trim();
  if (!target) return null;

  const exact = safeAllowed.find((tag) => normalizeTagText(tag) === normalizeTagText(target));
  if (exact) return exact;

  const partial = safeAllowed.find((tag) => {
    const nt = normalizeTagText(tag);
    const nr = normalizeTagText(target);
    return nt.includes(nr) || nr.includes(nt);
  });
  return partial || null;
}

module.exports = {
  parseCategoryRulesText,
  stringifyCategoryRules,
  matchUserCategoryRule,
  upsertCategoryRule,
  parseCategoryRuleTeachIntent,
  resolveCategoryAgainstAllowed,
  MAX_RULES,
};
