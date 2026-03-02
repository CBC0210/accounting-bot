require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { handleMessage } = require('./handlers/message');
const { handleSlashCommand } = require('./handlers/slash');
const { initDatabase } = require('./db/database');
const { sendChannelInfoMessage } = require('./handlers/channel');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// 處理斜線指令
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  console.log(`收到指令: ${interaction.commandName}`);

  try {
    await handleSlashCommand(interaction);
  } catch (error) {
    console.error('處理指令失敗:', error);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: '指令執行失敗，請稍後再試。', ephemeral: true });
      } else {
        await interaction.reply({ content: '指令執行失敗，請稍後再試。', ephemeral: true });
      }
    } catch (replyError) {
      console.error('回覆錯誤訊息失敗:', replyError);
    }
  }
});

// 一般訊息
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild || !message.channel) return;
  
  await handleMessage(message);
});

client.on(Events.ClientReady, () => {
  console.log(`🤖 Bot 已上線: ${client.user.tag}`);
});

async function startBot() {
  try {
    await initDatabase();
    console.log('資料庫就緒');
    await client.login(process.env.DISCORD_TOKEN);
    console.log('Discord 登入成功');
  } catch (error) {
    console.error('啟動失敗:', error);
    process.exit(1);
  }
}

startBot();
