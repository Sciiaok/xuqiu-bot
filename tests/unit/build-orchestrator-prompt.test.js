import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Copied from campaign-orchestrator.service.js to avoid supabase dependency ──

const PHASES = [
  { key: 'research',      name: '市场调研', description: 'Analyzing market, competitors, and trends' },
  { key: 'strategy',      name: '方案规划', description: 'Generating media plan with budget allocation' },
  { key: 'creative_plan', name: '素材策划', description: 'Planning creative production tasks and collecting references' },
  { key: 'creative',      name: '素材生成', description: 'Generating ad creatives from product docs' },
  { key: 'execution',     name: '投放执行', description: 'Creating campaigns on Meta Ads', needsApproval: true },
];

const PROMPT_CORE = `你是数字广告投放主控 Agent。根据 Campaign Brief 智能编排投放流程。

## 默认流程
1. get_meta_assets — 获取广告账户可用资产（WhatsApp 号码、Page 等），了解账户能力
2. strategy — 基于账户资产规划媒体投放方案
3. creative_plan — 基于投放方案生成素材制作任务

strategy 和 creative_plan 是独立阶段，分开运行。如果其中一个失败，可以单独 retry_phase 而不影响另一个。

## 可选阶段（需要理由才执行）
- research：仅在大预算(>$500)、用户明确要求、或 brief 信息严重不足时执行
- creative：素材生成，在用户确认素材计划后执行
- execution：投放执行，仅在用户明确要求投放时执行

## 平台支持
- 方案规划(strategy)不限制平台 — 可以为 Meta、Google、TikTok 等多平台规划
- 自动执行(execution)目前仅支持 Meta Ads — 其他平台的执行方案以手动操作指南输出
- 调用 get_meta_assets 可获取 Meta 账户的可用资产（WhatsApp 号码、Page、Instagram 等），据此判断能力范围

## 指导原则
- run_phase 返回 quality.score 和 quality.issues，据此判断是否 retry
- quality.score 低且 issues 明确时，用 retry_phase 并给出针对性反馈
- execution 创建的广告是 PAUSED 状态，需用户确认后 activate_campaigns 激活

## 强制规则
- 只有在已尝试修复仍失败、或用户明确要求跳过时，才可 submit_final`;

const PROMPT_CREATIVE_FLOW = `

## 参考图片检查（在 creative_plan 之前，强制执行）
运行 creative_plan 之前，先检查 Brief 中的素材来源：
1. 检查 brief 中是否有 product_images（用户上传的图片）
2. 检查 brief 中是否有 website（可自动抓取产品图片）
3. 检查 brief 中是否有 products 信息（产品关键词可辅助搜索）

- 如果有 product_images 或 website → 直接运行 creative_plan，系统会自动提取参考图片
- 如果都没有 → 在运行 creative_plan 之前，先 request_user_feedback：
  - 告知用户：需要产品参考图片才能生成高质量广告素材
  - 建议：上传产品图片，或提供产品网站链接
  - 用户提供后，用 patch_brief 更新，再运行 creative_plan

重要：product_images 中的 Supabase Storage URL（含 /object/public/ 路径）是公开可访问的，所有 agent 可直接使用，无需额外处理或询问用户。

## 素材策划流程
- creative_plan 完成后，检查 references_count：
  - references_count > 0 → 展示素材计划，告知参考图片来源，提示用户也可上传更精准的产品图片
  - references_count === 0 → request_user_feedback 告知用户系统未能自动找到参考图片，请上传产品图片或提供更详细的网站链接
- 用户确认素材计划后再运行 creative 阶段生成实际图片
- creative 阶段在没有参考图片时会返回 blocked: true，必须先补充参考图片`;

const PROMPT_ERROR_HANDLING = `

## 错误处理流程
当阶段返回错误时：

1. 先调用 search_fix_knowledge 查找历史修复方案
   - similarity > 0.8 且 success_count > 0 → 按历史方案修复
   - 未找到或失败 → 进入第 2 步

2. 按错误类型处理：
   A. 需用户信息（如无效 URL）→ request_user_feedback 向用户索取 → patch_brief → retry_phase
   B. 可自动修复（如缺素材、受众过窄）→ 直接 retry_phase 或补跑前置阶段
   C. 不可修复（如 API 权限不足）→ request_user_feedback 告知用户

3. 修复成功后调用 save_fix_knowledge 记录经验

限制：每阶段最多自动修复 1 次，不要猜测用户私有信息`;

