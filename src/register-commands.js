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
    name_localizations: { 'en-US': 'balance' },
    description: '查詢目前餘額',
    description_localizations: { 'en-US': 'Check current balance' },
  },
  {
    name: '統計',
    name_localizations: { 'en-US': 'stats' },
    description: '查看消費統計',
    description_localizations: { 'en-US': 'View spending statistics' },
    options: [
      {
        name: '週期',
        name_localizations: { 'en-US': 'period' },
        description: '統計週期',
        description_localizations: { 'en-US': 'Time period' },
        type: 3,
        required: false,
        choices: [
          { name: '本週', name_localizations: { 'en-US': 'week' }, value: 'week' },
          { name: '本月', name_localizations: { 'en-US': 'month' }, value: 'month' },
        ],
      },
    ],
  },
  {
    name: '設定',
    name_localizations: { 'en-US': 'settings' },
    description: '設定每月預算',
    description_localizations: { 'en-US': 'Set monthly budget' },
    options: [
      {
        name: '金額',
        name_localizations: { 'en-US': 'amount' },
        description: '每月預算金額',
        description_localizations: { 'en-US': 'Monthly budget amount' },
        type: 10,
        required: true,
      },
    ],
  },
  {
    name: '初始化',
    name_localizations: { 'en-US': 'init' },
    description: '將目前頻道設定為記帳頻道',
    description_localizations: { 'en-US': 'Set up this channel as accounting channel' },
  },
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log('開始註冊斜線指令...');
    
    await rest.put(
      Routes.applicationCommands('1477452115738886307'),
      { body: commands }
    );
    
    console.log('✅ 斜線指令註冊成功！');
  } catch (error) {
    console.error('❌ 註冊失敗:', error);
  }
}

registerCommands();
