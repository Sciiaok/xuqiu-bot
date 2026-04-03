import { anthropic, MODELS, onLlmEvent } from './llm-client.js';
import { config } from './config.js';
import { getBrief, updateBriefFields, sanitizeBriefFields } from '../lib/repositories/campaign-brief.repository.js';

import {
  createSession,
  getSession,
  updateSession,
  updateSessionIfStatus,
  addMessages,
  getMessagesForClaude,
  getNextMessageIndex,
  attachmentsToContentBlocks,
} from '../lib/repositories/orchestrator.repository.js';
import supabase from '../lib/supabase.js';
import { conductResearch } from './research-agent.service.js';
import { generateMediaPlan, generateCampaignPlan, generateCampaignPlanParallel } from './strategy-agent.service.js';
import { generateFromDocument } from './aigc.service.js';
import { executeMediaPlan, previewExecution, activateCampaigns } from './execution-agent.service.js';
import { fetchAccountAssets } from './meta-account.service.js';
import { generateCreativePlan } from './creative-plan.service.js';
import { extractBriefImages } from './reference-collector.service.js';
import { searchFixes, saveFix } from '../lib/repositories/fix-knowledge.repository.js';

const HEARTBEAT_INTERVAL_MS = 2000;

// ── Phase definitions ──────────────────────────────────────────────────

const PHASES = [
  { key: 'research',           name: '市场调研', description: 'Analyzing market, competitors, and trends' },
  { key: 'strategy',           name: '方案规划', description: 'Generating media plan with budget allocation' },
  { key: 'creative_plan',      name: '素材策划', description: 'Planning creative production tasks and collecting references' },
  { key: 'creative',           name: '素材生成', description: 'Generating ad creatives from product docs' },
  { key: 'execution',          name: '投放执行', description: 'Creating campaigns on Meta Ads', needsApproval: true },
];

// Map brief fields to the earliest phase they feed into.
// Used by patch_brief to warn that completed phases are now stale.
const BRIEF_FIELD_TO_PHASE = {
  budget_total:           'strategy',
  budget_currency:        'strategy',
  campaign_duration_days: 'strategy',
  target_countries:       'strategy',
  target_audience:        'strategy',
  preferred_platforms:    'strategy',
  objectives:             'strategy',
  products:               'strategy',
  product_images:         'creative_plan',
  reference_images:       'creative_plan',
  reference_image_url:    'creative_plan',
  website:                'creative_plan',
  existing_landing_pages: 'execution',
};

// Downstream phases that must be invalidated when an upstream phase is rerun.
// creative reads ad names from strategy; execution reads image keys from creative.
const PHASE_DOWNSTREAM = {
  research:      ['strategy', 'creative_plan', 'creative', 'execution'],
  strategy:      ['creative_plan', 'creative', 'execution'],
  creative_plan: ['creative', 'execution'],
  creative:      ['execution'],
  execution:     [],
};

// ── Helper: run a Promise with heartbeat yields ────────────────────────

async function* runWithHeartbeat(phaseKey, workFn) {
  const startTime = Date.now();
  const eventQueue = [];
  let settled = false;
  let resolveWait = null;

  function notify() {
    if (resolveWait) { const r = resolveWait; resolveWait = null; r(); }
  }

  const timer = setInterval(() => {
    if (settled) return;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    eventQueue.push({ event: 'heartbeat', data: { phase: phaseKey, elapsed_s: Number(elapsed) } });
    notify();
  }, HEARTBEAT_INTERVAL_MS);

  const onProgress = (step) => {
    if (settled) return;
    eventQueue.push({ event: 'phase_progress', data: { phase: phaseKey, ...step } });
    notify();
  };

  // Forward LLM-layer events (fallback / error) as phase_progress
  const unsubLlm = onLlmEvent((evt) => {
    if (settled) return;
    if (evt.type === 'fallback') {
      eventQueue.push({ event: 'phase_progress', data: { phase: phaseKey, step: 'llm_fallback', detail: `LLM 降级: ${evt.from} → ${evt.to} (${evt.error})`, ...evt } });
    } else if (evt.type === 'error') {
      eventQueue.push({ event: 'phase_progress', data: { phase: phaseKey, step: 'llm_error', detail: `LLM 错误: ${evt.provider} ${evt.model} — ${evt.error}`, ...evt } });
    }
    notify();
  });

  let result, error;
  workFn(onProgress)
    .then(r => { result = r; })
    .catch(e => { error = e; })
    .finally(() => { settled = true; clearInterval(timer); unsubLlm(); notify(); });

  while (!settled) {
    while (eventQueue.length > 0) yield eventQueue.shift();
    // Re-check after draining — events may have arrived during yield
    if (!settled && eventQueue.length === 0) {
      await new Promise(r => { resolveWait = r; });
    }
  }
  while (eventQueue.length > 0) yield eventQueue.shift();

  if (error) throw error;
  yield { event: '__result', data: result };
}

// ── Agent wrappers that persist tool_use conversations ─────────────────

/**
 * Wrap an agent call to persist its Claude tool_use conversation.
 */
async function runAgentWithTrace(sessionId, phaseKey, agentFn, agentArgs) {
  // Patch the agent to capture messages (agents return results, not messages)
  // We persist the inputs/outputs as trace messages after the agent completes
  const startIndex = await getNextMessageIndex(sessionId);
  const startTime = new Date().toISOString();

  const result = await agentFn(...agentArgs);

  // Persist a summary trace (the full tool_use loop is inside the agent)
  await addMessages(sessionId, [
    {
      phase: phaseKey,
      role: 'event',
      content: `[Agent ${phaseKey}] Started at ${startTime}\nInput: ${JSON.stringify(agentArgs[0])}`,
      message_index: startIndex,
    },
    {
      phase: phaseKey,
      role: 'event',
      content: `[Agent ${phaseKey}] Completed\nResult keys: ${Object.keys(result || {}).join(', ')}`,
      tool_result: result,
      message_index: startIndex + 1,
    },
  ]);

  return result;
}

