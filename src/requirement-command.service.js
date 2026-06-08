import {
  addRequirementEvent,
  getRequirementBotSettings,
  listRequirements,
  updateRequirement,
} from '../lib/repositories/requirement.repository.js';
import {
  findBitableRequirementByNo,
  updateBitableRequirement,
} from './requirement-bitable.service.js';
import {
  CURRENT_OWNER_BY_STATUS,
  REQUIREMENT_ACTIONS,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUSES,
} from './requirement-constants.js';

const FIELD_ALIASES = new Map([
  ['标题', 'title'],
  ['名称', 'title'],
  ['需求标题', 'title'],
  ['优先级', 'priority'],
  ['紧急程度', 'priority'],
  ['状态', 'status'],
  ['PM', 'pm_owner_name'],
  ['产品负责人', 'pm_owner_name'],
  ['开发', 'developer_name'],
  ['开发负责人', 'developer_name'],
  ['测试', 'tester_name'],
  ['测试负责人', 'tester_name'],
  ['验收人', 'acceptor_name'],
  ['验收负责人', 'acceptor_name'],
  ['当前负责人', 'current_owner_name'],
  ['开发截止', 'dev_due_at'],
  ['开发时间', 'dev_due_at'],
  ['开发截止时间', 'dev_due_at'],
  ['测试截止', 'test_due_at'],
  ['测试时间', 'test_due_at'],
  ['测试截止时间', 'test_due_at'],
  ['验收截止', 'acceptance_due_at'],
  ['验收时间', 'acceptance_due_at'],
  ['验收截止时间', 'acceptance_due_at'],
  ['上线时间', 'planned_release_at'],
  ['计划上线时间', 'planned_release_at'],
  ['阻塞原因', 'blocked_reason'],
  ['当前阻塞', 'blocked_reason'],
  ['方案', 'prd.solution'],
  ['具体方案', 'prd.solution'],
  ['产品方案', 'prd.solution'],
  ['解决方案', 'prd.solution'],
  ['背景', 'prd.background_problem'],
  ['问题背景', 'prd.background_problem'],
  ['目标', 'prd.goal'],
  ['需求目标', 'prd.goal'],
  ['影响', 'prd.user_impact'],
  ['用户影响', 'prd.user_impact'],
  ['范围', 'prd.scope_boundary'],
  ['范围边界', 'prd.scope_boundary'],
  ['验收标准', 'prd.acceptance_criteria'],
  ['风险', 'prd.risk_dependency'],
  ['依赖', 'prd.risk_dependency'],
  ['风险依赖', 'prd.risk_dependency'],
  ['回滚方案', 'prd.rollback_plan'],
  ['监控', 'prd.observability'],
  ['观测', 'prd.observability'],
]);

const FIELD_LABELS = new Map([
  ['title', '标题'],
  ['priority', '优先级'],
  ['status', '状态'],
  ['pm_owner_name', 'PM'],
  ['developer_name', '开发负责人'],
  ['tester_name', '测试负责人'],
  ['acceptor_name', '验收人'],
  ['current_owner_name', '当前负责人'],
  ['dev_due_at', '开发截止'],
  ['test_due_at', '测试截止'],
  ['acceptance_due_at', '验收截止'],
  ['planned_release_at', '上线时间'],
  ['blocked_reason', '阻塞原因'],
  ['prd.solution', '具体方案'],
  ['prd.background_problem', '问题背景'],
  ['prd.goal', '需求目标'],
  ['prd.user_impact', '用户影响'],
  ['prd.scope_boundary', '范围边界'],
  ['prd.acceptance_criteria', '验收标准'],
  ['prd.risk_dependency', '风险依赖'],
  ['prd.rollback_plan', '回滚方案'],
  ['prd.observability', '监控方案'],
]);

