import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { getBrief } from '../lib/repositories/campaign-brief.repository.js';

import {
  createSession,
  getSession,
  updateSession,
  addMessages,
  getMessagesForClaude,
  getNextMessageIndex,
} from '../lib/repositories/orchestrator.repository.js';
import supabase from '../lib/supabase.js';
import { conductResearch } from './research-agent.service.js';
import { generateMediaPlan } from './strategy-agent.service.js';
import { generateFromDocument } from './aigc.service.js';
import { executeMediaPlan, previewExecution, uploadMedia, activateCampaigns } from './execution-agent.service.js';
import { collectReferences } from './reference-collector.service.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL && { baseURL: config.anthropic.baseURL }),
});

const HEARTBEAT_INTERVAL_MS = 2000;

// ── Phase definitions ──────────────────────────────────────────────────

const PHASES = [
  { key: 'research',           name: '市场调研', description: 'Analyzing market, competitors, and trends' },
  { key: 'strategy',           name: '方案规划', description: 'Generating media plan with budget allocation' },
  { key: 'creative_reference', name: '素材参考', description: 'Collecting reference materials for creative' },
  { key: 'creative',           name: '素材生成', description: 'Generating ad creatives from product docs' },
  { key: 'execution',          name: '投放执行', description: 'Creating campaigns on Meta Ads', needsApproval: true },
];

// ── Helper: run a Promise with heartbeat yields ────────────────────────

function runWithHeartbeat(phaseKey, workFn, yieldEvent) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const timer = setInterval(() => {
      if (settled) return;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      yieldEvent({ event: 'heartbeat', data: { phase: phaseKey, elapsed_s: Number(elapsed) } });
    }, HEARTBEAT_INTERVAL_MS);

    workFn()
      .then(result => { settled = true; clearInterval(timer); resolve(result); })
      .catch(err => { settled = true; clearInterval(timer); reject(err); });
  });
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
      role: 'user',
      content: `[Agent ${phaseKey}] Started at ${startTime}\nInput: ${JSON.stringify(agentArgs[0]).slice(0, 500)}`,
      message_index: startIndex,
    },
    {
      phase: phaseKey,
      role: 'assistant',
      content: `[Agent ${phaseKey}] Completed\nResult keys: ${Object.keys(result || {}).join(', ')}`,
      tool_result: result,
      message_index: startIndex + 1,
    },
  ]);

  return result;
}

// ── Phase executors ────────────────────────────────────────────────────

async function runResearch(sessionId, brief, _phaseResults, instructions) {
  return runAgentWithTrace(sessionId, 'research', conductResearch, [brief.brief || {}, instructions]);
}

async function runStrategy(sessionId, brief, phaseResults, instructions) {
  return runAgentWithTrace(sessionId, 'strategy', generateMediaPlan, [brief.brief || {}, phaseResults.research, instructions]);
}

async function runCreativeReference(sessionId, brief, phaseResults, _instructions) {
  const briefData = brief.brief || {};
  const researchReport = phaseResults.research || {};

  const references = await collectReferences({ researchReport, brief: briefData });

  // Persist trace
  const idx = await getNextMessageIndex(sessionId);
  await addMessages(sessionId, [{
    phase: 'creative_reference',
    role: 'assistant',
    content: `Collected ${references.length} reference materials`,
    tool_result: { references },
    message_index: idx,
  }]);

  return { references };
}

async function runCreative(sessionId, brief, phaseResults, _instructions) {
  const mediaPlan = phaseResults.strategy;
  const briefData = brief.brief || {};
  const referenceImages = phaseResults.creative_reference?.selected_references || [];
  const metaPlatform = mediaPlan?.platforms?.find(p => p.platform === 'meta');
  if (!metaPlatform) return { creatives: {}, skipped: true };

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
        if (ad.format === 'image' && ad.media_requirements?.suggested_content) {
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
      }).then(result => ({ name: ad.name, result }))
    )
  );

  const creatives = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { name, result } = r.value;
      creatives[name] = { url: result.url, storage_path: result.storage_path, asset_id: result.id };
    } else {
      // Extract ad name from the error context — fallback to index
      const job = adJobs[results.indexOf(r)];
      creatives[job.ad.name] = { error: r.reason?.message || 'Unknown error' };
    }
  }

  // Persist creative generation trace
  const idx = await getNextMessageIndex(sessionId);
  await addMessages(sessionId, [{
    phase: 'creative',
    role: 'assistant',
    content: `Generated ${Object.keys(creatives).length} creatives`,
    tool_result: { creatives },
    message_index: idx,
  }]);

  return { creatives };
}