// ── Phase executors ────────────────────────────────────────────────────

async function runResearch(sessionId, brief, _phaseResults, instructions, onProgress) {
  return runAgentWithTrace(sessionId, 'research', conductResearch, [brief.brief || {}, instructions, onProgress]);
}

async function runStrategy(sessionId, brief, phaseResults, instructions, onProgress) {
  return runAgentWithTrace(sessionId, 'strategy', generateCampaignPlanParallel, [
    brief.brief || {}, phaseResults.research, instructions, onProgress,
  ]);
}

async function runCreativePlan(sessionId, brief, phaseResults, instructions, onProgress) {
  return runAgentWithTrace(sessionId, 'creative_plan', generateCreativePlan, [
    brief.brief || {},
    phaseResults.research || {},
    phaseResults.strategy || {},
    instructions,
    onProgress,
  ]);
}

async function runCreative(sessionId, brief, phaseResults, _instructions, onProgress) {
  const startIndex = await getNextMessageIndex(sessionId);
  const startTime = new Date().toISOString();
  const mediaPlan = phaseResults.strategy;
  const briefData = brief.brief || {};
  // Merge references from two sources to guard against creative_plan collection failure:
  // 1. creative_plan phase output (website, competitor ads, AND brief images)
  // 2. brief directly (fallback — extractBriefImages covers product_images, reference_images, reference_image_url)
  const planRefs = phaseResults.creative_plan?.references || [];
  const briefImgRefs = extractBriefImages(briefData).map(img => ({
    source: 'user_upload', url: img.url, description: img.description,
  }));
  // Deduplicate by URL, brief images first (user-provided have highest priority)
  const seen = new Set();
  const referenceImages = [];
  for (const img of [...briefImgRefs, ...planRefs]) {
    if (img?.url && !seen.has(img.url)) {
      seen.add(img.url);
      referenceImages.push(img);
    }
  }

  const metaPlatform = mediaPlan?.platforms?.find(p => p.platform === 'meta');
  if (!metaPlatform) return { creatives: {}, skipped: true };

  // Gate: block creative generation without any reference images
  if (referenceImages.length === 0) {
    console.warn('[orchestrator] creative phase: no reference images from brief or creative_plan');
    return {
      creatives: {},
      blocked: true,
      reason: 'no_reference_images',
      message: '未找到参考图片。建议：1) 提供产品网站让系统自动抓取；2) 直接上传产品图片或参考素材。',
    };
  }
  console.log(`[orchestrator] creative phase starting with ${referenceImages.length} reference images (brief: ${briefImgRefs.length}, plan: ${planRefs.length})`);

  // Format products as human-readable text for extractProductInfo
  const productText = formatProductsAsText(briefData);

  // Detect target language from ad name/country hints
  const COUNTRY_LANG = {
    PT: 'Portuguese', SW: 'Swahili', AM: 'Amharic', AR: 'Arabic', FR: 'French', ES: 'Spanish',
  };

  // Collect all image ads for parallel generation
  const adJobs = [];
  for (const campaign of metaPlatform.campaigns || []) {
    for (const adSet of campaign.ad_sets || []) {
      for (const ad of adSet.ads || []) {
        if (ad.format === 'image') {
          const productMatch = (ad.name || '').match(/[A-Z]{2,}[_-]?\d+/i);
          const targetProduct = productMatch ? productMatch[0].replace('_', '-') : undefined;
          const langSuffix = (ad.name || '').match(/_([A-Z]{2})$/)?.[1];
          const language = COUNTRY_LANG[langSuffix] || undefined;
          adJobs.push({ ad, targetProduct, language });
        }
      }
    }
  }

  // Generate all creatives in parallel
  onProgress?.({ step: 'creative_start', detail: `开始生成 ${adJobs.length} 张广告素材`, total: adJobs.length, completed: 0 });
  let completedCount = 0;
  let errorCount = 0;
  const results = await Promise.allSettled(
    adJobs.map(({ ad, targetProduct, language }) =>
      generateFromDocument({
        pdfText: productText,
        userPrompt: ad.media_requirements.suggested_content,
        targetProduct,
        language,
        website: briefData.website,
        referenceImages,
        authClient: supabase,
      }).then(result => {
        completedCount++;
        onProgress?.({ step: 'creative_item', detail: `✓ ${ad.name} 生成完成 (${completedCount}/${adJobs.length})`, name: ad.name, completed: completedCount, total: adJobs.length, errors: errorCount });
        return { name: ad.name, result };
      }).catch(err => {
        completedCount++;
        errorCount++;
        onProgress?.({ step: 'creative_error', detail: `✗ ${ad.name} 失败: ${err.message} (${completedCount}/${adJobs.length})`, name: ad.name, error: err.message, completed: completedCount, total: adJobs.length, errors: errorCount });
        throw err;
      })
    )
  );

  const creatives = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      const { name, result } = r.value;
      creatives[name] = { url: result.url, storage_path: result.storage_path, asset_id: result.id };
    } else {
      creatives[adJobs[i].ad.name] = { error: r.reason?.message || 'Unknown error' };
    }
  }

  const successCount = Object.values(creatives).filter(c => !c.error).length;
  const failCount = Object.values(creatives).filter(c => c.error).length;
  onProgress?.({ step: 'creative_done', detail: `素材生成完成：${successCount} 成功${failCount ? `，${failCount} 失败` : ''}`, completed: adJobs.length, total: adJobs.length, success: successCount, errors: failCount });

  // Persist trace (consistent with runAgentWithTrace)
  await addMessages(sessionId, [
    {
      phase: 'creative',
      role: 'event',
      content: `[Agent creative] Started at ${startTime}\nInput: ${adJobs.length} ad images to generate`,
      message_index: startIndex,
    },
    {
      phase: 'creative',
      role: 'event',
      content: `[Agent creative] Completed\nResult keys: ${Object.keys(creatives).join(', ')}`,
      tool_result: { creatives },
      message_index: startIndex + 1,
    },
  ]);

  return { creatives };
}