const STATUS_ALIASES = new Map([
  ['待产品确认', REQUIREMENT_STATUSES.NEEDS_PM],
  ['待补充', REQUIREMENT_STATUSES.NEEDS_INFO],
  ['待开发', REQUIREMENT_STATUSES.READY_FOR_DEV],
  ['开发中', REQUIREMENT_STATUSES.IN_DEV],
  ['待测试', REQUIREMENT_STATUSES.READY_FOR_TEST],
  ['测试中', REQUIREMENT_STATUSES.IN_TEST],
  ['待验收', REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE],
  ['已关闭', REQUIREMENT_STATUSES.CLOSED],
  ['关闭', REQUIREMENT_STATUSES.CLOSED],
  ['已拒绝', REQUIREMENT_STATUSES.REJECTED],
  ['拒绝', REQUIREMENT_STATUSES.REJECTED],
]);

const PRIORITY_ALIASES = new Map([
  ['最高', REQUIREMENT_PRIORITIES.P0],
  ['紧急', REQUIREMENT_PRIORITIES.P0],
  ['很高', REQUIREMENT_PRIORITIES.P0],
  ['高', REQUIREMENT_PRIORITIES.P1],
  ['中', REQUIREMENT_PRIORITIES.P2],
  ['普通', REQUIREMENT_PRIORITIES.P2],
  ['一般', REQUIREMENT_PRIORITIES.P2],
  ['低', REQUIREMENT_PRIORITIES.P3],
]);

const DATE_FIELDS = new Set([
  'pm_due_at',
  'dev_due_at',
  'test_due_at',
  'acceptance_due_at',
  'planned_release_at',
]);

const TERMINAL_STATUSES = new Set([
  REQUIREMENT_STATUSES.CLOSED,
  REQUIREMENT_STATUSES.REJECTED,
]);

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeReqNo(value) {
  const raw = String(value || '').trim().toUpperCase();
  const compact = raw.match(/^REQ\D*(\d{8})\D*(\d{3})$/);
  if (compact) return `REQ-${compact[1]}-${compact[2]}`;
  return raw;
}

function extractReqNo(text) {
  const input = String(text || '').toUpperCase();
  const match = input.match(/REQ\D*(\d{8})\D*(\d{3})/);
  return match ? `REQ-${match[1]}-${match[2]}` : '';
}

function hasBitableUpdateIntent(text) {
  return /更新\s*多维\s*(?:文档|表格)?/.test(String(text || ''));
}

function normalizeField(rawField) {
  const key = normalizeWhitespace(rawField);
  return FIELD_ALIASES.get(key) || null;
}

function normalizePriority(rawValue) {
  const value = normalizeWhitespace(rawValue).toUpperCase();
  if (Object.values(REQUIREMENT_PRIORITIES).includes(value)) return value;
  return PRIORITY_ALIASES.get(normalizeWhitespace(rawValue)) || null;
}

function normalizeStatus(rawValue) {
  const value = normalizeWhitespace(rawValue);
  if (Object.values(REQUIREMENT_STATUSES).includes(value)) return value;
  return STATUS_ALIASES.get(value) || null;
}

function normalizeDateTime(rawValue) {
  const value = normalizeWhitespace(rawValue)
    .replace(/^今天/, new Date().toISOString().slice(0, 10))
    .replace(/^明天/, (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })());

  const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (match) {
    const [, year, month, day, hour = '23', minute = '59'] = match;
    const utcMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
      0,
      0,
    );
    return new Date(utcMs).toISOString();
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

function normalizeAcceptanceCriteria(rawValue) {
  return String(rawValue || '')
    .split(/(?:^|\s+)(?:\d+[.、)]|[-*])\s*|[；;]/)
    .map(item => item.trim().replace(/^\d+[.、)]\s*/, ''))
    .filter(Boolean);
}

