const { all, run, getLastLocalWriteMs } = require('../db/database');
const { EmbedBuilder } = require('discord.js');
const { recordUndoStepFromEvent } = require('./undo-step');

const TICK_INTERVAL_MS = 15 * 1000;
const LOCAL_WRITE_SUPPRESS_WINDOW_MS = 8000;

function isLikelyLocalWriteEvent(eventCreatedMs) {
  const localWriteMs = Number(getLastLocalWriteMs() || 0);
  const eventMs = Number(eventCreatedMs || 0);
  if (!localWriteMs || !eventMs) return false;
  return Math.abs(eventMs - localWriteMs) <= LOCAL_WRITE_SUPPRESS_WINDOW_MS;
}

function buildEventLabel(row) {
  const entity = row.entity === 'channel_settings' ? '設定' : '交易';
  const actionMap = {
    insert: '新增',
    update: '修改',
    delete: '刪除',
  };
  const action = actionMap[row.action] || row.action;
  return `${entity}${action}`;
}

function parsePipeSummary(summary) {
  const text = String(summary || '').trim();
  if (!text.includes('|')) return null;
  const out = {};
  text.split('|').map((s) => s.trim()).filter(Boolean).forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

function prettifySummary(summary) {
  const text = String(summary || '').trim();
  if (!text) return '資料變更';

  if (text.includes('categories:') || text.includes(' || ')) {
    const formatted = prettifySettingsUpdateSummary(text);
    if (formatted) return formatted;
  }

  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/->/g, ' → ')
    .slice(0, 220);

  const tokens = normalized.split(' ');
  const map = {};
  tokens.forEach((token) => {
    const idx = token.indexOf('=');
    if (idx > 0) {
      map[token.slice(0, idx)] = token.slice(idx + 1);
    }
  });

  if (map.id && map['類型'] && map['金額']) {
    const typeText = map['類型'] === 'income' ? '收入' : map['類型'] === 'expense' ? '支出' : map['類型'];
    const amount = Number(map['金額']);
    const amountText = Number.isFinite(amount) ? `NT$ ${amount.toLocaleString()}` : map['金額'];
    const categoryText = map['分類'] ? `｜分類 ${map['分類']}` : '';
    const noteText = map['備註'] ? `｜備註 ${map['備註']}` : '';
    return `ID ${map.id}｜${typeText} ${amountText}${categoryText}${noteText}`;
  }

  return normalized;
}

function prettifySettingsUpdateSummary(text) {
  const segments = String(text || '')
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return '';

  const lines = [];
  segments.forEach((segment) => {
    const idx = segment.indexOf(':');
    if (idx <= 0) return;
    const key = segment.slice(0, idx).trim();
    const rest = segment.slice(idx + 1).trim();
    const arrowIdx = rest.indexOf('->');
    if (arrowIdx < 0) return;
    const oldValue = rest.slice(0, arrowIdx).trim();
    const newValue = rest.slice(arrowIdx + 2).trim();
    if (oldValue === newValue) return;

    if (key === 'categories') {
      const oldTags = toTagSet(oldValue);
      const newTags = toTagSet(newValue);
      const added = [...newTags].filter((x) => !oldTags.has(x));
      const removed = [...oldTags].filter((x) => !newTags.has(x));
      if (added.length) lines.push(`分類新增：${added.join('、')}`);
      if (removed.length) lines.push(`分類移除：${removed.join('、')}`);
      if (!added.length && !removed.length) {
        lines.push('分類設定已更新');
      }
      return;
    }

    if (key === 'showBalance') {
      const oldLabel = oldValue === '1' ? '開啟' : '關閉';
      const newLabel = newValue === '1' ? '開啟' : '關閉';
      lines.push(`頻道顯示餘額：${oldLabel} -> ${newLabel}`);
      return;
    }

    const labelMap = {
      budget: '每月預算',
      reminder: '提醒時間',
      reminderEnabled: '每日提醒開關',
      monthlyBudgets: '月份預算覆寫',
      title: '稱呼',
    };
    const label = labelMap[key] || key;
    lines.push(`${label}：${oldValue || '(空)'} -> ${newValue || '(空)'}`);
  });

  return lines.length ? lines.map((line) => `- ${line}`).join('\n') : '';
}

