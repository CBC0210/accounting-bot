const { all, run, getLastLocalWriteMs } = require('../db/database');
const { EmbedBuilder } = require('discord.js');

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

function prettifySummary(summary) {
  const text = String(summary || '').trim();
  if (!text) return '資料變更';
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

function formatChangeLine(row) {
  return `• ${buildEventLabel(row)}\n  ${prettifySummary(row.summary)}`;
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

      const latest = events.slice(-6);
      const lines = latest.map((row) => formatChangeLine(row));
      const hiddenCount = Math.max(0, events.length - latest.length);
      if (hiddenCount > 0) lines.push(`• 另外 ${hiddenCount} 筆變更`);
      const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
      const dashboardUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/${channelId}`;

      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle('🛠️ 外部資料變更通知')
        .setDescription('偵測到外部資料異動，已同步顯示重點。')
        .addFields(
          { name: '變更內容', value: lines.join('\n'), inline: false },
          { name: 'Dashboard', value: `[查看明細](${dashboardUrl})`, inline: false }
        )
        .setTimestamp();

      await channel.send({ embeds: [embed] });
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