function normalizeValue(field, rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return { ok: false, error: '修改内容不能为空' };

  if (field === 'priority') {
    const priority = normalizePriority(value);
    if (!priority) return { ok: false, error: '优先级只支持 P0/P1/P2/P3，或 高/中/低' };
    return { ok: true, value: priority };
  }

  if (field === 'status') {
    const status = normalizeStatus(value);
    if (!status) return { ok: false, error: '状态无法识别，请用待产品确认、待开发、开发中、待测试、测试中、待验收、已关闭' };
    return { ok: true, value: status };
  }

  if (DATE_FIELDS.has(field)) {
    const date = normalizeDateTime(value);
    if (!date) return { ok: false, error: '时间无法识别，请用类似 2026-06-09 18:00 的格式' };
    return { ok: true, value: date };
  }

  if (field === 'prd.acceptance_criteria') {
    const criteria = normalizeAcceptanceCriteria(value);
    if (!criteria.length) return { ok: false, error: '验收标准不能为空' };
    return { ok: true, value: criteria };
  }

  return { ok: true, value };
}

function actionForField(field) {
  if (field === 'priority') return REQUIREMENT_ACTIONS.UPDATE_PRIORITY;
  if ([
    'pm_owner_name',
    'developer_name',
    'tester_name',
    'acceptor_name',
    'current_owner_name',
  ].includes(field)) {
    return REQUIREMENT_ACTIONS.UPDATE_OWNERS;
  }
  if (field === 'dev_due_at' || field === 'test_due_at' || field === 'acceptance_due_at' || field === 'planned_release_at') {
    return REQUIREMENT_ACTIONS.UPDATE_SCHEDULE;
  }
  if (field.startsWith('prd.')) return REQUIREMENT_ACTIONS.UPDATE_PLAN;
  if (field === 'blocked_reason') return REQUIREMENT_ACTIONS.BLOCK;
  return REQUIREMENT_ACTIONS.UPDATE_PLAN;
}

function patchForField(requirement, field, value) {
  if (field.startsWith('prd.')) {
    const prdField = field.slice('prd.'.length);
    return {
      prd: {
        ...(requirement.prd && typeof requirement.prd === 'object' ? requirement.prd : {}),
        [prdField]: value,
      },
    };
  }

  const patch = { [field]: value };
  if (field === 'status') {
    patch.last_status_changed_at = new Date().toISOString();
    const currentOwnerField = CURRENT_OWNER_BY_STATUS[value];
    patch.current_owner_feishu_user_id = currentOwnerField
      ? requirement[currentOwnerField] || null
      : null;
    const currentOwnerNameField = currentOwnerField
      ? currentOwnerField.replace('_feishu_user_id', '_name')
      : '';
    patch.current_owner_name = currentOwnerNameField ? requirement[currentOwnerNameField] || null : null;
  }
  if (
    field === 'pm_owner_name' &&
    [REQUIREMENT_STATUSES.NEEDS_PM].includes(requirement.status)
  ) {
    patch.current_owner_name = value;
  }
  if (
    field === 'developer_name' &&
    [REQUIREMENT_STATUSES.READY_FOR_DEV, REQUIREMENT_STATUSES.IN_DEV].includes(requirement.status)
  ) {
    patch.current_owner_name = value;
  }
  if (
    field === 'tester_name' &&
    [REQUIREMENT_STATUSES.READY_FOR_TEST, REQUIREMENT_STATUSES.IN_TEST].includes(requirement.status)
  ) {
    patch.current_owner_name = value;
  }
  if (
    field === 'acceptor_name' &&
    [REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE].includes(requirement.status)
  ) {
    patch.current_owner_name = value;
  }
  return patch;
}

function currentValue(requirement, field) {
  if (field.startsWith('prd.')) {
    return requirement.prd?.[field.slice('prd.'.length)] ?? null;
  }
  return requirement[field] ?? null;
}

function displayValue(value) {
  if (Array.isArray(value)) return value.join('；');
  return String(value ?? '');
}