function toTagSet(text) {
  const tags = String(text || '')
    .split(/[,\n、，]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return new Set(tags);
}

function formatChangeLine(row) {
  return `• ${buildEventLabel(row)}\n  ${prettifySummary(row.summary)}`;
}

function makeAmountText(type, amount) {
  const n = Number(amount || 0);
  const sign = type === 'income' ? '+' : '-';
  return `${sign}NT$ ${Math.abs(n).toLocaleString()}`;
}

function buildTransactionExternalEmbed(row, dashboardUrl) {
  const map = parsePipeSummary(row.summary);
  if (!map) return null;
  const action = String(row.action || '');
  const id = String(map.id || '-');
  const type = String(map.type || (action === 'delete' ? 'expense' : 'expense'));
  if (action === 'insert') {
    return new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('🛠️ 外部新增記帳')
      .setDescription('此筆資料由外部工具寫入。')
      .addFields(
        { name: 'ID', value: id, inline: true },
        { name: '項目', value: String(map.note || map.category || '-'), inline: true },
        { name: '金額', value: makeAmountText(type, map.amount), inline: true },
        { name: '分類', value: String(map.category || '未分類'), inline: true },
        { name: '時間', value: String(map.timestamp || '-'), inline: true },
        { name: '來源', value: '外部資料變更', inline: true },
        { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false }
      )
      .setTimestamp();
  }
  if (action === 'delete') {
    return new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle('🛠️ 外部刪除記帳')
      .setDescription('此筆資料由外部工具刪除。')
      .addFields(
        { name: 'ID', value: id, inline: true },
        { name: '項目', value: String(map.note || map.category || '-'), inline: true },
        { name: '金額', value: makeAmountText(type, map.amount), inline: true },
        { name: '分類', value: String(map.category || '未分類'), inline: true },
        { name: '時間', value: String(map.timestamp || '-'), inline: true },
        { name: '來源', value: '外部資料變更', inline: true },
        { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false }
      )
      .setTimestamp();
  }
  if (action === 'update') {
    const changed = [];
    if (String(map.amount_old || '') !== String(map.amount_new || '')) {
      changed.push({ name: '金額', value: `${map.amount_old} -> ${map.amount_new}`, inline: true });
    }
    if (String(map.type_old || '') !== String(map.type_new || '')) {
      changed.push({ name: '類型', value: `${map.type_old || '-'} -> ${map.type_new || '-'}`, inline: true });
    }
    if (String(map.category_old || '') !== String(map.category_new || '')) {
      changed.push({ name: '分類', value: `${map.category_old || '-'} -> ${map.category_new || '-'}`, inline: true });
    }
    if (String(map.note_old || '') !== String(map.note_new || '')) {
      changed.push({ name: '備註', value: `${map.note_old || '-'} -> ${map.note_new || '-'}`, inline: false });
    }
    if (!changed.length) {
      changed.push({ name: '說明', value: '欄位值與先前相同（可能是外部重寫）。', inline: false });
    }
    return new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('🛠️ 外部修改記帳')
      .setDescription('此筆資料由外部工具修改。')
      .addFields(
        { name: 'ID', value: id, inline: true },
        ...changed,
        { name: '來源', value: '外部資料變更', inline: true },
        { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false }
      )
      .setTimestamp();
  }
  return null;
}

function buildSettingsExternalEmbed(row, dashboardUrl) {
  const text = prettifySummary(row.summary);
  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('🛠️ 外部設定變更')
    .setDescription('此頻道設定由外部工具更新。')
    .addFields(
      { name: '變更內容', value: text || '（無）', inline: false },
      { name: '來源', value: '外部資料變更', inline: true },
      { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false }
    )
    .setTimestamp();
}

function buildExternalEmbed(row, dashboardUrl) {
  if (row.entity === 'transactions') {
    const txEmbed = buildTransactionExternalEmbed(row, dashboardUrl);
    if (txEmbed) return txEmbed;
  }
  if (row.entity === 'channel_settings') {
    return buildSettingsExternalEmbed(row, dashboardUrl);
  }
  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('🛠️ 外部資料變更通知')
    .setDescription('偵測到外部資料異動。')
    .addFields(
      { name: '變更內容', value: formatChangeLine(row), inline: false },
      { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false }
    )
    .setTimestamp();
}

async function tickDataChangeNotifier(client) {
  if (!client) return;

  const rows = all(`
    SELECT id, channel_id, entity, action, summary, created_ms
    FROM data_change_events
    WHERE processed = 0
    ORDER BY id ASC
    LIMIT 200
  `);
  if (!rows.length) return;

  const shouldSkipIds = [];
  const grouped = new Map();

  rows.forEach((row) => {
    if (isLikelyLocalWriteEvent(row.created_ms)) {
      shouldSkipIds.push(Number(row.id));
      return;
    }
    const channelId = String(row.channel_id || '');
    if (!channelId) {
      shouldSkipIds.push(Number(row.id));
      return;
    }
    if (!grouped.has(channelId)) grouped.set(channelId, []);
    grouped.get(channelId).push(row);
  });

  const processedIds = [...shouldSkipIds];

  for (const [channelId, events] of grouped.entries()) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || typeof channel.send !== 'function') {
        processedIds.push(...events.map((e) => Number(e.id)));
        continue;
      }

      const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
      const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${channelId}`;
      const latest = events.slice(-4);
      const embeds = [];
      latest.forEach((eventRow) => {
        try {
          recordUndoStepFromEvent(eventRow);
        } catch (_) {
          // 忽略還原步驟建立失敗，不影響通知
        }
        embeds.push(buildExternalEmbed(eventRow, dashboardUrl));
      });
      const hiddenCount = Math.max(0, events.length - latest.length);
      if (hiddenCount > 0) {
        embeds.push(
          new EmbedBuilder()
            .setColor(0x94a3b8)
            .setTitle('🧾 外部變更彙總')
            .setDescription(`另外還有 ${hiddenCount} 筆外部變更已記錄。`)
            .setTimestamp()
        );
      }
      for (const embed of embeds) {
        await channel.send({ embeds: [embed] });
      }
    } catch (error) {
      // 若送出失敗仍標記為已處理，避免無限重送
    } finally {
      processedIds.push(...events.map((e) => Number(e.id)));
    }
  }

  if (processedIds.length) {
    const placeholders = processedIds.map(() => '?').join(',');
    run(`
      UPDATE data_change_events
      SET processed = 1
      WHERE id IN (${placeholders})
    `, processedIds);
  }

  run(`
    DELETE FROM data_change_events
    WHERE processed = 1
      AND created_at < datetime('now', '-7 day')
  `);
}

function startDataChangeNotifierScheduler(client) {
  if (!client) return null;
  void tickDataChangeNotifier(client);
  return setInterval(() => {
    void tickDataChangeNotifier(client);
  }, TICK_INTERVAL_MS);
}

module.exports = {
  startDataChangeNotifierScheduler,
};
