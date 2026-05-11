const { decideActionWithLLM } = require('./src/llm/generator');

const TEST_CASES = [
  '午餐吃150元',
  '這個月花了多少',
  'Hi你好',
  '幫我記錄買咖啡50元',
  '分析上週支出',
];

const CONTEXT = {
  isSetupMode: false,
  setupState: null,
  allowedCategories: ['餐飲', '交通', '娛樂', '購物', '醫療', '教育', '其他'],
  history: [],
  pendingClarification: null,
};

async function runTests() {
  console.log('Testing decideActionWithLLM\n');
  console.log('='.repeat(60));

  for (const input of TEST_CASES) {
    console.log(`\nInput: "${input}"`);
    try {
      const result = await decideActionWithLLM(input, CONTEXT);
      console.log(`  action: ${result.action}`);
      console.log(`  confidence: ${result.confidence}`);
      console.log(`  needsClarification: ${result.needsClarification}`);
      console.log(`  amount: ${result.amount}`);
      console.log(`  type: ${result.type}`);
      console.log(`  category: ${result.category}`);
      console.log(`  periodA: ${result.periodA}`);
      console.log(`  periodB: ${result.periodB}`);
      if (result.followUpQuestion) {
        console.log(`  followUpQuestion: ${result.followUpQuestion}`);
      }
    } catch (error) {
      console.log(`  Error: ${error.message}`);
    }
    console.log('-'.repeat(60));
  }
}

runTests();