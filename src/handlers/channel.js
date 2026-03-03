const { getChannelSettings, getChannelNetBalance } = require('../db/queries');
const { EmbedBuilder } = require('discord.js');

function getChannelIdFromChannel(channel) {
  return channel.id;
}

async function sendChannelInfoMessage(channel) {
  const channelId = channel.id;
  const dashboardUrl = `https://accounting.bc-verse.com/${channelId}`;
  
  const embed = new EmbedBuilder()
    .setColor(0x00d9ff)
    .setTitle('🦑 記帳機器人')
    .setDescription('歡迎使用記帳機器人！')
    .addFields(
      { name: '📊 Dashboard', value: `[打開網頁儀表板](${dashboardUrl})`, inline: false },
      { name: '💬 記帳方式', value: '直接說話就能記，如「uber 199」或「晚餐 300」', inline: false },
      { name: '📷 發票辨識', value: '直接傳圖片給我，自動解析金額', inline: false },
      { name: '🔗 連結', value: `\`${dashboardUrl}\``, inline: false }
    )
    .setFooter({ text: '記帳機器人 v1.0' })
    .setTimestamp();
  
  const message = await channel.send({ embeds: [embed] });
  
  // 釘選訊息
  try {
    await message.pin();
  } catch (e) {
    console.log('無法釘選訊息:', e.message);
  }
  
  return message;
}

function normalizeChannelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

function formatBalanceNumber(balance) {
  const rounded = Math.round(balance);
  return `${rounded}`;
}

function buildLedgerBaseName(settings) {
  const type = String(settings?.type || 'personal');
  if (type === 'shared') return '共同賬本';
  const title = String(settings?.user_title || '').trim();
  return title ? `${title}的賬本` : '個人賬本';
}

async function updateChannelBalanceName(channel) {
  if (!channel || typeof channel.setName !== 'function') return false;

  const settings = getChannelSettings(channel.id);
  const type = String(settings?.type || 'personal');
  const showBalanceInName = Number(settings?.show_balance_in_name ?? 1) === 1;
  if (type !== 'shared' && !showBalanceInName) return false;

  const balance = getChannelNetBalance(channel.id);
  const baseName = buildLedgerBaseName(settings);
  const nextName = normalizeChannelName(`${baseName}_${formatBalanceNumber(balance)}`);
  if (!nextName) return false;
  if (channel.name === nextName) return true;

  try {
    await channel.setName(nextName, '記帳異動後同步更新餘額');
    return true;
  } catch (error) {
    console.log('更新頻道名稱失敗:', error.message);
    return false;
  }
}

module.exports = { sendChannelInfoMessage, updateChannelBalanceName };
