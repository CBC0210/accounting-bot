const { all } = require('../db/database');
const { updateChannelBalanceName } = require('../handlers/channel');

const TICK_INTERVAL_MS = 60 * 1000;

async function tickChannelBalanceSync(client) {
  if (!client) return;

  const rows = all(`
    SELECT channel_id
    FROM channel_settings
    WHERE setup_completed_at IS NOT NULL
      AND (
        type = 'shared'
        OR (
          COALESCE(show_balance_in_name, 1) = 1
          AND user_title IS NOT NULL
          AND TRIM(user_title) <> ''
        )
      )
  `);

  for (const row of rows) {
    try {
      const channel = await client.channels.fetch(row.channel_id);
      if (!channel) continue;
      await updateChannelBalanceName(channel);
    } catch (error) {
      // 某些頻道可能已刪除或 bot 權限不足，記 log 但不中斷整體同步
      console.log(`同步頻道餘額名稱失敗(${row.channel_id}):`, error.message);
    }
  }
}

function startChannelBalanceSyncScheduler(client) {
  if (!client) return null;

  void tickChannelBalanceSync(client);
  return setInterval(() => {
    void tickChannelBalanceSync(client);
  }, TICK_INTERVAL_MS);
}

module.exports = {
  startChannelBalanceSyncScheduler,
};