const PROMPT_EXECUTION_ERRORS = `

## Execution 错误处理（强制）
execution 返回 partial/failed 时，**禁止**直接调用 submit_final。必须分析 error_details，然后执行以下之一：
1. 可自动修复 → retry_phase('execution', '修复说明')
2. 需要用户信息 → request_user_feedback 用通俗语言解释问题 + 需要什么操作
3. 前置阶段数据有问题 → 先修复前置阶段再 retry_phase

### 错误分类
- URL 无效（"not a valid URI"、"invalid URL"）→ request_user_feedback 向用户索取正确的网站/落地页地址，然后 patch_brief + retry_phase
- 受众过窄（"audience too small"、"targeting"）→ retry_phase 并指示放宽受众条件
- 参数缺失（"missing field"、"invalid parameter"）→ 分析是 brief 缺数据还是方案配置错误，前者问用户，后者 retry_phase
- 权限/Token 错误（"permission"、"token"、"OAuthException"）→ request_user_feedback 告知用户需检查 Meta 账号权限配置
- 素材缺失（"No image_hash"、"No creative"）→ 检查 creative 阶段是否成功，必要时 retry_phase('creative')

重要：向用户解释时，用通俗语言说明问题和需要的操作，不要只列出原始英文错误信息`;

function buildOrchestratorPrompt(phaseResults) {
  const completed = new Set(Object.keys(phaseResults));
  let prompt = PROMPT_CORE;

  // Inject pending phase descriptions
  const pending = PHASES.filter(p => !completed.has(p.key));
  if (pending.length > 0) {
    prompt += `\n\n## 待执行阶段\n${pending.map(p => `- ${p.key}: ${p.description}`).join('\n')}`;
  }

  // Inject creative flow rules only when creative phases are pending
  if (!completed.has('creative')) {
    prompt += PROMPT_CREATIVE_FLOW;
  }

  // Inject error handling only when phase results contain errors
  const hasErrors = Object.values(phaseResults).some(
    r => r?.errors?.length || r?.status === 'error'
  );
  if (hasErrors || completed.size > 0) {
    prompt += PROMPT_ERROR_HANDLING;
  }

  // Inject execution error classification only when execution actually has errors
  const execResult = phaseResults.execution;
  if (execResult && (execResult.status !== 'completed' || execResult.errors?.length)) {
    prompt += PROMPT_EXECUTION_ERRORS;
  }

  return prompt;
}

// ── Tests ──