export function parseRequirementEditCommand(text) {
  const input = normalizeWhitespace(text);
  const match = input.match(/^(?:修改|更新|改|设置)\s+(REQ-\d{8}-\d{3})\s+(.+?)(?:为|成|=|：|:)\s*(.+)$/i);
  if (!match) return { handled: false };

  const [, reqNoRaw, rawField, rawValue] = match;
  const field = normalizeField(rawField);
  if (!field) {
    return {
      handled: true,
      ok: false,
      reqNo: normalizeReqNo(reqNoRaw),
      rawField: normalizeWhitespace(rawField),
      rawValue: String(rawValue || '').trim(),
      error: `不认识字段「${normalizeWhitespace(rawField)}」`,
    };
  }

  const normalized = normalizeValue(field, rawValue);
  if (!normalized.ok) {
    return {
      handled: true,
      ok: false,
      reqNo: normalizeReqNo(reqNoRaw),
      field,
      rawField: normalizeWhitespace(rawField),
      rawValue: String(rawValue || '').trim(),
      error: normalized.error,
    };
  }

  return {
    handled: true,
    reqNo: normalizeReqNo(reqNoRaw),
    field,
    value: normalized.value,
    rawField: normalizeWhitespace(rawField),
    rawValue: String(rawValue || '').trim(),
  };
}

export function parseRequirementSyncCommand(text) {
  const input = normalizeWhitespace(text);
  const match = input.match(/(?:^|[\s:：])(?:同步|同步多维表格)\s+(REQ-\d{8}-\d{3})(?:$|\s)/i);
  if (match) return { handled: true, reqNo: normalizeReqNo(match[1]) };

  if (hasBitableUpdateIntent(input)) {
    const reqNo = extractReqNo(input);
    if (reqNo) return { handled: true, reqNo: normalizeReqNo(reqNo) };
  }

  return { handled: false };
}

async function findRequirementByNo({ tenantId, reqNo }) {
  const items = await listRequirements({ tenantId, limit: 500 });
  return items.find(item => normalizeReqNo(item.req_no) === normalizeReqNo(reqNo)) || null;
}

async function defaultRequirementStore(tenantId) {
  const settings = await getRequirementBotSettings(tenantId, { includeSecrets: true });
  return {
    async findByNo({ reqNo }) {
      try {
        const fromBitable = await findBitableRequirementByNo({ settings, reqNo });
        if (fromBitable) return fromBitable;
      } catch (err) {
        console.warn('[requirements] find from bitable failed, falling back to local store:', err.message);
      }
      return findRequirementByNo({ tenantId, reqNo });
    },
    async update({ requirement, patch }) {
      if (requirement?.bitable_record_id) {
        try {
          return await updateBitableRequirement({ settings, requirement, patch });
        } catch (err) {
          console.warn('[requirements] update bitable requirement failed:', err.message);
          throw err;
        }
      }
      return updateRequirement({ tenantId, id: requirement.id, patch });
    },
  };
}

async function resolveRequirementStore(tenantId, requirementStore) {
  return requirementStore || defaultRequirementStore(tenantId);
}

export function isExplicitNewRequirement(text) {
  return normalizeWhitespace(text).includes('【新需求】');
}

export function stripNewRequirementMarker(text) {
  return String(text || '').replace(/【新需求】/g, '').trim();
}

function appendFollowUp(rawDescription, text) {
  const existing = String(rawDescription || '').trim();
  const addition = `补充说明：${String(text || '').trim()}`;
  return existing ? `${existing}\n\n${addition}` : addition;
}

