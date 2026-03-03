const { all, get, run } = require('../db/database');

const TICK_INTERVAL_MS = 60 * 1000;

function parseReminderTime(reminderTime) {
  const match = String(reminderTime || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

function nowDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nowTimeKey(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function hasReminderExecution(channelId, reminderDate, reminderTime) {
  const row = get(`
    SELECT id
    FROM daily_reminder_executions
    WHERE channel_id = ? AND reminder_date = ? AND reminder_time = ?
  `, [channelId, reminderDate, reminderTime]);
  return Boolean(row);
}

function markReminderExecution(channelId, reminderDate, reminderTime) {
  run(`
    INSERT OR IGNORE INTO daily_reminder_executions (
      channel_id, reminder_date, reminder_time
    ) VALUES (?, ?, ?)
  `, [channelId, reminderDate, reminderTime]);
}

async function sendReminderToChannel(client, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') return;
    await channel.send('⏰ 記帳提醒：今天有花錢或收入的話，記得跟我說一聲！');
  } catch (error) {
    console.log(`提醒發送失敗(${channelId}):`, error.message);
  }
}

async function tickDailyReminderJobs(client) {
  const now = new Date();
  const today = nowDateKey(now);
  const currentTime = nowTimeKey(now);

  const rows = all(`
    SELECT channel_id, reminder_time
    FROM channel_settings
    WHERE reminder_time IS NOT NULL
      AND TRIM(reminder_time) <> ''
      AND setup_completed_at IS NOT NULL
  `);

  for (const row of rows) {
    const normalized = parseReminderTime(row.reminder_time);
    if (!normalized) continue;
    if (normalized !== currentTime) continue;
    if (hasReminderExecution(row.channel_id, today, normalized)) continue;

    await sendReminderToChannel(client, row.channel_id);
    markReminderExecution(row.channel_id, today, normalized);
  }
}

function startDailyReminderScheduler(client) {
  if (!client) return null;

  void tickDailyReminderJobs(client);
  return setInterval(() => {
    void tickDailyReminderJobs(client);
  }, TICK_INTERVAL_MS);
}

module.exports = {
  startDailyReminderScheduler,
};

