import { openrouter, MODELS } from './llm-client.js';
import {
  PRD_TEMPLATE_TYPES,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUSES,
  REQUIREMENT_TYPES,
} from './requirement-constants.js';

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI did not return JSON');
    return JSON.parse(match[0]);
  }
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function normalizePrd(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    background_problem: String(input.background_problem || ''),
    user_impact: String(input.user_impact || ''),
    goal: String(input.goal || ''),
    solution: String(input.solution || ''),
    scope_boundary: String(input.scope_boundary || ''),
    acceptance_criteria: normalizeStringArray(input.acceptance_criteria),
    risk_dependency: String(input.risk_dependency || ''),
    rollback_plan: String(input.rollback_plan || ''),
    observability: String(input.observability || ''),
  };
}

function normalizeSchedule(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    pm_hours: Number(input.pm_hours || 24),
    dev_hours: Number(input.dev_hours || 72),
    test_hours: Number(input.test_hours || 96),
    acceptance_hours: Number(input.acceptance_hours || 120),
  };
}

export async function generateRequirementDraft({ tenantId, rawDescription, submitterName }) {
  const system = [
    '你是公司内部产品经理，负责把飞书群里的问题描述整理为可执行需求。',
    '只输出 JSON，不要输出 markdown，不要解释。',
    '线上问题/小优化使用 light 模板；新功能/跨模块/复杂数据报表使用 standard 模板。',
    '验收标准必须是可测试的条目。',
  ].join('\n');
  const user = JSON.stringify({
    raw_description: rawDescription,
    submitter: submitterName || '',
    output_schema: {
      title: 'string',
      requirement_type: Object.values(REQUIREMENT_TYPES),
      prd_template_type: Object.values(PRD_TEMPLATE_TYPES),
      priority: Object.values(REQUIREMENT_PRIORITIES),
      priority_reason: 'string',
      ai_confidence: 'number 0-1',
      missing_info: ['string'],
      prd: {
        background_problem: 'string',
        user_impact: 'string',
        goal: 'string',
        solution: 'string',
        scope_boundary: 'string',
        acceptance_criteria: ['string'],
        risk_dependency: 'string',
        rollback_plan: 'string',
        observability: 'string',
      },
      suggested_schedule: {
        pm_hours: 'number',
        dev_hours: 'number',
        test_hours: 'number',
        acceptance_hours: 'number',
      },
    },
  });

  const response = await openrouter.messages.create({
    models: [MODELS.HAIKU],
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
  }, {
    tenantId,
    callSite: 'requirement-draft.generate',
  });

  const content = response?.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  const confidence = Number(parsed.ai_confidence ?? 0.5);

  return {
    title: String(parsed.title || '未命名需求').slice(0, 120),
    requirement_type: normalizeEnum(
      parsed.requirement_type,
      Object.values(REQUIREMENT_TYPES),
      REQUIREMENT_TYPES.OTHER,
    ),
    prd_template_type: normalizeEnum(
      parsed.prd_template_type,
      Object.values(PRD_TEMPLATE_TYPES),
      PRD_TEMPLATE_TYPES.LIGHT,
    ),
    priority: normalizeEnum(
      parsed.priority,
      Object.values(REQUIREMENT_PRIORITIES),
      REQUIREMENT_PRIORITIES.P2,
    ),
    priority_reason: String(parsed.priority_reason || ''),
    ai_confidence: Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0.5)),
    missing_info: normalizeStringArray(parsed.missing_info),
    prd: normalizePrd(parsed.prd),
    suggested_schedule: normalizeSchedule(parsed.suggested_schedule),
    ai_raw_output: parsed,
  };
}

export function computeDraftInitialStatus(draft) {
  if (draft.missing_info?.length || draft.ai_confidence < 0.45) {
    return REQUIREMENT_STATUSES.NEEDS_INFO;
  }
  return REQUIREMENT_STATUSES.NEEDS_PM;
}