export async function handleRequirementEditCommand({ tenantId, text, actorFeishuUserId, requirementStore }) {
  const parsed = parseRequirementEditCommand(text);
  if (!parsed.handled) return { handled: false };
  if (parsed.ok === false) return parsed;

  const store = await resolveRequirementStore(tenantId, requirementStore);
  const requirement = await store.findByNo({ reqNo: parsed.reqNo });
  if (!requirement) {
    return {
      handled: true,
      ok: false,
      reqNo: parsed.reqNo,
      error: `找不到需求 ${parsed.reqNo}`,
    };
  }

  const from = currentValue(requirement, parsed.field);
  const patch = {
    ...patchForField(requirement, parsed.field, parsed.value),
    bitable_sync_status: 'pending',
  };
  const updated = await store.update({ requirement, patch });

  if (!requirement.bitable_record_id) {
    await addRequirementEvent({
      tenantId,
      requirementId: requirement.id,
      actorFeishuUserId,
      action: actionForField(parsed.field),
      fromStatus: requirement.status,
      toStatus: updated.status,
      details: {
        field: parsed.field,
        from,
        to: parsed.value,
        raw_field: parsed.rawField,
        raw_value: parsed.rawValue,
      },
    });
  }

  const label = FIELD_LABELS.get(parsed.field) || parsed.rawField;
  return {
    handled: true,
    ok: true,
    requirement: updated,
    message: `已修改 ${updated.req_no}：${label} = ${displayValue(parsed.value)}`,
  };
}

export async function handleRequirementSyncCommand({ tenantId, text, syncRequirementToBitable, requirementStore }) {
  const parsed = parseRequirementSyncCommand(text);
  if (!parsed.handled) return { handled: false };

  const store = await resolveRequirementStore(tenantId, requirementStore);
  const requirement = await store.findByNo({ reqNo: parsed.reqNo });
  if (!requirement) {
    return {
      handled: true,
      ok: false,
      error: `找不到需求 ${parsed.reqNo}`,
    };
  }

  try {
    const result = await syncRequirementToBitable({ tenantId, requirement });
    if (result.ok) {
      return {
        handled: true,
        ok: true,
        requirement,
        message: `已同步 ${requirement.req_no} 到多维表格。记录 ID：${result.recordId || '-'}`,
      };
    }
    if (result.skipped) {
      return {
        handled: true,
        ok: false,
        requirement,
        error: `没有同步：${result.reason || '未配置多维表格'}`,
      };
    }
    return {
      handled: true,
      ok: false,
      requirement,
      error: result.error || '未知同步失败',
    };
  } catch (err) {
    return {
      handled: true,
      ok: false,
      requirement,
      error: err.message,
    };
  }
}

export async function handleRequirementFollowUp({ tenantId, text, actorFeishuUserId, requirementStore }) {
  if (isExplicitNewRequirement(text)) {
    return { handled: false, reason: 'explicit_new_requirement' };
  }

  if (hasBitableUpdateIntent(text)) {
    return {
      handled: true,
      ok: false,
      error: '请带上需求编号，例如：【更新多维文档】REQ-20260608-001。',
    };
  }

  const reqNo = extractReqNo(text);
  if (!reqNo) {
    return {
      handled: true,
      ok: false,
      error: '请带上需求编号，例如：REQ-20260608-001 补充一下：具体说明。只有写【新需求】才会新建需求。',
    };
  }

  const store = await resolveRequirementStore(tenantId, requirementStore);
  const requirement = await store.findByNo({ reqNo });
  if (!requirement || TERMINAL_STATUSES.has(requirement.status)) {
    return {
      handled: true,
      ok: false,
      error: `找不到可更新的需求 ${reqNo}`,
    };
  }

  const updated = await store.update({
    requirement,
    patch: {
      raw_description: appendFollowUp(requirement.raw_description, text),
      bitable_sync_status: 'pending',
    },
  });

  if (!requirement.bitable_record_id) {
    await addRequirementEvent({
      tenantId,
      requirementId: requirement.id,
      actorFeishuUserId,
      action: REQUIREMENT_ACTIONS.UPDATE_PLAN,
      fromStatus: requirement.status,
      toStatus: requirement.status,
      details: {
        field: 'raw_description',
        follow_up: String(text || '').trim(),
      },
    });
  }

  return {
    handled: true,
    ok: true,
    requirement: updated,
    message: `已补充到 ${updated.req_no}，不会新建需求。`,
  };
}
