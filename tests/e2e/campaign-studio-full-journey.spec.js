import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// ── Test data ────────────────────────────────────────────────────────────

const BRIEF_ID = 'brief-full';
const SESSION_ID = 'session-full';

const MOCK_SESSIONS_INTAKE = [{
  brief_id: BRIEF_ID,
  session_id: null,
  first_message: null,
  status: 'intake',
  current_phase: 'intake',
  phase_index: 0,
  completion_pct: 0,
  created_at: '2026-03-30T10:00:00Z',
  updated_at: '2026-03-30T10:00:00Z',
}];

const PRODUCT_IMAGE_URL = 'https://encrypted-tbn3.gstatic.com/shopping?q=tbn:ANd9GcRm-_YfZQ7CVx4LjGqCOfu4bJRFlijqZk6UvqjjLa3v7BcIqIhsgSrGoYzP_OyfFch6hMQjNXEhIp9fKvx9c_cEC2KT6Y4yk7RQ98Ea9F8-&usqp=CAc';

const MOCK_UPLOAD_RESPONSE = {
  url: PRODUCT_IMAGE_URL,
  storage_path: 'brief-full/1711500000_ref.png',
  filename: 'test-product.png',
  content_type: 'image/png',
  size: 12345,
};

const MOCK_UPLOAD_RESPONSE_2 = {
  url: PRODUCT_IMAGE_URL,
  storage_path: 'brief-full/1711500001_ref2.png',
  filename: 'test-product-2.png',
  content_type: 'image/png',
  size: 23456,
};

// Intake SSE: AI acknowledges reference images and extracts brief fields
const MOCK_INTAKE_SSE_1 = [
  'event: thinking\ndata: {"text":"分析用户上传的产品图片和投放需求..."}\n\n',
  'event: tool_start\ndata: {"tool":"update_brief"}\n\n',
  'event: tool_call\ndata: {"tool":"update_brief","input":{"industry":"农业机械","products":[{"name":"大型拖拉机","model":"TF-500"}],"target_countries":["肯尼亚","尼日利亚"]}}\n\n',
  'event: tool_result\ndata: {"tool":"update_brief","result":{"success":true}}\n\n',
  'event: delta\ndata: {"text":"收到您的产品图片！"}\n\n',
  'event: delta\ndata: {"text":"我从图片中识别到了大型拖拉机产品，已记录到投放需求中。"}\n\n',
  'event: brief_update\ndata: {"brief":{"industry":"农业机械","products":[{"name":"大型拖拉机","model":"TF-500"}],"target_countries":["肯尼亚","尼日利亚"]},"completion":{"completion_pct":50,"filled":["industry","products","target_countries"],"missing":["budget_total","objectives","preferred_platforms"]},"show_card":true}\n\n',
  'event: done\ndata: {"status":"ok"}\n\n',
].join('');

// Second intake message: user provides remaining details
const MOCK_INTAKE_SSE_2 = [
  'event: tool_start\ndata: {"tool":"update_brief"}\n\n',
  'event: tool_call\ndata: {"tool":"update_brief","input":{"budget_total":5000,"budget_currency":"USD","objectives":["lead_generation"],"preferred_platforms":["meta"]}}\n\n',
  'event: tool_result\ndata: {"tool":"update_brief","result":{"success":true}}\n\n',
  'event: delta\ndata: {"text":"好的，需求已完整！"}\n\n',
  'event: delta\ndata: {"text":"我将开始为您制定投放方案。"}\n\n',
  'event: brief_update\ndata: {"brief":{"industry":"农业机械","products":[{"name":"大型拖拉机","model":"TF-500"}],"target_countries":["肯尼亚","尼日利亚"],"budget_total":5000,"budget_currency":"USD","objectives":["lead_generation"],"preferred_platforms":["meta"]},"completion":{"completion_pct":100,"filled":["industry","products","target_countries","budget_total","objectives","preferred_platforms"],"missing":[]},"show_card":true}\n\n',
  'event: trigger_orchestration\ndata: {}\n\n',
  'event: done\ndata: {"status":"completed","brief_id":"brief-full"}\n\n',
].join('');