async function runExecution(sessionId, brief, phaseResults, _instructions) {
  const mediaPlan = phaseResults.strategy;
  const creativeResults = phaseResults.creative?.creatives || {};

  const metaCreatives = {};
  for (const [adName, creative] of Object.entries(creativeResults)) {
    if (creative.error || !creative.storage_path) continue;
    try {
      // Fetch actual image from Supabase storage
      const { data: imageData, error: downloadError } = await supabase.storage
        .from(config.aigc.storageBucket)
        .download(creative.storage_path);

      if (downloadError) throw new Error(`Storage download failed: ${downloadError.message}`);

      const imageBuffer = Buffer.from(await imageData.arrayBuffer());
      const { image_hash } = await uploadMedia(imageBuffer, `${adName}.png`);
      metaCreatives[adName] = { image_hash };
    } catch (err) {
      metaCreatives[adName] = { error: err.message };
    }
  }

  return runAgentWithTrace(sessionId, 'execution', executeMediaPlan, [
    mediaPlan,
    metaCreatives,
    { link_url: brief.brief?.existing_landing_pages?.[0] || brief.brief?.website || 'https://revopanda.com' },
  ]);
}

// ── Orchestrator Agent Tools ──────────────────────────────────────────

const ORCHESTRATOR_TOOLS = [
  {
    name: 'run_phase',
    description: '执行指定的投放流程阶段。返回阶段结果摘要。creative_reference 会搜集竞品广告和网站产品图作为素材参考，应在 creative 前执行。',
    input_schema: {
      type: 'object',
      required: ['phase'],
      properties: {
        phase: { type: 'string', enum: ['research', 'strategy', 'creative_reference', 'creative', 'execution'] },
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
    description: '带修改指令重跑某阶段（仅 research/strategy）。之前的结果会被覆盖。',
    input_schema: {
      type: 'object',
      required: ['phase', 'feedback'],
      properties: {
        phase: { type: 'string', enum: ['research', 'strategy'] },
        feedback: { type: 'string', description: '对上次结果的修改要求' },
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
        phase: { type: 'string', enum: ['research', 'strategy', 'creative_reference', 'creative', 'execution'] },
        field: { type: 'string', description: '要查看的字段路径，如 "recommendations", "platforms[0].campaigns", "competitor_ads.summary"' },
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

const ORCHESTRATOR_SYSTEM_PROMPT = `你是数字广告投放主控 Agent。你的任务是根据 Campaign Brief 智能编排投放流程。

## 标准流程
research → strategy → creative_reference → (用户确认参考素材) → creative → execution
你可以根据 brief 灵活调整顺序、跳过阶段、或重试。

## 灵活调整示例
- 预算很小（<$200）→ 可跳过 research，直接做 strategy
- 用户已有素材 → 跳过 creative_reference 和 creative
- research 数据不足 → retry 并给出更具体指令
- 阶段出错 → 告诉用户并询问是否重试

## 素材参考流程
- creative_reference 阶段会自动搜集竞品广告截图和客户网站产品图
- 搜集完成后，必须用 request_user_feedback 展示参考素材给用户，让用户选择想要参考的素材或上传自己的素材
- 用户确认后再运行 creative 阶段

## 指导原则
- run_phase 返回结果中包含 quality.score 和 quality.issues，据此判断是否需要 retry
- quality.score 很低且 issues 明确时，用 retry_phase 并给出针对性反馈（仅 research/strategy 支持 retry）
- 每个阶段最多 retry 一次
- execution 创建的广告是 PAUSED 状态，需要用户确认后调用 activate_campaigns 激活
- execution 完成后，用 request_user_feedback 展示结果并询问用户是否激活投放
- 用户确认激活后，调用 activate_campaigns 将所有广告系列设为 ACTIVE
- 可用 preview_execution 先预览投放方案给用户看，再决定是否执行
- 出错时主动告知用户，不要静默失败
- creative/execution 出错时用 request_user_feedback 通知用户，由用户决定下一步`;

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
        const totalAlloc = result.platforms.reduce((s, p) => s + (p.budget_allocation || 0), 0);
        if (Math.abs(totalAlloc - 100) > 5) issues.push(`预算分配总和 ${totalAlloc}%，偏离 100%`);
        const hasCampaigns = result.platforms.some(p => p.campaigns?.length > 0);
        if (!hasCampaigns) issues.push('缺少广告系列 (campaigns)');
      }
      break;
    case 'creative_reference':
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
      if (result?.errors?.length) issues.push(`${result.errors.length} 个执行错误`);
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
async function* runToolUseLoop(sessionId, brief, messages, initialPhaseResults) {
  let phaseResults = { ...initialPhaseResults };
  const eventBuffer = [];

  for (let iteration = 0; iteration < MAX_ORCHESTRATOR_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: ORCHESTRATOR_SYSTEM_PROMPT,
      messages,
      tools: ORCHESTRATOR_TOOLS,
      tool_choice: { type: 'auto' },
    });

    if (response.stop_reason !== 'tool_use') {
      await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
      yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults) } };
      return;
    }

    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    let shouldPause = false;
    let shouldTerminate = false;
    let terminateSummary = '';

    for (const block of toolUseBlocks) {
      const { id, name, input } = block;
      let result;

      switch (name) {
        case 'run_phase':
        case 'retry_phase': {
          const phaseKey = input.phase;
          const phaseDef = PHASES.find(p => p.key === phaseKey);
          yield { event: 'phase_start', data: { phase: phaseKey, name: phaseDef?.name || phaseKey } };
          const phaseStartTime = Date.now();
          try {
            const executor = getPhaseExecutor(phaseKey);
            const instructions = name === 'retry_phase' ? input.feedback : input.instructions;
            const phaseResult = await runWithHeartbeat(
              phaseKey,
              () => executor(sessionId, brief, phaseResults, instructions),
              (evt) => eventBuffer.push(evt),
            );
            while (eventBuffer.length > 0) yield eventBuffer.shift();
            phaseResults = { ...phaseResults, [phaseKey]: phaseResult };
            await updateSession(sessionId, { phase_results: phaseResults, current_phase: phaseKey });
            const duration = Math.round((Date.now() - phaseStartTime) / 1000);
            const resultSummary = summarizePhaseResult(phaseKey, phaseResult);
            yield { event: 'phase_complete', data: { phase: phaseKey, name: phaseDef?.name || phaseKey, result: phaseResult, duration, result_summary: resultSummary } };
            const evaluation = evaluateOutput(phaseKey, phaseResult);
            result = { status: 'completed', result_summary: resultSummary, duration_s: duration, quality: evaluation };
          } catch (err) {
            while (eventBuffer.length > 0) yield eventBuffer.shift();
            yield { event: 'phase_error', data: { phase: phaseKey, error: err.message } };
            result = { status: 'error', error: err.message };
          }
          break;
        }

        case 'request_user_feedback': {
          await updateSession(sessionId, {
            status: 'awaiting_feedback',
            orchestrator_state: {
              messages: [...messages],
              pending_tool_use_id: id,
              phase_results_snapshot: phaseResults,
            },
          });
          yield { event: 'feedback_required', data: { message: input.message, options: input.options, tool_use_id: id } };
          shouldPause = true;
          break;
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

        case 'skip_phase':
          yield { event: 'phase_skipped', data: { phase: input.phase, reason: input.reason } };
          result = { skipped: true, phase: input.phase, reason: input.reason };
          break;

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
          await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
          shouldTerminate = true;
          terminateSummary = input.summary;
          result = { completed: true };
          break;

        default:
          result = { error: `Unknown tool: ${name}` };
      }

      if (shouldPause) break;
      toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) });
    }

    if (shouldPause) return;
    if (shouldTerminate) {
      yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults), summary: terminateSummary } };
      return;
    }
    messages.push({ role: 'user', content: toolResults });
  }

  await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
  yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults), summary: 'Force-terminated: max iterations reached' } };
}