async function runExecution(sessionId, brief, phaseResults, _instructions, onProgress) {
  const mediaPlan = phaseResults.strategy;
  const creativeResults = phaseResults.creative?.creatives || {};

  // Collect public URLs — Claude agent uploads to Meta via MCP upload_ad_image
  const creatives = {};
  for (const [adName, creative] of Object.entries(creativeResults)) {
    if (creative.error || !creative.url) continue;
    creatives[adName] = { url: creative.url };
  }

  // Use cached assets from phase_results, or fetch fresh
  const accountAssets = phaseResults.meta_assets?.available
    ? phaseResults.meta_assets
    : await fetchAccountAssets().catch(() => ({ available: false }));

  return runAgentWithTrace(sessionId, 'execution', executeMediaPlan, [
    mediaPlan,
    creatives,
    { link_url: pickValidUrl(brief.brief?.existing_landing_pages?.[0], brief.brief?.website) || 'https://revopanda.com', onProgress, accountAssets },
  ]);
}

// ── Orchestrator Agent Tools ──────────────────────────────────────────

const ORCHESTRATOR_TOOLS = [
  {
    name: 'run_phase',
    description: '执行指定的投放流程阶段。返回阶段结果摘要。creative_plan 会搜集参考素材并生成素材制作任务列表，应在 creative 前执行。',
    input_schema: {
      type: 'object',
      required: ['phase'],
      properties: {
        phase: { type: 'string', enum: ['research', 'strategy', 'creative_plan', 'creative', 'execution'] },
        instructions: { type: 'string', description: '给该阶段 agent 的额外指令（可选）' },
      },
    },
  },
  {
    name: 'request_user_feedback',
    description: '暂停流程，向用户提问或展示中间结果请求确认。用户回应后流程继续。',
    input_schema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: '给用户的选项按钮（可选）' },
      },
    },
  },
  {
    name: 'skip_phase',
    description: '跳过某个阶段并记录原因。',
    input_schema: {
      type: 'object',
      required: ['phase', 'reason'],
      properties: {
        phase: { type: 'string' },
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'retry_phase',
    description: '带修改指令重跑某阶段。之前的结果会被覆盖。用于错误修复后重试（如 execution 失败后修复 URL 再重跑）。',
    input_schema: {
      type: 'object',
      required: ['phase', 'feedback'],
      properties: {
        phase: { type: 'string', enum: ['research', 'strategy', 'creative_plan', 'creative', 'execution'] },
        feedback: { type: 'string', description: '对上次结果的修改要求，或错误修复说明' },
      },
    },
  },
  {
    name: 'patch_brief',
    description: '修复 Campaign Brief 中的字段。当阶段执行出错且原因是 brief 数据问题时（如无效 URL、缺少字段），先用此工具修复 brief，再 retry_phase 重试。',
    input_schema: {
      type: 'object',
      required: ['fields', 'reason'],
      properties: {
        fields: { type: 'object', description: '要修复/补充的字段，如 { "website": "https://example.com" }' },
        reason: { type: 'string', description: '修复原因，用于记录' },
      },
    },
  },
  {
    name: 'preview_execution',
    description: '预览投放方案的实际执行计划（广告系列、广告组、预算分配），不会真正创建广告。适合在 request_user_feedback 前调用，给用户展示具体会创建什么。',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'read_phase_detail',
    description: '读取某阶段结果的特定字段，用于深入分析。比如查看 research 的具体 recommendations，或 strategy 的某个 campaign 细节。',
    input_schema: {
      type: 'object',
      required: ['phase', 'field'],
      properties: {
        phase: { type: 'string', enum: ['research', 'strategy', 'creative_plan', 'creative', 'execution'] },
        field: { type: 'string', description: '要查看的字段路径，如 "recommendations", "platforms[0].campaigns", "creative_tasks[0].concept"' },
      },
    },
  },
  {
    name: 'activate_campaigns',
    description: '将所有 PAUSED 状态的广告系列激活为 ACTIVE，广告开始正式投放。必须在 execution 完成且用户确认后才能调用。',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'search_fix_knowledge',
    description: '在修复经验库中搜索相似错误的历史解决方案。当阶段出错时，先调用此工具看看以前是否遇到过类似问题。返回匹配的历史修复方案和成功次数。',
    input_schema: {
      type: 'object',
      required: ['error_text'],
      properties: {
        error_text: { type: 'string', description: '错误信息文本' },
        phase: { type: 'string', description: '出错的阶段' },
      },
    },
  },
  {
    name: 'save_fix_knowledge',
    description: '将成功的修复经验保存到经验库，供未来遇到类似问题时参考。修复成功后必须调用。',
    input_schema: {
      type: 'object',
      required: ['error_pattern', 'solution'],
      properties: {
        error_pattern: { type: 'string', description: '错误模式描述，如 "follow_up_action_url is not a valid URI"' },
        error_context: { type: 'string', description: '错误发生的上下文，如 "execution 阶段创建 lead form 时"' },
        solution: { type: 'string', description: '解决方案描述，如 "brief 中的 website 字段不是有效 URL，需要向用户索取合法 URL"' },
        solution_type: { type: 'string', enum: ['auto', 'user_provided', 'web_search'], description: '解决方案来源' },
      },
    },
  },
  {
    name: 'get_meta_assets',
    description: '获取 Meta 广告账户的可用资产（WhatsApp 号码、Page、Instagram 账户等）。在规划 WhatsApp 消息广告或需要了解账户能力时调用。',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'submit_final',
    description: '标记编排完成，提交最终结果摘要。',
    input_schema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string' },
        skipped_phases: { type: 'array', items: { type: 'string' } },
      },
    },
  },
];