// Full orchestration pipeline SSE (research → strategy → creative_plan → creative → approval)
const MOCK_ORCHESTRATION_SSE = [
  // ── Research phase ──
  'event: orchestration_start\ndata: {}\n\n',
  'event: phase_start\ndata: {"phase":"research","name":"市场调研","description":"Analyzing market"}\n\n',
  'event: phase_progress\ndata: {"phase":"research","step":"analyzing_market","detail":"搜索肯尼亚农业机械市场数据"}\n\n',
  'event: heartbeat\ndata: {"phase":"research","elapsed_s":3}\n\n',
  'event: phase_complete\ndata: {"phase":"research","name":"市场调研","result":{"key_findings":["肯尼亚拖拉机进口增速+23%","主要竞品: TATA, Mahindra","尼日利亚政府推农机补贴政策"],"market_size":"$2.1B","growth_rate":"12%"},"duration":5}\n\n',

  // ── Strategy phase ──
  'event: phase_start\ndata: {"phase":"strategy","name":"方案规划","description":"Generating media plan"}\n\n',
  'event: phase_progress\ndata: {"phase":"strategy","step":"generating_plan","detail":"制定Meta广告投放方案"}\n\n',
  'event: heartbeat\ndata: {"phase":"strategy","elapsed_s":4}\n\n',
  'event: phase_complete\ndata: {"phase":"strategy","name":"方案规划","result":{"summary":"Meta 100%","platforms":[{"platform":"Meta","budget_allocation":100,"budget_amount":5000,"rationale":"Meta lead gen forms最适合非洲B2B","campaigns":[{"name":"Kenya Tractor Leads","objective":"LEAD_GENERATION","daily_budget":100,"ad_sets":[{"name":"Kenya-Farmers-25-55","targeting":{"countries":["KE"],"age_min":25,"age_max":55,"interests":["Agriculture","Farming"]}}]}]}]},"duration":8}\n\n',

  // ── Creative plan phase ──
  'event: phase_start\ndata: {"phase":"creative_plan","name":"素材规划","description":"Planning creatives"}\n\n',
  'event: phase_progress\ndata: {"phase":"creative_plan","step":"collecting_refs","detail":"收集产品图片和参考素材"}\n\n',
  'event: phase_complete\ndata: {"phase":"creative_plan","name":"素材规划","result":{"creative_tasks":[{"id":"task-1","type":"image","headline":"TF-500 大型拖拉机 — 高效耕作","description":"产品展示图+场景合成"},{"id":"task-2","type":"image","headline":"非洲农业现代化首选","description":"场景营销图"}],"references":["https://example.com/ref1.png","https://example.com/ref2.png"]},"duration":4}\n\n',

  // ── Creative generation phase (AIGC) ──
  'event: phase_start\ndata: {"phase":"creative","name":"素材生成","description":"Generating AIGC content"}\n\n',
  'event: phase_progress\ndata: {"phase":"creative","step":"creative_start","detail":"开始生成 2 个素材","completed":0,"total":2,"errors":0}\n\n',
  'event: phase_progress\ndata: {"phase":"creative","step":"creative_item","detail":"素材 1/2 生成完成","completed":1,"total":2,"errors":0}\n\n',
  'event: phase_progress\ndata: {"phase":"creative","step":"creative_done","detail":"全部素材生成完成","completed":2,"total":2,"errors":0}\n\n',
  'event: phase_complete\ndata: {"phase":"creative","name":"素材生成","result":{"assets":[{"name":"TF-500 产品展示","headline":"TF-500 大型拖拉机 — 高效耕作","primary_text":"适合非洲大规模农场，耐用可靠","format":"1200x628","url":"https://example.com/creative-1.jpg"},{"name":"场景营销图","headline":"非洲农业现代化首选","primary_text":"提升生产效率，降低劳动成本","format":"1080x1080","url":"https://example.com/creative-2.jpg"}]},"duration":15}\n\n',

  // ── Execution phase (approval required) ──
  'event: phase_start\ndata: {"phase":"execution","name":"投放执行","description":"Creating campaigns"}\n\n',
  'event: approval_required\ndata: {"plan":{"platforms":[{"platform":"Meta","budget_allocation":100,"budget_amount":5000,"campaigns":[{"name":"Kenya Tractor Leads","objective":"LEAD_GENERATION","daily_budget":100,"ad_sets":[{"name":"Kenya-Farmers-25-55","targeting":{"countries":["KE"],"age_min":25,"age_max":55,"interests":["Agriculture","Farming"]},"ads":[{"name":"TF-500 Product Ad","format":"image","headline":"TF-500 大型拖拉机","cta":"LEARN_MORE"}]}]}]}]}}\n\n',
].join('');

