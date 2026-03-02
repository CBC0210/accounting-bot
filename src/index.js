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
  console.log(`收到指令: ${interaction.commandName}`);
  if (!interaction.isCommand()) return;
  
  await handleSlashCommand(interaction);
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