// ── Main orchestrator generator ────────────────────────────────────────

/**
 * Orchestrate the full campaign pipeline using a Claude tool_use agent loop.
 *
 * @param {string} sessionId - Orchestrator session UUID
 * @yields {{ event: string, data: Object }}
 */
export async function* orchestrate(sessionId) {
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

  const briefData = brief.brief || {};
  if (!briefData.company_name || !briefData.industry) {
    yield { event: 'error', data: { message: 'Brief is incomplete — finish intake first' } };
    return;
  }

  const phaseResults = session.phase_results || {};
  await updateSession(sessionId, { status: 'running', current_phase: 'orchestrating' });

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

  const messages = [{
    role: 'user',
    content: `请根据以下 Campaign Brief 编排投放流程。\n\nCAMPAIGN BRIEF:\n${JSON.stringify(briefData, null, 2)}${existingResults}`,
  }];

  yield* runToolUseLoop(sessionId, brief, messages, phaseResults);
}

/**
 * Resume orchestration after user feedback.
 * @param {string} sessionId
 * @param {string} userResponse
 * @yields {{ event: string, data: Object }} SSE events
 */
export async function* resumeAfterFeedback(sessionId, userResponse) {
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

  // Restore state
  let phaseResults = state.phase_results_snapshot || session.phase_results || {};
  const messages = [...state.messages];

  // Append tool_result with user response
  messages.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: state.pending_tool_use_id,
      content: JSON.stringify({ user_response: userResponse }),
    }],
  });

  // Clear saved state and set running
  await updateSession(sessionId, {
    status: 'running',
    orchestrator_state: null,
  });

  yield* runToolUseLoop(sessionId, brief, messages, phaseResults);
}

/**
 * Resume orchestration after human approval.
 * @deprecated Use resumeAfterFeedback instead.
 */