// After approval: execution completes
const MOCK_APPROVE_SSE = [
  'event: phase_complete\ndata: {"phase":"execution","name":"投放执行","result":{"campaigns_created":[{"id":"camp-001","name":"Kenya Tractor Leads","status":"ACTIVE"}],"errors":[]},"duration":12}\n\n',
  'event: done\ndata: {"session_id":"session-full","phases_completed":["research","strategy","creative_plan","creative","execution"]}\n\n',
].join('');

// ── Helpers ──────────────────────────────────────────────────────────────

async function setupMocks(page) {
  await page.context().addCookies([{
    name: 'NEXT_LOCALE',
    value: 'zh',
    domain: 'localhost',
    path: '/',
  }]);
  await page.route('**/auth/v1/**', route =>
    route.fulfill({ json: { id: 'user-1', email: 'test@test.com' } })
  );
  await page.route('**/realtime/**', route => route.abort());
}

function createTestPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
  );
}

const TEST_IMAGE_DIR = path.join(process.cwd(), 'tests', 'e2e', 'fixtures');

test.beforeAll(() => {
  for (const name of ['test-product.png', 'test-product-2.png']) {
    const imgPath = path.join(TEST_IMAGE_DIR, name);
    if (!fs.existsSync(imgPath)) {
      fs.writeFileSync(imgPath, createTestPng());
    }
  }
});

// ── Tests ────────────────────────────────────────────────────────────────

