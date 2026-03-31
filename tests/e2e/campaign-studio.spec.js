import { test, expect } from '@playwright/test';
import { mockSupabase } from './fixtures/supabase-mock.js';

// ── Test data ────────────────────────────────────────────────────────────

const MOCK_SESSIONS = [
  {
    brief_id: 'brief-aaa',
    session_id: 'session-aaa',
    first_message: '我想推广拖拉机到肯尼亚和尼日利亚，月预算5000美金',
    status: 'running',
    current_phase: 'strategy',
    phase_index: 2,
    completion_pct: 78,
    created_at: '2026-03-23T10:00:00Z',
    updated_at: '2026-03-23T10:30:00Z',
  },
  {
    brief_id: 'brief-bbb',
    session_id: 'session-bbb',
    first_message: '汽车配件推广到东南亚',
    status: 'completed',
    current_phase: 'execution',
    phase_index: 5,
    completion_pct: 100,
    created_at: '2026-03-22T09:00:00Z',
    updated_at: '2026-03-22T09:15:00Z',
  },
];

const MOCK_BRIEF = {
  id: 'brief-new',
  brief: {},
  completion: {},
  status: 'active',
  created_at: '2026-03-23T14:00:00Z',
};

const MOCK_INTAKE_SSE = [
  'event: delta\ndata: {"text":"收到！"}\n\n',
  'event: delta\ndata: {"text":"我已经提取了您的核心需求。"}\n\n',
  'event: brief_update\ndata: {"brief":{"industry":"农业机械","target_countries":["肯尼亚"]},"completion":{"completion_pct":40,"filled":["industry","target_countries"],"missing":["budget_total","objectives"]}}\n\n',
  'event: done\ndata: {"status":"ok"}\n\n',
].join('');

const MOCK_ORCHESTRATE_SSE = [
  'event: phase_start\ndata: {"phase":"research","name":"市场调研","description":"Analyzing market"}\n\n',
  'event: heartbeat\ndata: {"phase":"research","elapsed_s":2}\n\n',
  'event: phase_complete\ndata: {"phase":"research","name":"市场调研","result":{"key_findings":["肯尼亚拖拉机进口增速+23%","主要竞品: TATA, Mahindra"]},"duration":5}\n\n',
  'event: phase_start\ndata: {"phase":"strategy","name":"方案规划","description":"Generating media plan"}\n\n',
  'event: heartbeat\ndata: {"phase":"strategy","elapsed_s":2}\n\n',
  'event: heartbeat\ndata: {"phase":"strategy","elapsed_s":4}\n\n',
  'event: phase_complete\ndata: {"phase":"strategy","name":"方案规划","result":{"summary":"Meta 60% + Google 40%","platforms":[{"platform":"Meta","budget_allocation":60,"budget_amount":3000},{"platform":"Google","budget_allocation":40,"budget_amount":2000}]},"duration":8}\n\n',
  'event: done\ndata: {"session_id":"session-new","phases_completed":["research","strategy"]}\n\n',
].join('');

// ── Helpers ──────────────────────────────────────────────────────────────

async function setupCampaignStudioMocks(page) {
  // Mock auth
  await page.route('**/auth/v1/**', route =>
    route.fulfill({ json: { id: 'user-1', email: 'test@test.com' } })
  );
  // Mock realtime
  await page.route('**/realtime/**', route => route.abort());
}

async function mockSessionsAPI(page, sessions = MOCK_SESSIONS) {
  await page.route('**/api/campaign/sessions', route =>
    route.fulfill({ json: { data: sessions } })
  );
}

// ── Tests ────────────────────────────────────────────────────────────────

