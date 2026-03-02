const { getDatabase } = require('../db/database');
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

module.exports = { sendChannelInfoMessage };
