const { run, get } = require('../db/database');

function parsePipeSummary(summary) {
  const text = String(summary || '').trim();
  if (!text.includes('|')) return null;
  const out = {};
  text.split('|').map((s) => s.trim()).filter(Boolean).forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = value;
  });
  return out;
}

function parseLegacyUpdateSummary(summary) {
  const text = String(summary || '');
  const idMatch = text.match(/id=(\d+)/);
  const getDiff = (label) => {
    const re = new RegExp(`${label}:([^\\s]+)->([^\\s]+)`);
    const m = text.match(re);
    return m ? { old: m[1], next: m[2] } : null;
  };
  return {
    id: idMatch ? Number(idMatch[1]) : null,
    amount: getDiff('金額'),
    type: getDiff('類型'),
    category: getDiff('分類'),
    note: getDiff('備註'),
  };
}

function normalizeNullableText(value, fallback = '') {
  const text = String(value ?? '').trim();
  if (!text || ['null', 'undefined', '(空)'].includes(text.toLowerCase())) return fallback;
  return text;
}

function buildUndoPayloadFromEvent(row) {
  const entity = String(row?.entity || '');
  const action = String(row?.action || '');
  const channelId = String(row?.channel_id || '');
  const summary = String(row?.summary || '');
  if (!entity || !action || !channelId) return null;

  if (entity === 'transactions') {
    const map = parsePipeSummary(summary);
    if (map && action === 'insert') {
      const id = Number(map.id || 0);
      if (!id) return null;
      return {
        kind: 'delete_tx',
        channelId,
        id,
      };
    }
    if (map && action === 'update') {
      const id = Number(map.id || 0);
      if (!id) return null;
      return {
        kind: 'update_tx',
        channelId,
        id,
        before: {
          amount: Number(map.amount_old || 0),
          type: normalizeNullableText(map.type_old, 'expense'),
          category: normalizeNullableText(map.category_old, '未分類'),
          note: normalizeNullableText(map.note_old, ''),
          timestamp: normalizeNullableText(map.timestamp_old, new Date().toISOString()),
          user_id: normalizeNullableText(map.user_old, ''),
        },
      };
    }
    if (map && action === 'delete') {
      const id = Number(map.id || 0);
      if (!id) return null;
      return {
        kind: 'insert_tx',
        channelId,
        row: {
          id,
          user_id: normalizeNullableText(map.user, ''),
          amount: Number(map.amount || 0),
          category: normalizeNullableText(map.category, '未分類'),
          note: normalizeNullableText(map.note, ''),
          type: normalizeNullableText(map.type, 'expense'),
          timestamp: normalizeNullableText(map.timestamp, new Date().toISOString()),
        },
      };
    }

    // 舊版 update 摘要兼容
    if (action === 'update') {
      const legacy = parseLegacyUpdateSummary(summary);
      if (!legacy.id) return null;
      return {
        kind: 'update_tx',
        channelId,
        id: legacy.id,
        before: {
          amount: Number(legacy.amount?.old || 0),
          type: normalizeNullableText(legacy.type?.old, 'expense'),
          category: normalizeNullableText(legacy.category?.old, '未分類'),
          note: normalizeNullableText(legacy.note?.old, ''),
        },
      };
    }
  }

  if (entity === 'channel_settings' && action === 'update') {
    const text = String(summary || '');
    const segments = text.split('||').map((s) => s.trim()).filter(Boolean);
    const fields = {};
    segments.forEach((segment) => {
      const idx = segment.indexOf(':');
      if (idx <= 0) return;
      const key = segment.slice(0, idx).trim();
      const rest = segment.slice(idx + 1).trim();
      const arrow = rest.indexOf('->');
      if (arrow < 0) return;
      fields[key] = rest.slice(0, arrow).trim();
    });
    if (!Object.keys(fields).length) return null;
    return {
      kind: 'update_settings',
      channelId,
      fields,
    };
  }

  return null;
}

function buildPreviewText(row, payload) {
  if (!row || !payload) return '外部異動';
  if (payload.kind === 'delete_tx') return `撤回外部新增（ID ${payload.id}）`;
  if (payload.kind === 'update_tx') return `撤回外部修改（ID ${payload.id}）`;
  if (payload.kind === 'insert_tx') return `還原外部刪除（ID ${payload.row?.id || '-'})`;
  if (payload.kind === 'update_settings') return '還原外部設定修改';
  return '外部異動';
}