describe('buildOrchestratorPrompt', () => {

  it('1. empty phaseResults — includes core, all pending phases, creative flow; excludes error handling', () => {
    const prompt = buildOrchestratorPrompt({});

    assert.ok(prompt.includes('你是数字广告投放主控 Agent'), 'should contain PROMPT_CORE');
    assert.ok(prompt.includes('## 待执行阶段'), 'should contain pending phases section');
    // All 5 phases listed
    for (const phase of PHASES) {
      assert.ok(prompt.includes(`- ${phase.key}: ${phase.description}`), `should list ${phase.key}`);
    }
    assert.ok(prompt.includes('参考图片检查'), 'should contain PROMPT_CREATIVE_FLOW');
    assert.ok(!prompt.includes('错误处理流程'), 'should NOT contain PROMPT_ERROR_HANDLING');
    assert.ok(!prompt.includes('Execution 错误处理'), 'should NOT contain PROMPT_EXECUTION_ERRORS');
  });

  it('2. research completed (no errors) — 4 pending phases, creative flow, error handling', () => {
    const prompt = buildOrchestratorPrompt({ research: { recommendations: ['r1'] } });

    assert.ok(prompt.includes('你是数字广告投放主控 Agent'));
    // 4 pending phases (not research)
    assert.ok(!prompt.includes('- research:'), 'research should not be in pending');
    assert.ok(prompt.includes('- strategy:'));
    assert.ok(prompt.includes('- creative_plan:'));
    assert.ok(prompt.includes('- creative:'));
    assert.ok(prompt.includes('- execution:'));
    assert.ok(prompt.includes('参考图片检查'), 'should contain PROMPT_CREATIVE_FLOW');
    assert.ok(prompt.includes('错误处理流程'), 'should contain PROMPT_ERROR_HANDLING');
    assert.ok(!prompt.includes('Execution 错误处理'), 'should NOT contain PROMPT_EXECUTION_ERRORS');
  });

  it('3. strategy + creative_plan completed — 3 pending phases, creative flow, error handling', () => {
    const prompt = buildOrchestratorPrompt({
      strategy: { platforms: [] },
      creative_plan: { creative_tasks: [] },
    });

    // 3 remaining phases
    assert.ok(prompt.includes('- research:'));
    assert.ok(!prompt.includes('- strategy:'), 'strategy should not be in pending');
    assert.ok(!prompt.includes('- creative_plan:'), 'creative_plan should not be in pending');
    assert.ok(prompt.includes('- creative:'));
    assert.ok(prompt.includes('- execution:'));
    assert.ok(prompt.includes('参考图片检查'), 'creative not done => PROMPT_CREATIVE_FLOW');
    assert.ok(prompt.includes('错误处理流程'), 'completed.size > 0 => PROMPT_ERROR_HANDLING');
  });

  it('4. creative completed — no creative flow, has error handling', () => {
    const prompt = buildOrchestratorPrompt({
      strategy: { platforms: [] },
      creative_plan: { creative_tasks: [] },
      creative: { images: [] },
    });

    assert.ok(!prompt.includes('参考图片检查'), 'creative done => no PROMPT_CREATIVE_FLOW');
    assert.ok(prompt.includes('错误处理流程'), 'completed.size > 0 => PROMPT_ERROR_HANDLING');
  });

  it('5. all phases completed — no pending section, no creative flow, has error handling', () => {
    const prompt = buildOrchestratorPrompt({
      research: {},
      strategy: {},
      creative_plan: {},
      creative: {},
      execution: { status: 'completed', errors: [] },
    });

    assert.ok(!prompt.includes('## 待执行阶段'), 'no pending phases');
    assert.ok(!prompt.includes('参考图片检查'), 'creative done => no PROMPT_CREATIVE_FLOW');
    assert.ok(prompt.includes('错误处理流程'), 'completed.size > 0 => PROMPT_ERROR_HANDLING');
  });

  it('6. phase with error status — includes error handling', () => {
    const prompt = buildOrchestratorPrompt({ strategy: { status: 'error' } });

    assert.ok(prompt.includes('错误处理流程'), 'hasErrors = true => PROMPT_ERROR_HANDLING');
  });

  it('7. execution with errors array — includes error handling and execution errors', () => {
    const prompt = buildOrchestratorPrompt({
      execution: { errors: [{ level: 'ad', name: 'test', error: 'fail' }] },
    });

    assert.ok(prompt.includes('错误处理流程'), 'hasErrors => PROMPT_ERROR_HANDLING');
    assert.ok(prompt.includes('Execution 错误处理'), 'execution has errors => PROMPT_EXECUTION_ERRORS');
  });

  it('8. execution completed with errors — includes execution errors', () => {
    const prompt = buildOrchestratorPrompt({
      execution: { status: 'completed', errors: [{ level: 'ad', name: 'x', error: 'y' }] },
    });

    assert.ok(prompt.includes('Execution 错误处理'), 'status completed but has errors => PROMPT_EXECUTION_ERRORS');
  });

  it('9. execution completed successfully — no execution errors', () => {
    const prompt = buildOrchestratorPrompt({
      execution: { status: 'completed', errors: [] },
    });

    assert.ok(!prompt.includes('Execution 错误处理'), 'clean completion => no PROMPT_EXECUTION_ERRORS');
  });

  it('10. execution with partial status — includes execution errors', () => {
    const prompt = buildOrchestratorPrompt({
      execution: { status: 'partial' },
    });

    assert.ok(prompt.includes('Execution 错误处理'), 'partial status => PROMPT_EXECUTION_ERRORS');
  });

  it('11. prompt always starts with PROMPT_CORE content', () => {
    const prompt = buildOrchestratorPrompt({});
    const firstLine = prompt.split('\n')[0];
    assert.ok(firstLine.includes('你是数字广告投放主控 Agent'), 'first line should contain core identifier');
  });

  it('12. pending phases are in correct order', () => {
    const prompt = buildOrchestratorPrompt({ research: {} });

    const pendingSection = prompt.split('## 待执行阶段')[1].split('##')[0];
    const strategyIdx = pendingSection.indexOf('- strategy:');
    const creativePlanIdx = pendingSection.indexOf('- creative_plan:');
    const creativeIdx = pendingSection.indexOf('- creative:');
    const executionIdx = pendingSection.indexOf('- execution:');

    assert.ok(strategyIdx < creativePlanIdx, 'strategy before creative_plan');
    assert.ok(creativePlanIdx < creativeIdx, 'creative_plan before creative');
    assert.ok(creativeIdx < executionIdx, 'creative before execution');
  });

});