test.describe('Campaign Studio - AI 投放助手', () => {

  test('shows session list and empty chat state', async ({ page }) => {
    await setupCampaignStudioMocks(page);
    await mockSessionsAPI(page);

    await page.goto('/dashboard/campaign-studio');

    // Should see the page title
    await expect(page.locator('h1')).toHaveText('Campaign Studio');

    // Should see the AI 投放助手 tab active
    await expect(page.locator('button:has-text("AI 投放助手")')).toBeVisible();

    // Should see sessions in the list
    await expect(page.locator('text=我想推广拖拉机到肯尼亚和尼日利亚，月预算5000美金')).toBeVisible();
    await expect(page.locator('text=汽车配件推广到东南亚')).toBeVisible();

    // Should see status labels
    await expect(page.locator('text=进行中')).toBeVisible();
    await expect(page.locator('text=已完成')).toBeVisible();

    // Should see empty chat state
    await expect(page.locator('text=选择一个会话或新建会话开始')).toBeVisible();
  });

  test('creates new session and sends message', async ({ page }) => {
    await setupCampaignStudioMocks(page);

    let sessionsCallCount = 0;
    await page.route('**/api/campaign/sessions', route => {
      sessionsCallCount++;
      // After creation, include the new session
      if (sessionsCallCount > 1) {
        return route.fulfill({
          json: {
            data: [{
              brief_id: 'brief-new',
              session_id: null,
              first_message: null,
              status: 'intake',
              current_phase: 'intake',
              phase_index: 0,
              completion_pct: 0,
              created_at: '2026-03-23T14:00:00Z',
              updated_at: '2026-03-23T14:00:00Z',
            }, ...MOCK_SESSIONS],
          },
        });
      }
      return route.fulfill({ json: { data: MOCK_SESSIONS } });
    });

    // Mock create brief
    await page.route('**/api/campaign/intake', route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ json: { brief_id: 'brief-new' }, status: 201 });
      }
      return route.continue();
    });

    // Mock GET brief
    await page.route('**/api/campaign/intake/brief-new', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: MOCK_BRIEF });
      }
      return route.continue();
    });

    // Mock chat SSE
    await page.route('**/api/campaign/orchestrate/brief-new', route => {
      return route.fulfill({
        headers: { 'Content-Type': 'text/event-stream' },
        body: MOCK_INTAKE_SSE,
      });
    });

    await page.goto('/dashboard/campaign-studio');

    // Click the + button in the session list
    await page.click('button[title="新建会话"]');

    // Wait for new session to appear
    await expect(page.locator('text=新会话')).toBeVisible({ timeout: 5000 });

    // The empty chat state should be gone, input should be visible
    await expect(page.locator('textarea[placeholder="输入消息，描述您的投放需求..."]')).toBeVisible();

    // Type a message
    await page.fill('textarea[placeholder="输入消息，描述您的投放需求..."]', '我想推广拖拉机到肯尼亚');

    // Send it
    await page.keyboard.press('Enter');

    // Should see user message in chat bubble (indigo bg)
    await expect(page.locator('.bg-indigo-600:has-text("我想推广拖拉机到肯尼亚")')).toBeVisible();

    // Should see AI response (streamed)
    await expect(page.locator('text=收到！我已经提取了您的核心需求。')).toBeVisible({ timeout: 5000 });

    // Should see the brief card
    await expect(page.locator('text=投放需求摘要')).toBeVisible();
    await expect(page.locator('text=40%')).toBeVisible(); // completion percentage
  });

  test('switches between sessions', async ({ page }) => {
    await setupCampaignStudioMocks(page);
    await mockSessionsAPI(page);

    // Mock brief fetch for first session
    await page.route('**/api/campaign/intake/brief-aaa', route =>
      route.fulfill({
        json: {
          id: 'brief-aaa',
          brief: { industry: '农业机械' },
          completion: { completion_pct: 78 },
          status: 'active',
        },
      })
    );

    // Mock orchestration status fetch
    await page.route('**/api/campaign/orchestrate/session-aaa', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: {
            session_id: 'session-aaa',
            brief_id: 'brief-aaa',
            status: 'running',
            current_phase: 'strategy',
            phase_results_keys: ['research'],
            messages: [
              { id: 'm1', phase: null, role: 'user', content: '我想推广拖拉机', tool_name: null, created_at: '2026-03-23T10:00:00Z' },
              { id: 'm2', phase: null, role: 'assistant', content: '收到您的需求', tool_name: null, created_at: '2026-03-23T10:00:01Z' },
            ],
          },
        });
      }
      return route.continue();
    });

    await page.goto('/dashboard/campaign-studio');

    // Click on the first session
    await page.click('text=我想推广拖拉机到肯尼亚和尼日利亚，月预算5000美金');

    // Should load chat history — check the chat bubble, not the session list
    await expect(page.locator('.bg-indigo-600:has-text("我想推广拖拉机")')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=收到您的需求')).toBeVisible();

    // The session card should be highlighted
    const activeCard = page.locator('.border-indigo-300');
    await expect(activeCard).toBeVisible();
  });

  test('filters sessions by search', async ({ page }) => {
    await setupCampaignStudioMocks(page);
    await mockSessionsAPI(page);

    await page.goto('/dashboard/campaign-studio');

    // Both sessions visible
    await expect(page.locator('text=我想推广拖拉机到肯尼亚和尼日利亚，月预算5000美金')).toBeVisible();
    await expect(page.locator('text=汽车配件推广到东南亚')).toBeVisible();

    // Search for "拖拉机"
    await page.fill('input[placeholder="搜索会话..."]', '拖拉机');

    // Only matching session visible
    await expect(page.locator('text=我想推广拖拉机到肯尼亚和尼日利亚，月预算5000美金')).toBeVisible();
    await expect(page.locator('text=汽车配件推广到东南亚')).not.toBeVisible();

    // Clear search
    await page.fill('input[placeholder="搜索会话..."]', '');
    await expect(page.locator('text=汽车配件推广到东南亚')).toBeVisible();
  });

  test('displays phase progress cards during orchestration', async ({ page }) => {
    await setupCampaignStudioMocks(page);

    // Session that is brief_completed (ready for orchestration)
    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({
        json: {
          data: [{
            brief_id: 'brief-ready',
            session_id: null,
            first_message: '拖拉机推广到非洲',
            status: 'brief_completed',
            current_phase: 'intake',
            phase_index: 1,
            completion_pct: 100,
            created_at: '2026-03-23T12:00:00Z',
            updated_at: '2026-03-23T12:00:00Z',
          }],
        },
      })
    );

    await page.route('**/api/campaign/intake/brief-ready', route =>
      route.fulfill({
        json: {
          id: 'brief-ready',
          brief: { industry: '农业机械', target_countries: ['肯尼亚'] },
          completion: { completion_pct: 100 },
          status: 'completed',
        },
      })
    );

    // Mock orchestration SSE
    await page.route('**/api/campaign/orchestrate/brief-ready', route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          headers: { 'Content-Type': 'text/event-stream' },
          body: MOCK_ORCHESTRATE_SSE,
        });
      }
      return route.continue();
    });

    await page.goto('/dashboard/campaign-studio');

    // Select the session
    await page.click('text=拖拉机推广到非洲');

    // Should see "开始生成投放方案" button
    await expect(page.locator('text=开始生成投放方案')).toBeVisible({ timeout: 5000 });

    // Click it
    await page.click('text=开始生成投放方案');

    // Should see research complete card
    await expect(page.locator('text=市场调研完成')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=肯尼亚拖拉机进口增速+23%')).toBeVisible();

    // Should see strategy complete card
    await expect(page.locator('text=投放方案完成')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Meta 60% + Google 40%')).toBeVisible();
  });

  test('shows execution approval card and handles approve', async ({ page }) => {
    await setupCampaignStudioMocks(page);

    const APPROVAL_SSE = [
      'event: phase_start\ndata: {"phase":"execution","name":"投放执行"}\n\n',
      'event: approval_required\ndata: {"preview":"将在 Meta 上创建 2 个广告系列"}\n\n',
    ].join('');

    const AFTER_APPROVE_SSE = [
      'event: phase_complete\ndata: {"phase":"execution","name":"投放执行","result":{"campaigns_created":[{"id":"camp-1"}],"errors":[]},"duration":10}\n\n',
      'event: done\ndata: {"session_id":"session-approve"}\n\n',
    ].join('');

    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({
        json: {
          data: [{
            brief_id: 'brief-approve',
            session_id: 'session-approve',
            first_message: '需要审批的投放',
            status: 'brief_completed',
            current_phase: 'intake',
            phase_index: 1,
            completion_pct: 100,
            created_at: '2026-03-23T12:00:00Z',
            updated_at: '2026-03-23T12:00:00Z',
          }],
        },
      })
    );

    await page.route('**/api/campaign/intake/brief-approve', route =>
      route.fulfill({ json: { id: 'brief-approve', brief: {}, completion: { completion_pct: 100 }, status: 'completed' } })
    );

    // Frontend uses sessionId first → /api/campaign/orchestrate/session-approve
    await page.route('**/api/campaign/orchestrate/session-approve', route => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: { session_id: 'session-approve', brief_id: 'brief-approve', status: 'draft', current_phase: null, phase_results_keys: [], messages: [] },
        });
      }
      if (route.request().method() === 'POST') {
        return route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: APPROVAL_SSE });
      }
      return route.continue();
    });

    await page.route('**/api/campaign/orchestrate/session-approve/approve', route =>
      route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: AFTER_APPROVE_SSE })
    );

    await page.goto('/dashboard/campaign-studio');

    // Select session and start orchestration
    await page.click('text=需要审批的投放');
    await expect(page.locator('text=开始生成投放方案')).toBeVisible({ timeout: 5000 });
    await page.click('text=开始生成投放方案');

    // Should see approval card
    await expect(page.locator('text=等待审批 - 投放执行')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=将在 Meta 上创建 2 个广告系列')).toBeVisible();

    // Click approve
    await page.click('text=确认投放');

    // Should see execution complete
    await expect(page.locator('text=投放执行完成')).toBeVisible({ timeout: 10000 });
  });

  test('displays tab navigation correctly', async ({ page }) => {
    await setupCampaignStudioMocks(page);
    await mockSessionsAPI(page);

    await page.goto('/dashboard/campaign-studio');

    // All tabs should be visible (use button role to avoid subtitle match)
    await expect(page.getByRole('button', { name: '广告计划列表' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'AI 投放助手' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'AI 素材生产' })).toBeVisible();
    await expect(page.getByRole('button', { name: '深度归因分析' })).toBeVisible();

    // Click another tab
    await page.getByRole('button', { name: '广告计划列表' }).click();
    await expect(page.locator('text=广告计划列表 - 开发中')).toBeVisible();

    // Switch back
    await page.click('button:has-text("AI 投放助手")');
    await expect(page.locator('text=选择一个会话或新建会话开始')).toBeVisible();
  });

  test('shows thinking and tool use cards', async ({ page }) => {
    await setupCampaignStudioMocks(page);

    const SSE_WITH_TOOLS = [
      'event: thinking\ndata: {"text":"正在分析用户的投放需求..."}\n\n',
      'event: tool_call\ndata: {"tool":"update_brief","input":{"industry":"农业机械"}}\n\n',
      'event: tool_result\ndata: {"tool":"update_brief","result":{"success":true}}\n\n',
      'event: delta\ndata: {"text":"已记录您的行业信息。"}\n\n',
      'event: done\ndata: {"status":"ok"}\n\n',
    ].join('');

    await page.route('**/api/campaign/sessions', route =>
      route.fulfill({
        json: {
          data: [{
            brief_id: 'brief-tools',
            session_id: null,
            first_message: null,
            status: 'intake',
            current_phase: 'intake',
            phase_index: 0,
            completion_pct: 0,
            created_at: '2026-03-23T14:00:00Z',
            updated_at: '2026-03-23T14:00:00Z',
          }],
        },
      })
    );

    await page.route('**/api/campaign/intake', route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ json: { brief_id: 'brief-tools' }, status: 201 });
      }
      return route.continue();
    });

    await page.route('**/api/campaign/intake/brief-tools', route =>
      route.fulfill({ json: { id: 'brief-tools', brief: {}, completion: {}, status: 'active' } })
    );

    await page.route('**/api/campaign/orchestrate/brief-tools', route =>
      route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: SSE_WITH_TOOLS })
    );

    await page.goto('/dashboard/campaign-studio');

    // Select session
    await page.click('text=新会话');

    // Send a message
    await page.fill('textarea[placeholder="输入消息，描述您的投放需求..."]', '我们是做农业机械的');
    await page.keyboard.press('Enter');

    // Should see thinking card (collapsed)
    await expect(page.locator('text=思考中')).toBeVisible({ timeout: 5000 });

    // Should see tool call card (collapsed)
    await expect(page.locator('text=调用工具: update_brief')).toBeVisible();

    // Should see AI response
    await expect(page.locator('text=已记录您的行业信息。')).toBeVisible();

    // Expand thinking card
    await page.click('text=思考中');
    await expect(page.locator('text=正在分析用户的投放需求...')).toBeVisible();
  });
});
