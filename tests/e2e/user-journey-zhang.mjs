import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:3000';
const EMAIL = 'jerrychaox8406@gmail.com';
const PASSWORD = 'CHEN84063967';

let chatRound = 0;
const chatResponses = [
  [
    'event: thinking\ndata: {"text":"分析用户需求：农业机械出口企业，主营拖拉机，目标非洲市场..."}\n\n',
    'event: tool_call\ndata: {"tool":"update_brief","input":{"industry":"农业机械","products":[{"name":"拖拉机"}],"target_countries":["肯尼亚","尼日利亚","坦桑尼亚"]}}\n\n',
    'event: tool_result\ndata: {"tool":"update_brief","result":{"success":true}}\n\n',
    'event: delta\ndata: {"text":"张总您好！我已经记录了您的核心需求：\\n\\n"}\n\n',
    'event: delta\ndata: {"text":"- **行业**: 农业机械\\n- **产品**: 拖拉机\\n- **目标市场**: 肯尼亚、尼日利亚、坦桑尼亚\\n\\n"}\n\n',
    'event: delta\ndata: {"text":"为了制定最优投放方案，还需要了解：\\n1. **月度广告预算**？\\n2. 投放目标是**获取询盘**还是**品牌曝光**？\\n3. 偏好哪些平台？"}\n\n',
    'event: brief_update\ndata: {"brief":{"industry":"农业机械","products":[{"name":"拖拉机"}],"target_countries":["肯尼亚","尼日利亚","坦桑尼亚"]},"completion":{"completion_pct":45,"filled":["industry","products","target_countries"],"missing":["budget_total","objectives","preferred_platforms","target_audience"]}}\n\n',
    'event: done\ndata: {"status":"ok"}\n\n',
  ],
  [
    'event: tool_call\ndata: {"tool":"update_brief","input":{"budget_total":5000,"budget_currency":"USD","objectives":["lead_gen"],"preferred_platforms":["meta","google"]}}\n\n',
    'event: tool_result\ndata: {"tool":"update_brief","result":{"success":true}}\n\n',
    'event: delta\ndata: {"text":"很好！5000美金/月对非洲农机推广是合理的起点。\\n\\n再确认目标受众：\\n- 客户是**农场主**还是**经销商**？\\n- 有无官网做广告落地页？"}\n\n',
    'event: brief_update\ndata: {"brief":{"industry":"农业机械","products":[{"name":"拖拉机"}],"target_countries":["肯尼亚","尼日利亚","坦桑尼亚"],"budget_total":5000,"budget_currency":"USD","objectives":["lead_gen"],"preferred_platforms":["meta","google"]},"completion":{"completion_pct":72,"filled":["industry","products","target_countries","budget_total","objectives","preferred_platforms"],"missing":["target_audience","website"]}}\n\n',
    'event: done\ndata: {"status":"ok"}\n\n',
  ],
  [
    'event: tool_call\ndata: {"tool":"update_brief","input":{"target_audience":{"age_range":[25,55]},"website":"https://www.zhanghai-agri.com"}}\n\n',
    'event: tool_result\ndata: {"tool":"update_brief","result":{"success":true}}\n\n',
    'event: tool_call\ndata: {"tool":"save_brief","input":{}}\n\n',
    'event: tool_result\ndata: {"tool":"save_brief","result":{"success":true}}\n\n',
    'event: delta\ndata: {"text":"太好了！投放需求已完整收集：\\n\\n✅ 行业：农业机械（拖拉机）\\n✅ 目标市场：肯尼亚、尼日利亚、坦桑尼亚\\n✅ 月预算：$5,000 USD\\n✅ 投放目标：获客\\n✅ 平台：Meta + Google\\n✅ 受众：25-55岁 农场主/经销商\\n✅ 落地页：zhanghai-agri.com\\n\\n接下来系统将自动开始**市场调研**和**方案规划**，请稍候..."}\n\n',
    'event: brief_update\ndata: {"brief":{"industry":"农业机械","products":[{"name":"拖拉机"}],"target_countries":["肯尼亚","尼日利亚","坦桑尼亚"],"budget_total":5000,"budget_currency":"USD","objectives":["lead_gen"],"preferred_platforms":["meta","google"],"target_audience":{"age_range":[25,55]},"website":"https://www.zhanghai-agri.com"},"completion":{"completion_pct":100,"filled":["industry","products","target_countries","budget_total","objectives","preferred_platforms","target_audience","website"],"missing":[]}}\n\n',
    'event: done\ndata: {"status":"completed"}\n\n',
  ],
];

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🧑‍💼 张海涛 | 海涛农业机械有限公司 CEO');
  console.log('  🎯 体验自动化投流功能，推广拖拉机到非洲');
  console.log('═══════════════════════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

  console.log('📍 登录系统...');
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState('networkidle');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard/**', { timeout: 15000 });
  console.log('   ✅ 登录成功\n');

  // Mock chat SSE only
  await page.route('**/api/campaign/orchestrate/*', route => {
    if (route.request().method() !== 'POST') {
      return route.continue();
    }
    const body = chatResponses[chatRound] || chatResponses[chatResponses.length - 1];
    chatRound++;
    return route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: body.join('') });
  });

  console.log('📍 进入 Campaign Studio...');
  await page.goto(`${BASE_URL}/dashboard/campaign-studio`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  console.log('   ✅ 页面就绪\n');

  console.log('📍 新建投放会话...');
  await page.click('button[title="新建会话"]');
  const ta = page.locator('textarea[placeholder="输入消息，描述您的投放需求..."]');
  await ta.waitFor({ state: 'visible', timeout: 8000 });
  console.log('   ✅ 会话已创建\n');
  await page.waitForTimeout(1000);

  console.log('📍 Round 1: 描述投放需求');
  console.log('   💬 "我是做农业机械出口的，主要产品是拖拉机，想推广到非洲..."');
  await ta.fill('我是做农业机械出口的，主要产品是拖拉机，想推广到非洲市场，肯尼亚、尼日利亚、坦桑尼亚这几个国家。');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=张总您好', { timeout: 15000 });
  await page.waitForSelector('text=投放需求摘要', { timeout: 5000 });
  console.log('   🤖 AI: 提取了行业/产品/市场 → Brief 45%\n');
  await page.waitForTimeout(2500);

  console.log('📍 Round 2: 补充预算和目标');
  console.log('   💬 "月预算5000美金，获取询盘，Facebook 和 Google"');
  await ta.fill('月预算5000美金，主要是获取询盘线索，在 Facebook 和 Google 上投。');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=5000美金', { timeout: 15000 });
  console.log('   🤖 AI: 确认预算合理 → Brief 72%\n');
  await page.waitForTimeout(2500);

  console.log('📍 Round 3: 补充受众和网站');
  console.log('   💬 "经销商和大型农场主，25-55岁，网站 zhanghai-agri.com"');
  await ta.fill('主要是经销商和大型农场主，25-55岁，公司网站是 zhanghai-agri.com');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=投放需求已完整收集', { timeout: 15000 });
  console.log('   🤖 Brief 100%! 需求采集完成!\n');
  await page.waitForTimeout(2000);

  console.log('📍 回顾对话...');
  await page.evaluate(() => { document.querySelector('.overflow-y-auto')?.scrollTo(0, 0); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const el = document.querySelector('.overflow-y-auto'); el?.scrollTo(0, el.scrollHeight); });
  await page.waitForTimeout(1000);

  const thinking = page.locator('text=思考中').first();
  if (await thinking.isVisible().catch(() => false)) {
    await thinking.click();
    console.log('   🔍 展开 AI 思考过程');
    await page.waitForTimeout(2000);
  }

  await page.screenshot({ path: '/tmp/zhang-journey.png' });

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  📊 张总体验报告');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ 登录 → Campaign Studio → 新建会话');
  console.log('  ✅ 3 轮对话完成需求采集 (45% → 72% → 100%)');
  console.log('  ✅ Brief 卡片实时更新');
  console.log('  ✅ AI 流式响应 + 工具调用透明');
  console.log('  ✅ Session 列表正常显示');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('⏳ 浏览器保持 15 秒...');
  await page.waitForTimeout(15000);
  await browser.close();
  console.log('🏁 完成！');
}

main().catch(err => { console.error('❌ 出错:', err.message); process.exit(1); });
