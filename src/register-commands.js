require('dotenv').config();
const { REST, Routes } = require('discord.js');

const commands = [
  {
    name: '記帳',
    name_localizations: { 'en-US': 'expense' },
    description: '記錄一筆支出',
    description_localizations: { 'en-US': 'Record an expense' },
    options: [
      {
        name: '金額',
        name_localizations: { 'en-US': 'amount' },
        description: '花費金額',
        description_localizations: { 'en-US': 'Amount spent' },
        type: 10, // NUMBER
        required: true,
      },
      {
        name: '分類',
        name_localizations: { 'en-US': 'category' },
        description: '花費分類（如：餐飲、交通）',
        description_localizations: { 'en-US': 'Category (e.g., food, transport)' },
        type: 3, // STRING
        required: false,
      },
      {
        name: '備註',
        name_localizations: { 'en-US': 'note' },
        description: '備註說明',
        description_localizations: { 'en-US': 'Note or description' },
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: '收入',
    name_localizations: { 'en-US': 'income' },
    description: '記錄一筆收入',
    description_localizations: { 'en-US': 'Record an income' },
    options: [
      {
        name: '金額',
        name_localizations: { 'en-US': 'amount' },
        description: '收入金額',
        description_localizations: { 'en-US': 'Amount received' },
        type: 10,
        required: true,
      },
      {
        name: '來源',
        name_localizations: { 'en-US': 'source' },
        description: '收入來源',
        description_localizations: { 'en-US': 'Source of income' },
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: '查詢',
    name_localizations: { 'en-US': 'query' },
    description: '查詢區間收支摘要（進階可直接對話）',
    description_localizations: { 'en-US': 'Query range summary' },
    options: [
      {
        name: '範圍',
        name_localizations: { 'en-US': 'period' },
        description: '查詢範圍（預設本月）',
        description_localizations: { 'en-US': 'Query period (default this month)' },
        type: 3,
        required: false,
        choices: [
          { name: '今天', name_localizations: { 'en-US': 'today' }, value: 'today' },
          { name: '昨天', name_localizations: { 'en-US': 'yesterday' }, value: 'yesterday' },
          { name: '本週', name_localizations: { 'en-US': 'this week' }, value: 'this_week' },
          { name: '上週', name_localizations: { 'en-US': 'last week' }, value: 'last_week' },
          { name: '本月', name_localizations: { 'en-US': 'this month' }, value: 'this_month' },
          { name: '上月', name_localizations: { 'en-US': 'last month' }, value: 'last_month' },
          { name: '自訂', name_localizations: { 'en-US': 'custom' }, value: 'custom' },
        ],
      },
      {
        name: '起日',
        name_localizations: { 'en-US': 'start_date' },
        description: '自訂查詢起日（YYYY-MM-DD）',
        description_localizations: { 'en-US': 'Custom range start date (YYYY-MM-DD)' },
        type: 3,
        required: false,
      },
      {
        name: '迄日',
        name_localizations: { 'en-US': 'end_date' },
        description: '自訂查詢迄日（YYYY-MM-DD）',
        description_localizations: { 'en-US': 'Custom range end date (YYYY-MM-DD)' },
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: '預算',
    name_localizations: { 'en-US': 'budget' },
    description: '設定或查看每月預算',
    description_localizations: { 'en-US': 'Set or view monthly budget' },
    options: [
      {
        name: '金額',
        name_localizations: { 'en-US': 'amount' },
        description: '每月預算金額（不填則顯示目前設定）',
        description_localizations: { 'en-US': 'Monthly budget amount (omit to view current)' },
        type: 10,
        required: false,
      },
    ],
  },
  {
    name: '儀表板',
    name_localizations: { 'en-US': 'dashboard' },
    description: '取得本頻道 Dashboard 連結',
    description_localizations: { 'en-US': 'Get dashboard link for this channel' },
  },
  {
    name: '幫助',
    name_localizations: { 'en-US': 'help' },
    description: '查看目前可用功能與建議用法',
    description_localizations: { 'en-US': 'Show available features and usage tips' },
  },
  {
    name: '初始化',
    name_localizations: { 'en-US': 'init' },
    description: '將目前頻道設定為記帳頻道',
    description_localizations: { 'en-US': 'Set up this channel as accounting channel' },
  },
  {
    name: '初始化-共同記賬',
    name_localizations: { 'en-US': 'init-shared-ledger' },
    description: '初始化此伺服器唯一共同賬本頻道',
    description_localizations: { 'en-US': 'Initialize shared ledger channel for this guild' },
  },
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
const clientId = process.env.DISCORD_CLIENT_ID || '1477452115738886307';
const guildId = process.env.DISCORD_GUILD_ID;

async function registerCommands() {
  try {
    if (!process.env.DISCORD_TOKEN) {
      throw new Error('缺少 DISCORD_TOKEN，無法註冊 Slash 指令');
    }
    if (!clientId) {
      throw new Error('缺少 DISCORD_CLIENT_ID，無法註冊 Slash 指令');
    }

    console.log('開始註冊斜線指令...');

    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log(`✅ Guild 斜線指令註冊成功（guild: ${guildId}）`);
    } else {
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log('✅ Global 斜線指令註冊成功！');
    }
  } catch (error) {
    console.error('❌ 註冊失敗:', error);
    process.exitCode = 1;
  }
}

registerCommands();