test.describe('Campaign Studio - Full AI Journey: Reference → AIGC → Execution', () => {

  test('complete journey: upload references, generate AIGC content, approve execution', async ({ page }) => {
    await setupMocks(page);

    // Track intake message count to serve different SSE responses
    let intakePostCount = 0;
    let uploadCount = 0;

    // Mock sessions API — always return intake session (no session_id change mid-flow)
    // This avoids sessionId changing during orchestration which triggers history reload
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({ json: { data: MOCK_SESSIONS_INTAKE } })
    );

    // Mock brief GET
    await page.route(`**/api/campaign/intake/${BRIEF_ID}`, route =>
      route.fulfill({
        json: { id: BRIEF_ID, brief: {}, completion: {}, status: 'active' },
      })
    );

    // Mock upload API
    await page.route('**/api/campaign/upload', route => {
      uploadCount++;
      return route.fulfill({
        json: uploadCount === 1 ? MOCK_UPLOAD_RESPONSE : MOCK_UPLOAD_RESPONSE_2,
      });
    });

    // Mock orchestrate GET + POST
    await page.route(`**/api/campaign/orchestrate/${BRIEF_ID}`, route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: {
            session_id: null, brief_id: BRIEF_ID, status: 'draft', current_phase: null,
            brief: {}, completion: {}, phase_results: {}, phase_results_keys: [], messages: [],
          },
        });
      }
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        // Chat message (has message field) = intake
        if (body?.message) {
          intakePostCount++;
          const sseBody = intakePostCount === 1 ? MOCK_INTAKE_SSE_1 : MOCK_INTAKE_SSE_2;
          return route.fulfill({
            headers: { 'Content-Type': 'text/event-stream' },
            body: sseBody,
          });
        }
        // Empty body or no message = orchestration pipeline
        return route.fulfill({
          headers: { 'Content-Type': 'text/event-stream' },
          body: MOCK_ORCHESTRATION_SSE,
        });
      }
      return route.continue();
    });

    // Mock approve endpoint
    await page.route(`**/api/campaign/orchestrate/${BRIEF_ID}/approve`, route =>
      route.fulfill({
        headers: { 'Content-Type': 'text/event-stream' },
        body: MOCK_APPROVE_SSE,
      })
    );

    // Also mock with session_id for approve (frontend might use sessionId)
    await page.route(`**/api/campaign/orchestrate/${SESSION_ID}/approve`, route =>
      route.fulfill({
        headers: { 'Content-Type': 'text/event-stream' },
        body: MOCK_APPROVE_SSE,
      })
    );

    // ════════════════════════════════════════════════════════════════════
    // STEP 1: Navigate and select the intake session
    // ════════════════════════════════════════════════════════════════════
    await page.goto('/dashboard/campaign-studio');

    // Session should appear
    await expect(page.locator('text=新会话')).toBeVisible({ timeout: 5000 });
    await page.click('text=新会话');

    // Input area should be ready
    const msgInput = page.getByPlaceholder('输入消息...');
    await expect(msgInput).toBeVisible({ timeout: 5000 });

    // ════════════════════════════════════════════════════════════════════
    // STEP 2: Upload reference product images
    // ════════════════════════════════════════════════════════════════════
    const fileInput = page.locator('[data-testid="image-file-input"]');
    await fileInput.setInputFiles([
      path.join(TEST_IMAGE_DIR, 'test-product.png'),
      path.join(TEST_IMAGE_DIR, 'test-product-2.png'),
    ]);

    // Preview bar should show 2 images
    const previewBar = page.locator('[data-testid="image-preview-bar"]');
    await expect(previewBar).toBeVisible({ timeout: 5000 });
    await expect(previewBar.locator('img')).toHaveCount(2, { timeout: 5000 });

    // Wait for uploads to complete
    await expect(page.locator('[data-testid="image-preview-bar"] .animate-spin')).not.toBeVisible({ timeout: 5000 });

    // ════════════════════════════════════════════════════════════════════
    // STEP 3: Send first message with reference images
    // ════════════════════════════════════════════════════════════════════
    await msgInput.fill('这是我们的拖拉机产品，想推广到肯尼亚和尼日利亚');
    await page.locator('[data-testid="send-btn"]').click();

    // User message should render with images
    await expect(page.locator('[data-testid="user-message-image"]')).toHaveCount(2, { timeout: 5000 });
    await expect(page.locator('text=这是我们的拖拉机产品')).toBeVisible();

    // Preview bar should be cleared
    await expect(previewBar).not.toBeVisible();

    // AI should respond
    await expect(page.locator('text=收到您的产品图片！')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=我从图片中识别到了大型拖拉机产品')).toBeVisible();

    // Should see the brief card with 50% completion
    await expect(page.locator('text=投放需求摘要')).toBeVisible();
    await expect(page.locator('text=50%')).toBeVisible();
    await expect(page.locator('text=农业机械')).toBeVisible();

    // ════════════════════════════════════════════════════════════════════
    // STEP 4: Complete the brief with remaining details
    // ════════════════════════════════════════════════════════════════════
    await msgInput.fill('月预算5000美金，主要做Lead获客，投Meta');
    await page.keyboard.press('Enter');

    // Should see user message
    await expect(page.locator('text=月预算5000美金')).toBeVisible();

    // AI responds and brief completes
    await expect(page.locator('text=好的，需求已完整！')).toBeVisible({ timeout: 10000 });

    // Brief card shows 100%
    await expect(page.locator('text=100%').first()).toBeVisible({ timeout: 5000 });

    // ════════════════════════════════════════════════════════════════════
    // STEP 5: Orchestration auto-starts — verify research phase
    // ════════════════════════════════════════════════════════════════════
    // Research complete card should appear
    await expect(page.locator('text=市场调研完成')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=肯尼亚拖拉机进口增速+23%')).toBeVisible();

    // ════════════════════════════════════════════════════════════════════
    // STEP 6: Strategy phase completes
    // ════════════════════════════════════════════════════════════════════
    await expect(page.locator('text=投放方案完成')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Meta 100%')).toBeVisible();

    // ════════════════════════════════════════════════════════════════════
    // STEP 7: Creative plan phase completes
    // ════════════════════════════════════════════════════════════════════
    await expect(page.locator('text=TF-500 大型拖拉机 — 高效耕作')).toBeVisible({ timeout: 10000 });

    // ════════════════════════════════════════════════════════════════════
    // STEP 8: AIGC content generation completes
    // ════════════════════════════════════════════════════════════════════
    await expect(page.getByText('素材生成完成', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=已生成 2 个版本')).toBeVisible();

    // Should show generated creative headlines
    await expect(page.locator('text=TF-500 大型拖拉机 — 高效耕作').last()).toBeVisible();
    await expect(page.locator('text=非洲农业现代化首选')).toBeVisible();

    // ════════════════════════════════════════════════════════════════════
    // STEP 9: Execution approval — review and approve
    // ════════════════════════════════════════════════════════════════════
    await expect(page.locator('text=等待审批 - 投放执行')).toBeVisible({ timeout: 10000 });

    // Should see execution plan details
    await expect(page.locator('text=Kenya Tractor Leads')).toBeVisible();
    await expect(page.getByText('LEAD_GENERATION', { exact: true })).toBeVisible();

    // Click approve
    await page.click('text=确认投放');

    // ════════════════════════════════════════════════════════════════════
    // STEP 10: Execution completes successfully
    // ════════════════════════════════════════════════════════════════════
    await expect(page.locator('text=投放执行完成')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=已创建 1 个广告系列')).toBeVisible();
  });

  test('AIGC progress card shows real-time generation status with 3 creatives', async ({ page }) => {
    await setupMocks(page);

    // Intake session — user sends a message that completes brief → triggers full pipeline
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({
        json: {
          data: [{
            brief_id: 'brief-aigc',
            session_id: null,
            first_message: null,
            status: 'intake',
            current_phase: 'intake',
            phase_index: 0,
            completion_pct: 0,
            created_at: '2026-03-30T10:00:00Z',
            updated_at: '2026-03-30T10:30:00Z',
          }],
        },
      })
    );

    await page.route('**/api/campaign/intake/brief-aigc', route =>
      route.fulfill({
        json: { id: 'brief-aigc', brief: {}, completion: {}, status: 'active' },
      })
    );

    // Intake SSE completes brief and triggers orchestration
    const INTAKE_COMPLETE_SSE = [
      'event: delta\ndata: {"text":"好的，我已记录您的所有需求。"}\n\n',
      'event: brief_update\ndata: {"brief":{"industry":"农业机械","products":[{"name":"拖拉机"}],"target_countries":["肯尼亚"],"budget_total":5000,"objectives":["lead_generation"],"preferred_platforms":["meta"]},"completion":{"completion_pct":100,"filled":["industry","products","target_countries","budget_total","objectives","preferred_platforms"],"missing":[]},"show_card":true}\n\n',
      'event: trigger_orchestration\ndata: {}\n\n',
      'event: done\ndata: {"status":"completed","brief_id":"brief-aigc"}\n\n',
    ].join('');

    // Orchestration SSE with 3 AIGC creatives and progress events
    const AIGC_ORCHESTRATION_SSE = [
      'event: orchestration_start\ndata: {}\n\n',
      'event: phase_start\ndata: {"phase":"research","name":"市场调研"}\n\n',
      'event: phase_complete\ndata: {"phase":"research","name":"市场调研","result":{"key_findings":["市场增速+23%"]},"duration":3}\n\n',
      'event: phase_start\ndata: {"phase":"strategy","name":"方案规划"}\n\n',
      'event: phase_complete\ndata: {"phase":"strategy","name":"方案规划","result":{"summary":"Meta 100%","platforms":[{"platform":"Meta","budget_allocation":100,"budget_amount":5000}]},"duration":5}\n\n',
      'event: phase_start\ndata: {"phase":"creative_plan","name":"素材规划"}\n\n',
      'event: phase_complete\ndata: {"phase":"creative_plan","name":"素材规划","result":{"creative_tasks":[{"id":"t1","type":"image","headline":"产品图"}],"references":[]},"duration":3}\n\n',
      'event: phase_start\ndata: {"phase":"creative","name":"素材生成"}\n\n',
      'event: phase_progress\ndata: {"phase":"creative","step":"creative_start","detail":"开始生成 3 个素材","completed":0,"total":3,"errors":0}\n\n',
      'event: phase_progress\ndata: {"phase":"creative","step":"creative_item","detail":"素材 1/3 生成完成","completed":1,"total":3,"errors":0}\n\n',
      'event: phase_progress\ndata: {"phase":"creative","step":"creative_item","detail":"素材 2/3 生成完成","completed":2,"total":3,"errors":0}\n\n',
      'event: phase_progress\ndata: {"phase":"creative","step":"creative_done","detail":"全部素材生成完成","completed":3,"total":3,"errors":0}\n\n',
      'event: phase_complete\ndata: {"phase":"creative","name":"素材生成","result":{"assets":[{"name":"素材A","headline":"高效耕作","primary_text":"描述A","format":"1200x628","url":"https://example.com/a.jpg"},{"name":"素材B","headline":"现代农业","primary_text":"描述B","format":"1080x1080","url":"https://example.com/b.jpg"},{"name":"素材C","headline":"可靠动力","primary_text":"描述C","format":"1200x628","url":"https://example.com/c.jpg"}]},"duration":20}\n\n',
      'event: done\ndata: {"session_id":"session-aigc"}\n\n',
    ].join('');

    await page.route('**/api/campaign/orchestrate/brief-aigc', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: {
            session_id: null, brief_id: 'brief-aigc', status: 'draft', current_phase: null,
            brief: {}, completion: {}, phase_results: {}, phase_results_keys: [], messages: [],
          },
        });
      }
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (body?.message) {
          return route.fulfill({
            headers: { 'Content-Type': 'text/event-stream' },
            body: INTAKE_COMPLETE_SSE,
          });
        }
        return route.fulfill({
          headers: { 'Content-Type': 'text/event-stream' },
          body: AIGC_ORCHESTRATION_SSE,
        });
      }
      return route.continue();
    });

    await page.goto('/dashboard/campaign-studio');

    // Select the session and send a message that completes the brief
    await page.click('text=新会话');
    const input = page.getByPlaceholder('输入消息...');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('拖拉机推广到肯尼亚，月预算5000美金，投Meta做Lead');
    await page.keyboard.press('Enter');

    // Brief completes and orchestration auto-starts
    await expect(page.locator('text=投放需求摘要')).toBeVisible({ timeout: 10000 });

    // AIGC should complete and show all 3 creatives
    await expect(page.getByText('素材生成完成', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=已生成 3 个版本')).toBeVisible();

    // Verify all creative headlines are visible
    await expect(page.locator('text=高效耕作')).toBeVisible();
    await expect(page.locator('text=现代农业')).toBeVisible();
    await expect(page.locator('text=可靠动力')).toBeVisible();
  });

  test('feedback loop: user provides adjustments mid-pipeline', async ({ page }) => {
    await setupMocks(page);

    // Intake SSE that completes brief and triggers orchestration
    const INTAKE_COMPLETE_SSE = [
      'event: delta\ndata: {"text":"需求已完整。"}\n\n',
      'event: brief_update\ndata: {"brief":{"industry":"农业机械","budget_total":5000},"completion":{"completion_pct":100,"filled":["industry","budget_total"],"missing":[]},"show_card":true}\n\n',
      'event: trigger_orchestration\ndata: {}\n\n',
      'event: done\ndata: {"status":"completed","brief_id":"brief-fb"}\n\n',
    ].join('');

    // Orchestration pauses after strategy with feedback_required
    const FEEDBACK_SSE = [
      'event: orchestration_start\ndata: {}\n\n',
      'event: phase_start\ndata: {"phase":"research","name":"市场调研"}\n\n',
      'event: phase_complete\ndata: {"phase":"research","name":"市场调研","result":{"key_findings":["市场数据..."]},"duration":3}\n\n',
      'event: phase_start\ndata: {"phase":"strategy","name":"方案规划"}\n\n',
      'event: phase_complete\ndata: {"phase":"strategy","name":"方案规划","result":{"summary":"Meta 70% + Google 30%","platforms":[{"platform":"Meta","budget_allocation":70,"budget_amount":3500},{"platform":"Google","budget_allocation":30,"budget_amount":1500}]},"duration":5}\n\n',
      'event: feedback_required\ndata: {"message":"## 方案概览\\n\\n- Meta: 70% ($3,500)\\n- Google: 30% ($1,500)\\n\\n请确认或调整预算分配方案。","options":["确认方案，继续执行","调整预算分配","取消"]}\n\n',
    ].join('');

    const AFTER_FEEDBACK_SSE = [
      'event: phase_start\ndata: {"phase":"creative_plan","name":"素材规划"}\n\n',
      'event: phase_complete\ndata: {"phase":"creative_plan","name":"素材规划","result":{"creative_tasks":[{"id":"t1","type":"image","headline":"调整后素材"}],"references":[]},"duration":3}\n\n',
      'event: phase_start\ndata: {"phase":"creative","name":"素材生成"}\n\n',
      'event: phase_complete\ndata: {"phase":"creative","name":"素材生成","result":{"assets":[{"name":"调整后素材","headline":"Meta专注投放","primary_text":"全部预算投Meta","format":"1200x628","url":"https://example.com/adj.jpg"}]},"duration":10}\n\n',
      'event: done\ndata: {"session_id":"session-fb"}\n\n',
    ].join('');

    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({
        json: {
          data: [{
            brief_id: 'brief-fb',
            session_id: null,
            first_message: null,
            status: 'intake',
            current_phase: 'intake',
            phase_index: 0,
            completion_pct: 0,
            created_at: '2026-03-30T10:00:00Z',
            updated_at: '2026-03-30T10:00:00Z',
          }],
        },
      })
    );

    await page.route('**/api/campaign/intake/brief-fb', route =>
      route.fulfill({
        json: { id: 'brief-fb', brief: {}, completion: {}, status: 'active' },
      })
    );

    await page.route('**/api/campaign/orchestrate/brief-fb', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: {
            session_id: null, brief_id: 'brief-fb', status: 'draft', current_phase: null,
            brief: {}, completion: {}, phase_results: {}, phase_results_keys: [], messages: [],
          },
        });
      }
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (body?.message) {
          return route.fulfill({
            headers: { 'Content-Type': 'text/event-stream' },
            body: INTAKE_COMPLETE_SSE,
          });
        }
        return route.fulfill({
          headers: { 'Content-Type': 'text/event-stream' },
          body: FEEDBACK_SSE,
        });
      }
      return route.continue();
    });

    await page.route('**/api/campaign/orchestrate/brief-fb/feedback', route =>
      route.fulfill({
        headers: { 'Content-Type': 'text/event-stream' },
        body: AFTER_FEEDBACK_SSE,
      })
    );

    await page.goto('/dashboard/campaign-studio');

    // Select session and send message to complete brief
    await page.click('text=新会话');
    const input = page.getByPlaceholder('输入消息...');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('农业机械，月预算5000美金');
    await page.keyboard.press('Enter');

    // Orchestration auto-starts, research and strategy complete
    await expect(page.locator('text=市场调研完成')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=投放方案完成')).toBeVisible({ timeout: 10000 });

    // Feedback card should appear
    await expect(page.locator('text=需要您的确认')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=请确认或调整预算分配方案。')).toBeVisible();

    // Should see options
    await expect(page.locator('button:has-text("确认方案，继续执行")')).toBeVisible();
    await expect(page.locator('button:has-text("调整预算分配")')).toBeVisible();

    // Click confirm to continue
    await page.click('button:has-text("确认方案，继续执行")');

    // Pipeline resumes — creative plan and creative phases complete
    await expect(page.getByText('素材生成完成', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=已生成 1 个版本')).toBeVisible();
    await expect(page.locator('text=Meta专注投放')).toBeVisible();
  });

  test('execution with errors shows error hints', async ({ page }) => {
    await setupMocks(page);

    const EXEC_ERROR_SSE = [
      'event: phase_complete\ndata: {"phase":"execution","name":"投放执行","result":{"campaigns_created":[{"id":"camp-1","name":"Campaign A","status":"ACTIVE"}],"errors":["No image_hash provided for ad creative"]},"duration":8}\n\n',
      'event: done\ndata: {"session_id":"session-err"}\n\n',
    ].join('');

    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({
        json: {
          data: [{
            brief_id: 'brief-err',
            session_id: 'session-err',
            first_message: '错误测试',
            status: 'brief_completed',
            current_phase: 'execution',
            phase_index: 5,
            completion_pct: 100,
            created_at: '2026-03-30T10:00:00Z',
            updated_at: '2026-03-30T10:00:00Z',
          }],
        },
      })
    );

    await page.route('**/api/campaign/intake/brief-err', route =>
      route.fulfill({
        json: { id: 'brief-err', brief: { industry: '测试' }, completion: { completion_pct: 100 }, status: 'completed' },
      })
    );

    await page.route('**/api/campaign/orchestrate/session-err', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: {
            session_id: 'session-err',
            brief_id: 'brief-err',
            status: 'awaiting_approval',
            current_phase: 'execution',
            brief: { industry: '测试' },
            completion: { completion_pct: 100 },
            phase_results: {
              research: { key_findings: ['data'] },
              strategy: { summary: 'Meta 100%', platforms: [] },
              creative: { assets: [{ name: 'test', headline: 'test' }] },
            },
            phase_results_keys: ['research', 'strategy', 'creative'],
            messages: [
              { id: 'e1', phase: 'execution', role: 'event', tool_name: 'feedback_required', content: '确认投放？', tool_result: { options: ['确认执行', '取消'] }, created_at: '2026-03-30T10:05:00Z' },
            ],
          },
        });
      }
      return route.continue();
    });

    await page.route('**/api/campaign/orchestrate/session-err/feedback', route =>
      route.fulfill({
        headers: { 'Content-Type': 'text/event-stream' },
        body: EXEC_ERROR_SSE,
      })
    );

    await page.goto('/dashboard/campaign-studio');
    await page.click('text=错误测试');

    // Should see feedback card for approval
    await expect(page.locator('text=需要您的确认')).toBeVisible({ timeout: 10000 });
    await page.click('button:has-text("确认执行")');

    // Execution completes with errors
    await expect(page.locator('text=投放执行部分完成')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=1 个错误')).toBeVisible();
    await expect(page.locator('text=广告图片缺失')).toBeVisible();
    await expect(page.locator('text=素材生成阶段未完成')).toBeVisible();
  });
});