function recordUndoStepFromEvent(row) {
  const payload = buildUndoPayloadFromEvent(row);
  if (!payload) return null;
  const preview = buildPreviewText(row, payload);
  run(`
    INSERT INTO operation_steps (channel_id, source, entity, action, target_id, undo_payload, preview, created_at, used)
    VALUES (?, 'external_event', ?, ?, ?, ?, ?, datetime('now'), 0)
  `, [
    String(row.channel_id || ''),
    String(row.entity || ''),
    String(row.action || ''),
    Number(payload.id || payload.row?.id || 0) || null,
    JSON.stringify(payload),
    preview,
  ]);
  return payload;
}

function applyUndoPayload(payload) {
  const kind = String(payload?.kind || '');
  if (kind === 'delete_tx') {
    run(`DELETE FROM transactions WHERE channel_id = ? AND id = ?`, [payload.channelId, Number(payload.id)]);
    return;
  }
  if (kind === 'update_tx') {
    const before = payload.before || {};
    const withTimestamp = typeof before.timestamp === 'string' && before.timestamp;
    const withUserId = typeof before.user_id === 'string' && before.user_id;
    if (withTimestamp && withUserId) {
      run(`
        UPDATE transactions
        SET amount = ?, category = ?, note = ?, type = ?, timestamp = ?, user_id = ?
        WHERE channel_id = ? AND id = ?
      `, [
        Number(before.amount || 0),
        normalizeNullableText(before.category, '未分類'),
        normalizeNullableText(before.note, ''),
        normalizeNullableText(before.type, 'expense'),
        before.timestamp,
        before.user_id,
        payload.channelId,
        Number(payload.id),
      ]);
      return;
    }
    run(`
      UPDATE transactions
      SET amount = ?, category = ?, note = ?, type = ?
      WHERE channel_id = ? AND id = ?
    `, [
      Number(before.amount || 0),
      normalizeNullableText(before.category, '未分類'),
      normalizeNullableText(before.note, ''),
      normalizeNullableText(before.type, 'expense'),
      payload.channelId,
      Number(payload.id),
    ]);
    return;
  }
  if (kind === 'insert_tx') {
    const row = payload.row || {};
    run(`
      INSERT OR REPLACE INTO transactions (id, channel_id, user_id, amount, category, note, type, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      Number(row.id || 0),
      payload.channelId,
      normalizeNullableText(row.user_id, 'external'),
      Number(row.amount || 0),
      normalizeNullableText(row.category, '未分類'),
      normalizeNullableText(row.note, ''),
      normalizeNullableText(row.type, 'expense'),
      normalizeNullableText(row.timestamp, new Date().toISOString()),
    ]);
    return;
  }
  if (kind === 'update_settings') {
    const fields = payload.fields || {};
    const sets = [];
    const params = [];
    if (Object.prototype.hasOwnProperty.call(fields, 'budget')) {
      sets.push('budget = ?');
      params.push(Number(fields.budget || 0));
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'reminder')) {
      sets.push('reminder_time = ?');
      params.push(normalizeNullableText(fields.reminder, ''));
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'reminderEnabled')) {
      sets.push('reminder_enabled = ?');
      params.push(Number(fields.reminderEnabled || 1) ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'title')) {
      sets.push('user_title = ?');
      params.push(normalizeNullableText(fields.title, ''));
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'showBalance')) {
      sets.push('show_balance_in_name = ?');
      params.push(Number(fields.showBalance || 1) ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'categories')) {
      sets.push('categories_text = ?');
      params.push(normalizeNullableText(fields.categories, '').split(',').join('\n'));
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'monthlyBudgets')) {
      sets.push('monthly_budgets_text = ?');
      params.push(normalizeNullableText(fields.monthlyBudgets, ''));
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(payload.channelId);
    run(`UPDATE channel_settings SET ${sets.join(', ')} WHERE channel_id = ?`, params);
  }
}

function restoreLatestStep(channelId) {
  const row = get(`
    SELECT id, undo_payload, preview
    FROM operation_steps
    WHERE channel_id = ? AND used = 0
    ORDER BY id DESC
    LIMIT 1
  `, [String(channelId || '')]);
  if (!row) {
    return { ok: false, message: '目前沒有可還原的步驟。' };
  }
  try {
    const payload = JSON.parse(String(row.undo_payload || '{}'));
    applyUndoPayload(payload);
    run(`UPDATE operation_steps SET used = 1 WHERE id = ?`, [Number(row.id)]);
    return {
      ok: true,
      message: `已還原上一步：${String(row.preview || '外部異動')}`,
      payload,
    };
  } catch (error) {
    return { ok: false, message: `還原失敗：${error.message || error}` };
  }
}

module.exports = {
  recordUndoStepFromEvent,
  restoreLatestStep,
};