export async function* orchestrateAfterApproval(sessionId) {
  yield* resumeAfterFeedback(sessionId, '确认执行投放方案');
}

// ── User chat with orchestrator ────────────────────────────────────────

const ORCHESTRATOR_CHAT_TOOLS = [
  {
    name: 'restart_pipeline',
    description: '重新启动投放流程。当用户要求重跑、继续执行、重新生成素材、开始投放等操作性请求时调用。系统会自动从需要的阶段开始执行。',
    input_schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', description: '重跑原因，简短描述' },
      },
    },
  },
];

const ORCHESTRATOR_CHAT_SYSTEM = `你是数字投放主控 Agent。你可以回答用户关于投放方案的问题，也可以触发系统操作。

你能看到之前各阶段的执行结果。基于这些结果回答用户问题。

重要：本系统是全自动化投放平台。
- 所有阶段（市场调研、方案规划、素材生成、投放执行）都由系统自动完成
- 绝对不要让用户手动上传素材、手动创建广告、手动操作任何后台
- 绝对不要让用户去联系投放团队或广告代理商
- 当用户要求重跑流程、继续执行、重新生成素材、开始投放等操作时，调用 restart_pipeline 工具
- 不要问用户素材是否上传成功、是否需要人工介入等问题 — 系统会自动处理一切

回复规则：
- 简洁专业，300字以内
- 可以解释调研结果、方案细节、预算分配等
- 用户要求任何执行/重跑操作时，先简短回应然后立即调用 restart_pipeline`;

/**
 * Process a user chat message within an orchestrator session.
 * Supports tool_use — can trigger pipeline restart via restart_pipeline tool.
 *
 * @param {string} sessionId
 * @param {string} message
 * @yields {{ event: string, data: Object }} SSE events (delta, done, trigger_orchestration)
 */
export async function* chatWithOrchestrator(sessionId, message) {
  const session = await getSession(sessionId);
  if (!session) {
    yield { event: 'error', data: { message: `Session ${sessionId} not found` } };
    return;
  }

  // Load user conversation history (phase=null)
  const history = await getMessagesForClaude(sessionId, { phase: null });
  let messageIndex = await getNextMessageIndex(sessionId);

  // Store user message
  await addMessages(sessionId, [{
    phase: null,
    role: 'user',
    content: message,
    message_index: messageIndex++,
  }]);

  // Build context from phase results
  const phaseContext = Object.entries(session.phase_results || {})
    .map(([phase, result]) => `=== ${phase.toUpperCase()} 阶段结果 ===\n${JSON.stringify(summarizePhaseResult(phase, result), null, 2)}`)
    .join('\n\n');

  const systemPrompt = `${ORCHESTRATOR_CHAT_SYSTEM}\n\n当前状态: ${session.status}, 当前阶段: ${session.current_phase || '未开始'}\n\n${phaseContext || '暂无阶段结果'}`;

  const messages = [
    ...history,
    { role: 'user', content: message },
  ];

  // Use create (not stream) to support tool_use
  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: systemPrompt,
    messages,
    tools: ORCHESTRATOR_CHAT_TOOLS,
    tool_choice: { type: 'auto' },
  });

  // Process response blocks
  let assistantText = '';
  let shouldRestart = false;
  let restartReason = '';

  for (const block of response.content || []) {
    if (block.type === 'text') {
      assistantText += block.text;
      yield { event: 'delta', data: { text: block.text } };
    } else if (block.type === 'tool_use' && block.name === 'restart_pipeline') {
      shouldRestart = true;
      restartReason = block.input?.reason || '用户请求重跑';
    }
  }

  // Persist assistant response
  if (assistantText) {
    await addMessages(sessionId, [{
      phase: null,
      role: 'assistant',
      content: assistantText,
      message_index: messageIndex++,
    }]);
  }

  if (shouldRestart) {
    // Signal frontend to trigger orchestration pipeline
    yield { event: 'trigger_orchestration', data: { reason: restartReason } };
  }

  yield { event: 'done', data: { session_id: sessionId } };
}

// ── Utilities ──────────────────────────────────────────────────────────

function getNestedField(obj, path) {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => o?.[k], obj);
}

function getPhaseExecutor(phaseKey) {
  const executors = { research: runResearch, strategy: runStrategy, creative_reference: runCreativeReference, creative: runCreative, execution: runExecution };
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
    case 'creative_reference':
      return {
        references_count: result?.references?.length || 0,
        sources: [...new Set((result?.references || []).map(r => r.source))],
      };
    case 'creative':
      return {
        creatives_generated: Object.keys(result?.creatives || {}).length,
        skipped: result?.skipped || false,
      };
    case 'execution':
      return {
        status: result?.status,
        campaigns_created: result?.campaigns?.length || 0,
        errors: result?.errors?.length || 0,
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