// ── System Prompt Modules (dynamically assembled) ────────────────────

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
- 只有在已尝试修复仍失败、或用户明确要求跳过时，才可 submit_final
- 不要建议用户使用 Midjourney/DALL·E/Canva 等外部工具 — 本系统自动生成素材
- 不要让用户手动操作任何后台 — 所有操作通过工具调用完成`;

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

/**
 * Build system prompt dynamically based on current orchestration state.
 * Only injects modules relevant to the current phase.
 */
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

const MAX_ORCHESTRATOR_ITERATIONS = 25;

// ── Deterministic evaluation ──────────────────────────────────────────

function evaluateOutput(phase, result) {
  const issues = [];

  switch (phase) {
    case 'research':
      if (!result?.recommendations?.length) issues.push('缺少建议 (recommendations)');
      if (!result?.platform_recommendations?.length) issues.push('缺少平台推荐 (platform_recommendations)');
      if (!result?.competitor_ads?.summary) issues.push('缺少竞品广告分析 (competitor_ads)');
      break;
    case 'strategy':
      if (!result?.platforms?.length) issues.push('缺少平台方案 (platforms)');
      else {
        let totalAlloc = result.platforms.reduce((s, p) => s + (p.budget_allocation || 0), 0);
        // Tolerate decimal form (0.4 = 40%)
        if (totalAlloc > 0 && totalAlloc <= 1.1) totalAlloc = Math.round(totalAlloc * 100);
        if (Math.abs(totalAlloc - 100) > 5) issues.push(`预算分配总和 ${totalAlloc}%，偏离 100%`);
        const hasCampaigns = result.platforms.some(p => p.campaigns?.length > 0);
        if (!hasCampaigns) issues.push('缺少广告系列 (campaigns)');
      }
      break;
    case 'creative_plan':
      if (!result?.creative_tasks?.length) issues.push('未生成素材制作任务');
      else {
        const missingPrompts = result.creative_tasks.filter(t => !t.image_prompt);
        if (missingPrompts.length) issues.push(`${missingPrompts.length} 个任务缺少图片生成 Prompt`);
      }
      if (!result?.references?.length) issues.push('未搜集到参考素材');
      break;
    case 'creative': {
      const creatives = result?.creatives || {};
      const errors = Object.values(creatives).filter(c => c.error);
      if (errors.length) issues.push(`${errors.length} 个素材生成失败`);
      break;
    }
    case 'execution':
      if (result?.status !== 'completed') issues.push(`执行状态: ${result?.status || 'unknown'}`);
      if (result?.errors?.length) {
        const details = result.errors.slice(0, 5).map(e => `  [${e.level}] ${e.name}: ${e.error}`);
        issues.push(`${result.errors.length} 个执行错误:\n${details.join('\n')}`);
      }
      break;
  }

  const score = Math.max(0, 100 - issues.length * 25);
  return { score, issues, suggestions: issues.map(i => `修复: ${i}`) };
}

// ── Shared tool-use loop ───────────────────────────────────────────────

/**
 * Shared tool-use loop for orchestrate() and resumeAfterFeedback().
 * @param {string} sessionId
 * @param {Object} brief - The full brief object from DB
 * @param {Array} messages - Claude messages array (mutated in place)
 * @param {Object} initialPhaseResults - Starting phase results
 * @yields {{ event: string, data: Object }}
 */
async function* runToolUseLoop(sessionId, brief, messages, initialPhaseResults, initialFixLog) {
  let phaseResults = { ...initialPhaseResults };
  const MAX_FIX_LOG = 50;
  let fixLog = [...(initialFixLog || [])].slice(-MAX_FIX_LOG);
  for (let iteration = 0; iteration < MAX_ORCHESTRATOR_ITERATIONS; iteration++) {
    // Save checkpoint before each Claude call — enables recovery after crashes
    await updateSession(sessionId, {
      orchestrator_state: {
        type: 'checkpoint',
        messages: [...messages],
        phase_results_snapshot: phaseResults,
        fix_log_snapshot: fixLog,
        iteration,
      },
    });

    yield { event: 'phase_progress', data: { phase: 'orchestrator', step: 'thinking', detail: '主控 Agent 分析中…' } };
    let response;
    try {
      const llmStream = anthropic.messages.stream({
        model: MODELS.SONNET,
        max_tokens: 4096,
        system: buildOrchestratorPrompt(phaseResults),
        messages,
        tools: ORCHESTRATOR_TOOLS,
        tool_choice: { type: 'auto' },
      });

      // Stream reasoning text to frontend in real-time
      let textBuffer = '';
      for await (const event of llmStream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          textBuffer += event.delta.text;
          if (textBuffer.includes('\n') || textBuffer.length >= 80) {
            yield { event: 'phase_progress', data: { phase: 'orchestrator', step: 'reasoning_delta', detail: textBuffer } };
            textBuffer = '';
          }
        }
      }
      if (textBuffer) {
        yield { event: 'phase_progress', data: { phase: 'orchestrator', step: 'reasoning_delta', detail: textBuffer } };
      }

      response = await llmStream.finalMessage();
    } catch (err) {
      console.error(`[orchestrator] LLM stream failed at iteration ${iteration}:`, err.message);
      await updateSessionIfStatus(sessionId, 'running', { status: 'interrupted', current_phase: 'orchestrating' });
      yield { event: 'error', data: { message: `主控 Agent 调用失败: ${err.message}`, recoverable: true } };
      return;
    }

    if (response.stop_reason !== 'tool_use') {
      await updateSessionIfStatus(sessionId, 'running', { status: 'completed', current_phase: 'done', orchestrator_state: null });
      yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults) } };
      return;
    }

    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
    // Surface orchestrator tool calls so the frontend ThinkingCard shows them
    for (const block of toolUseBlocks) {
      yield { event: 'phase_progress', data: { phase: 'orchestrator', step: 'tool_call', detail: `调用 ${block.name}`, tool: block.name, input: block.input } };
    }
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    let pendingFeedback = null;
    let shouldTerminate = false;
    let terminateSummary = '';

    for (const block of toolUseBlocks) {
      const { id, name, input } = block;

      // After feedback is requested, defer remaining tools with placeholder results
      if (pendingFeedback) {
        toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ deferred: 'Waiting for user feedback' }) });
        continue;
      }

      let result;

      switch (name) {
        case 'run_phase':
        case 'retry_phase': {
          const phaseKey = input.phase;
          const phaseDef = PHASES.find(p => p.key === phaseKey);
          await addMessages(sessionId, [{
            phase: phaseKey, role: 'event', tool_name: 'phase_start',
            content: phaseDef?.name || phaseKey, message_index: await getNextMessageIndex(sessionId),
          }]);
          yield { event: 'phase_start', data: { phase: phaseKey, name: phaseDef?.name || phaseKey } };
          const phaseStartTime = Date.now();
          try {
            const executor = getPhaseExecutor(phaseKey);
            const instructions = name === 'retry_phase' ? input.feedback : input.instructions;
            const heartbeatGen = runWithHeartbeat(
              phaseKey,
              (onProgress) => executor(sessionId, brief, phaseResults, instructions, onProgress),
            );
            let phaseResult;
            const progressEvents = [];
            for await (const evt of heartbeatGen) {
              if (evt.event === '__result') {
                phaseResult = evt.data;
              } else {
                if (evt.event === 'phase_progress') progressEvents.push(evt);
                yield evt;
              }
            }
            // Persist progress events so they survive page refresh
            if (progressEvents.length > 0) {
              let progIdx = await getNextMessageIndex(sessionId);
              await addMessages(sessionId, progressEvents.map(evt => ({
                phase: phaseKey, role: 'event', tool_name: 'phase_progress',
                content: evt.data?.detail || evt.data?.step || '',
                message_index: progIdx++,
              })));
            }
            // Strategy merged flow: merge into fresh DB copy to avoid overwriting concurrent updates
            const freshSession = await getSession(sessionId);
            phaseResults = { ...(freshSession?.phase_results || {}), [phaseKey]: phaseResult };
            // Cascade: invalidate downstream phases whose inputs just changed
            const stale = PHASE_DOWNSTREAM[phaseKey] || [];
            for (const dk of stale) {
              if (phaseResults[dk]) {
                console.log(`[orchestrator] cascade: invalidating ${dk} (upstream ${phaseKey} rerun)`);
                delete phaseResults[dk];
              }
            }
            await updateSession(sessionId, { phase_results: phaseResults, current_phase: phaseKey });
            const duration = Math.round((Date.now() - phaseStartTime) / 1000);
            const resultSummary = summarizePhaseResult(phaseKey, phaseResult);
            await addMessages(sessionId, [{
              phase: phaseKey, role: 'event', tool_name: 'phase_complete',
              content: resultSummary, tool_result: { duration, result_summary: resultSummary },
              message_index: await getNextMessageIndex(sessionId),
            }]);
            yield { event: 'phase_complete', data: { phase: phaseKey, name: phaseDef?.name || phaseKey, result: phaseResult, duration, result_summary: resultSummary } };
            const evaluation = evaluateOutput(phaseKey, phaseResult);
            // Surface execution errors at top level so the orchestrator agent can't miss them
            const hasPhaseErrors = phaseResult?.status && phaseResult.status !== 'completed' && phaseResult.status !== 'skipped';
            result = {
              status: hasPhaseErrors ? `completed_with_errors` : 'completed',
              result_summary: resultSummary,
              duration_s: duration,
              quality: evaluation,
              ...(fixLog.length > 0 ? { fix_attempts: fixLog.length } : {}),
              ...(hasPhaseErrors && phaseResult.errors?.length && {
                error_details: phaseResult.errors.slice(0, 8),
              }),
            };
          } catch (err) {
            await addMessages(sessionId, [{
              phase: phaseKey, role: 'event', tool_name: 'phase_error',
              content: err.message, message_index: await getNextMessageIndex(sessionId),
            }]);
            yield { event: 'phase_error', data: { phase: phaseKey, error: err.message } };
            result = { status: 'error', error: err.message };
          }
          break;
        }

        case 'request_user_feedback': {
          pendingFeedback = { id, message: input.message, options: input.options };
          continue;
        }

        case 'preview_execution': {
          const strategyResult = phaseResults.strategy;
          if (!strategyResult) {
            result = { error: 'strategy 阶段尚未完成，无法预览' };
          } else {
            result = previewExecution(strategyResult);
          }
          break;
        }

        case 'read_phase_detail': {
          const phaseData = phaseResults[input.phase];
          if (!phaseData) {
            result = { error: `${input.phase} 阶段尚未完成` };
          } else {
            const value = getNestedField(phaseData, input.field);
            result = value !== undefined ? { field: input.field, value } : { error: `字段 "${input.field}" 不存在` };
          }
          break;
        }

        case 'search_fix_knowledge': {
          try {
            const fixes = await searchFixes(`${input.error_text} ${input.phase || ''}`);
            if (fixes.length > 0) {
              result = {
                found: true,
                matches: fixes.map(f => ({
                  error_pattern: f.error_pattern,
                  solution: f.solution,
                  solution_action: f.solution_action,
                  solution_type: f.solution_type,
                  success_count: f.success_count,
                  similarity: f.similarity,
                })),
              };
            } else {
              result = { found: false, message: '经验库中没有类似错误的修复记录' };
            }
          } catch (err) {
            result = { found: false, error: err.message };
          }
          break;
        }

        case 'save_fix_knowledge': {
          try {
            const saveResult = await saveFix({
              errorPattern: input.error_pattern,
              errorContext: input.error_context,
              solution: input.solution,
              solutionType: input.solution_type || 'auto',
            });
            result = saveResult;
          } catch (err) {
            result = { action: 'failed', error: err.message };
          }
          break;
        }

        case 'patch_brief': {
          const { fields, reason } = input;
          try {
            const sanitized = sanitizeBriefFields(fields, brief.brief);
            await updateBriefFields(brief.id, sanitized);
            brief.brief = { ...(brief.brief || {}), ...sanitized };
            fixLog.push({ timestamp: new Date().toISOString(), fields: Object.keys(fields), reason });
            await updateSession(sessionId, { fix_log: fixLog });
            await addMessages(sessionId, [{
              phase: null, role: 'event', tool_name: 'brief_patched',
              content: reason, tool_result: { fields: Object.keys(fields), reason },
              message_index: await getNextMessageIndex(sessionId),
            }]);
            yield { event: 'brief_patched', data: { fields: Object.keys(fields), reason } };

            // Detect phases that are already completed but now stale due to this patch
            const stalePhases = new Set();
            for (const f of Object.keys(sanitized)) {
              const earliest = BRIEF_FIELD_TO_PHASE[f];
              if (!earliest) continue;
              // Add the earliest phase and all its downstream dependents
              if (phaseResults[earliest]) stalePhases.add(earliest);
              for (const dk of (PHASE_DOWNSTREAM[earliest] || [])) {
                if (phaseResults[dk]) stalePhases.add(dk);
              }
            }

            result = { patched: true, fields: Object.keys(sanitized), reason };
            if (stalePhases.size > 0) {
              result.stale_phases = [...stalePhases];
              result.warning = `以下已完成的阶段使用了旧数据，建议 retry_phase 重跑: ${[...stalePhases].join(', ')}`;
            }
          } catch (err) {
            result = { error: `修复失败: ${err.message}` };
          }
          break;
        }

        case 'skip_phase':
          await addMessages(sessionId, [{
            phase: input.phase, role: 'event', tool_name: 'phase_skipped',
            content: input.reason, message_index: await getNextMessageIndex(sessionId),
          }]);
          yield { event: 'phase_skipped', data: { phase: input.phase, reason: input.reason } };
          result = { skipped: true, phase: input.phase, reason: input.reason };
          break;

        case 'get_meta_assets': {
          // Return cached assets if available, otherwise fetch and persist
          if (phaseResults.meta_assets?.available) {
            result = phaseResults.meta_assets;
          } else {
            try {
              const assets = await fetchAccountAssets();
              assets.fetched_at = new Date().toISOString();
              const freshForAssets = await getSession(sessionId);
              phaseResults = { ...(freshForAssets?.phase_results || {}), meta_assets: assets };
              await updateSession(sessionId, { phase_results: phaseResults });
              result = assets;
            } catch (err) {
              result = { available: false, error: err.message };
            }
          }
          break;
        }

        case 'activate_campaigns': {
          const execResult = phaseResults.execution;
          if (!execResult) {
            result = { error: 'execution 阶段尚未完成，无法激活' };
          } else {
            const activation = await activateCampaigns(execResult);
            yield { event: 'campaigns_activated', data: activation };
            result = activation;
          }
          break;
        }

        case 'submit_final':
          await updateSessionIfStatus(sessionId, 'running', { status: 'completed', current_phase: 'done', orchestrator_state: null });
          shouldTerminate = true;
          terminateSummary = input.summary;
          result = { completed: true };
          break;

        default:
          result = { error: `Unknown tool: ${name}` };
      }

      toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) });
    }

    if (pendingFeedback) {
      await updateSessionIfStatus(sessionId, 'running', {
        status: 'awaiting_feedback',
        orchestrator_state: {
          messages: [...messages],
          pending_tool_use_id: pendingFeedback.id,
          completed_tool_results: toolResults,
          phase_results_snapshot: phaseResults,
        },
      });
      await addMessages(sessionId, [{
        phase: null, role: 'event', tool_name: 'feedback_required',
        content: pendingFeedback.message,
        tool_result: { options: pendingFeedback.options },
        message_index: await getNextMessageIndex(sessionId),
      }]);
      yield { event: 'feedback_required', data: { message: pendingFeedback.message, options: pendingFeedback.options, tool_use_id: pendingFeedback.id } };
      return;
    }
    if (shouldTerminate) {
      yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults), summary: terminateSummary } };
      return;
    }
    messages.push({ role: 'user', content: toolResults });
  }

  await updateSessionIfStatus(sessionId, 'running', { status: 'completed', current_phase: 'done', orchestrator_state: null });
  yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults), summary: 'Force-terminated: max iterations reached' } };
}

// ── Main orchestrator generator ────────────────────────────────────────

/**
 * Orchestrate the full campaign pipeline using a Claude tool_use agent loop.
 *
 * @param {string} sessionId - Orchestrator session UUID
 * @yields {{ event: string, data: Object }}
 */
export async function* orchestrate(sessionId, options = {}, { userMessage, attachments } = {}) {
  const session = await getSession(sessionId);
  if (!session) {
    yield { event: 'error', data: { message: `Session ${sessionId} not found` } };
    return;
  }

  const brief = await getBrief(session.brief_id);
  if (!brief) {
    yield { event: 'error', data: { message: `Brief ${session.brief_id} not found` } };
    return;
  }

  // Resume from checkpoint if server crashed mid-orchestration
  if (session.status === 'running' && session.orchestrator_state?.type === 'checkpoint') {
    const state = session.orchestrator_state;
    yield {
      event: 'orchestration_resumed',
      data: {
        session_id: sessionId,
        brief_id: session.brief_id,
        iteration: state.iteration,
        phases: PHASES.map(p => ({ key: p.key, name: p.name })),
      },
    };
    yield* runToolUseLoop(
      sessionId, brief, state.messages,
      state.phase_results_snapshot || session.phase_results || {},
      state.fix_log_snapshot || session.fix_log || [],
    );
    return;
  }

  const briefData = brief.brief || {};
  const phaseResults = session.phase_results || {};
  // Block only if already running (prevents concurrent orchestration)
  if (session.status === 'running') {
    yield { event: 'error', data: { message: 'Orchestration is already running' } };
    return;
  }
  const { updated } = await updateSessionIfStatus(sessionId, session.status, { status: 'running', current_phase: 'orchestrating' });
  if (!updated) {
    yield { event: 'error', data: { message: 'Session status changed concurrently — not starting' } };
    return;
  }

  yield {
    event: 'orchestration_start',
    data: {
      session_id: sessionId,
      brief_id: session.brief_id,
      phases: PHASES.map(p => ({ key: p.key, name: p.name })),
    },
  };

  const existingResults = Object.keys(phaseResults).length > 0
    ? `\n\n已完成阶段结果:\n${Object.entries(phaseResults).map(([k, v]) => `${k}: ${JSON.stringify(summarizePhaseResult(k, v))}`).join('\n')}`
    : '';

  const phaseInstruction = options.phases
    ? `\n\n指定执行阶段: ${options.phases.join(' → ')}`
    : '';

  const refSources = [];
  if (briefData.product_images?.length) refSources.push(`${briefData.product_images.length} 张用户上传的产品图片`);
  if (briefData.reference_images?.length) refSources.push(`${briefData.reference_images.length} 张参考图片`);
  if (briefData.website) refSources.push(`产品网站 ${briefData.website}`);
  const imageNote = refSources.length
    ? `\n\n可用素材来源：${refSources.join('、')}。`
    : '\n\n⚠️ Brief 中没有产品图片、参考图片或产品网站，在运行 creative_plan 之前需要向用户索取。';

  const messages = [];
  if (userMessage) {
    // Chat-initiated: load conversation history (phase=null user/assistant messages,
    // excluding the current message which was just persisted by chatWithOrchestrator)
    let chatHistory = await getMessagesForClaude(sessionId, { phase: null });
    // Drop the last user message (it's the current one we'll add below)
    if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'user') {
      chatHistory = chatHistory.slice(0, -1);
    }
    // Build: context → history → current user message
    messages.push({
      role: 'user',
      content: `CAMPAIGN BRIEF:\n${JSON.stringify(briefData)}${existingResults}${imageNote}\n\n(以上是当前投放 Brief 和进度概览)`,
    });
    if (chatHistory.length > 0) {
      messages.push({ role: 'assistant', content: '已了解当前 Brief 和投放进度，请问有什么需要？' });
      messages.push(...chatHistory);
    }
    messages.push({
      role: 'user',
      content: `${userMessage}\n\n请先回应用户的消息。如果用户在询问信息（如查看资产、方案细节），直接回答即可，不要启动阶段执行。只有当用户明确要求执行操作（如"开始投放"、"生成素材"、"继续"）时，才调用 run_phase。`,
    });
  } else {
    // Pipeline-initiated: auto-start orchestration
    messages.push({
      role: 'user',
      content: `请根据以下 Campaign Brief 编排投放流程。\n\nCAMPAIGN BRIEF:\n${JSON.stringify(briefData)}${existingResults}${phaseInstruction}${imageNote}`,
    });
  }

  yield* runToolUseLoop(sessionId, brief, messages, phaseResults, session.fix_log || []);
}

/**
 * Resume orchestration after user feedback.
 * @param {string} sessionId
 * @param {string} userResponse
 * @yields {{ event: string, data: Object }} SSE events
 */
export async function* resumeAfterFeedback(sessionId, userResponse, { attachments } = {}) {
  const session = await getSession(sessionId);
  if (!session) {
    yield { event: 'error', data: { message: `Session ${sessionId} not found` } };
    return;
  }

  const validStatuses = ['awaiting_feedback', 'awaiting_approval'];
  if (!validStatuses.includes(session.status)) {
    yield { event: 'error', data: { message: `Session is not awaiting feedback (status: ${session.status})` } };
    return;
  }

  const state = session.orchestrator_state;
  if (!state || !state.pending_tool_use_id) {
    // Backward compat: old-style awaiting_approval sessions have no orchestrator_state
    if (session.status === 'awaiting_approval') {
      yield* orchestrate(sessionId);
      return;
    }
    yield { event: 'error', data: { message: 'No pending feedback state found' } };
    return;
  }

  const brief = await getBrief(session.brief_id);
  if (!brief) {
    yield { event: 'error', data: { message: `Brief ${session.brief_id} not found` } };
    return;
  }

  // Persist uploaded images to brief.product_images
  if (attachments?.length) {
    const newImages = attachments
      .filter(a => a.content_type?.startsWith('image/'))
      .map(a => ({ url: a.url, filename: a.filename }));
    if (newImages.length) {
      const existing = brief.brief?.product_images || [];
      const existingUrls = new Set(existing.map(img => img.url));
      const deduped = newImages.filter(img => !existingUrls.has(img.url));
      if (deduped.length) {
        await updateBriefFields(brief.id, {
          product_images: [...existing, ...deduped],
        });
      }
    }
  }

  // Restore state
  let phaseResults = state.phase_results_snapshot || session.phase_results || {};
  const messages = [...state.messages];

  // Build feedback content — include attachment URLs if provided
  const feedbackPayload = { user_response: userResponse };
  if (attachments?.length) {
    feedbackPayload.uploaded_images = attachments
      .filter(a => a.content_type?.startsWith('image/'))
      .map(a => ({ url: a.url, filename: a.filename }));
  }

  // Append tool_results: sibling results from before the pause + user's feedback response
  const savedToolResults = state.completed_tool_results || [];
  messages.push({
    role: 'user',
    content: [
      ...savedToolResults,
      {
        type: 'tool_result',
        tool_use_id: state.pending_tool_use_id,
        content: JSON.stringify(feedbackPayload),
      },
    ],
  });

  // Clear saved state and set running (atomic: only if still awaiting)
  await updateSessionIfStatus(sessionId, session.status, {
    status: 'running',
    orchestrator_state: null,
  });

  yield* runToolUseLoop(sessionId, brief, messages, phaseResults, session.fix_log || []);
}

/**
 * Resume orchestration after human approval.
 * @deprecated Use resumeAfterFeedback instead.
 */
export async function* orchestrateAfterApproval(sessionId) {
  yield* resumeAfterFeedback(sessionId, '确认执行投放方案');
}

// ── User chat with orchestrator ────────────────────────────────────────

/**
 * Process a user chat message within an orchestrator session.
 * Persists the message and uploaded images, then delegates to orchestrate().
 *
 * @param {string} sessionId
 * @param {string} message
 * @yields {{ event: string, data: Object }} SSE events
 */
export async function* chatWithOrchestrator(sessionId, message, { attachments } = {}) {
  const session = await getSession(sessionId);
  if (!session) {
    yield { event: 'error', data: { message: `Session ${sessionId} not found` } };
    return;
  }

  // Persist user message
  const messageIndex = await getNextMessageIndex(sessionId);
  await addMessages(sessionId, [{
    phase: null,
    role: 'user',
    content: message,
    message_index: messageIndex,
    attachments: attachments?.length ? attachments : undefined,
  }]);

  // Persist uploaded images to brief.product_images
  if (attachments?.length) {
    const brief = await getBrief(session.brief_id);
    const newImages = attachments
      .filter(a => a.content_type?.startsWith('image/'))
      .map(a => ({ url: a.url, filename: a.filename }));
    if (newImages.length) {
      const existing = brief?.brief?.product_images || [];
      const existingUrls = new Set(existing.map(img => img.url));
      const deduped = newImages.filter(img => !existingUrls.has(img.url));
      if (deduped.length) {
        await updateBriefFields(brief.id, {
          product_images: [...existing, ...deduped],
        });
      }
    }
  }

  // Delegate to unified orchestrate() with user message context
  yield* orchestrate(sessionId, {}, { userMessage: message, attachments });
}

// ── Utilities ──────────────────────────────────────────────────────────

function isValidUrl(str) {
  if (!str || typeof str !== 'string') return false;
  try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function pickValidUrl(...candidates) {
  return candidates.find(isValidUrl) || null;
}

function getNestedField(obj, path) {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => o?.[k], obj);
}

function getPhaseExecutor(phaseKey) {
  const executors = { research: runResearch, strategy: runStrategy, creative_plan: runCreativePlan, creative: runCreative, execution: runExecution };
  const fn = executors[phaseKey];
  if (!fn) throw new Error(`No executor for phase: ${phaseKey}`);
  return fn;
}

function detectStartPhase(session) {
  const results = session.phase_results || {};
  for (const phase of PHASES) {
    if (!results[phase.key]) return phase.key;
  }
  return PHASES[0].key;
}

function summarizePhaseResult(phaseKey, result) {
  switch (phaseKey) {
    case 'research':
      return {
        recommendations_count: result?.recommendations?.length || 0,
        platforms_scored: result?.platform_recommendations?.length || 0,
        has_competitor_data: Boolean(result?.competitor_ads?.summary),
      };
    case 'strategy': {
      const platforms = result?.platforms || [];
      return {
        platforms: platforms.map(p => p.platform),
        total_campaigns: platforms.reduce((s, p) => s + (p.campaigns?.length || 0), 0),
        total_budget: result?.total_budget,
        currency: result?.currency,
      };
    }
    case 'creative_plan':
      return {
        creative_tasks_count: result?.creative_tasks?.length || 0,
        references_count: result?.references?.length || 0,
        strategy_categories: [...new Set((result?.creative_tasks || []).map(t => t.strategy_category))],
      };
    case 'creative':
      return {
        creatives_generated: Object.keys(result?.creatives || {}).length,
        skipped: result?.skipped || false,
        ...(result?.blocked && { blocked: true, reason: result.reason, message: result.message }),
      };
    case 'execution':
      return {
        status: result?.status,
        campaigns_created: result?.campaigns?.length || 0,
        errors_count: result?.errors?.length || 0,
        error_details: (result?.errors || []).slice(0, 8).map(e => {
          const base = `[${e.level}] ${e.name}: ${e.error}`;
          if (e.sent_params) return `${base} (sent: daily_budget=$${e.sent_params.daily_budget_dollars}/day = ${e.sent_params.daily_budget_cents} cents, objective=${e.sent_params.objective})`;
          return base;
        }),
      };
    default:
      return {};
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format brief products as human-readable text for extractProductInfo.
 * Converts structured product data into a natural document-like format.
 */
function formatProductsAsText(briefData) {
  const lines = [];
  if (briefData.company_name) lines.push(`Company: ${briefData.company_name}`);
  if (briefData.industry) lines.push(`Industry: ${briefData.industry}`);
  lines.push('');

  for (const product of briefData.products || []) {
    lines.push(`Product: ${product.model || product.name || 'Unknown'}`);
    if (product.category) lines.push(`Category: ${product.category}`);
    if (product.key_specs) {
      lines.push('Specifications:');
      for (const [k, v] of Object.entries(product.key_specs)) {
        lines.push(`  - ${k}: ${v}`);
      }
    }
    if (product.selling_points?.length) {
      lines.push('Selling Points:');
      for (const sp of product.selling_points) {
        lines.push(`  - ${sp}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export { PHASES, detectStartPhase, summarizePhaseResult, formatProductsAsText, evaluateOutput };
