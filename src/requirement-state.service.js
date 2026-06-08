import {
  CURRENT_OWNER_BY_STATUS,
  REQUIREMENT_ACTIONS,
  REQUIREMENT_STATUSES,
} from './requirement-constants.js';
import {
  addRequirementEvent,
  updateRequirement,
} from '../lib/repositories/requirement.repository.js';

const TRANSITIONS = {
  [REQUIREMENT_ACTIONS.CONFIRM_PLAN]: {
    from: [REQUIREMENT_STATUSES.NEEDS_PM, REQUIREMENT_STATUSES.NEEDS_INFO],
    to: REQUIREMENT_STATUSES.READY_FOR_DEV,
    actorField: 'pm_owner_feishu_user_id',
  },
  [REQUIREMENT_ACTIONS.START_DEV]: {
    from: [REQUIREMENT_STATUSES.READY_FOR_DEV],
    to: REQUIREMENT_STATUSES.IN_DEV,
    actorField: 'developer_feishu_user_id',
  },
  [REQUIREMENT_ACTIONS.SUBMIT_TEST]: {
    from: [REQUIREMENT_STATUSES.IN_DEV, REQUIREMENT_STATUSES.READY_FOR_DEV],
    to: REQUIREMENT_STATUSES.READY_FOR_TEST,
    actorField: 'developer_feishu_user_id',
  },
  [REQUIREMENT_ACTIONS.START_TEST]: {
    from: [REQUIREMENT_STATUSES.READY_FOR_TEST],
    to: REQUIREMENT_STATUSES.IN_TEST,
    actorField: 'tester_feishu_user_id',
  },
  [REQUIREMENT_ACTIONS.PASS_TEST]: {
    from: [REQUIREMENT_STATUSES.IN_TEST],
    to: REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE,
    actorField: 'tester_feishu_user_id',
  },
  [REQUIREMENT_ACTIONS.REJECT_TEST]: {
    from: [REQUIREMENT_STATUSES.IN_TEST, REQUIREMENT_STATUSES.READY_FOR_TEST],
    to: REQUIREMENT_STATUSES.IN_DEV,
    actorField: 'tester_feishu_user_id',
  },
  [REQUIREMENT_ACTIONS.ACCEPT_AND_CLOSE]: {
    from: [REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE],
    to: REQUIREMENT_STATUSES.CLOSED,
    actorField: 'acceptor_feishu_user_id',
  },
  [REQUIREMENT_ACTIONS.REJECT_ACCEPTANCE]: {
    from: [REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE],
    to: REQUIREMENT_STATUSES.IN_DEV,
    actorField: 'acceptor_feishu_user_id',
  },
  [REQUIREMENT_ACTIONS.REQUEST_INFO]: {
    from: [REQUIREMENT_STATUSES.NEEDS_PM, REQUIREMENT_STATUSES.READY_FOR_DEV],
    to: REQUIREMENT_STATUSES.NEEDS_INFO,
    actorField: 'pm_owner_feishu_user_id',
  },
  [REQUIREMENT_ACTIONS.REJECT_AS_INVALID]: {
    from: [REQUIREMENT_STATUSES.NEEDS_PM, REQUIREMENT_STATUSES.NEEDS_INFO],
    to: REQUIREMENT_STATUSES.REJECTED,
    actorField: 'pm_owner_feishu_user_id',
  },
};

function assertCanAct(requirement, actorFeishuUserId, actorField) {
  if (!actorField) return;
  const expected = requirement[actorField];
  if (expected && expected !== actorFeishuUserId) {
    throw new Error('你不是当前阶段负责人，不能执行这个操作');
  }
}

function currentOwnerFor(nextStatus, requirement, patch = {}) {
  const field = CURRENT_OWNER_BY_STATUS[nextStatus];
  return field ? (patch[field] || requirement[field] || null) : null;
}

export async function applyRequirementAction({
  tenantId,
  requirement,
  actorFeishuUserId,
  action,
  payload = {},
}) {
  const transition = TRANSITIONS[action];
  if (!transition) throw new Error(`Unsupported requirement action: ${action}`);
  if (!transition.from.includes(requirement.status)) {
    throw new Error('当前状态不能执行这个操作');
  }
  assertCanAct(requirement, actorFeishuUserId, transition.actorField);

  const now = new Date().toISOString();
  const patch = {
    status: transition.to,
    current_owner_feishu_user_id: currentOwnerFor(transition.to, requirement),
    last_status_changed_at: now,
    blocked_reason: null,
    latest_rejection_reason: payload.reason || null,
    bitable_sync_status: 'pending',
  };
  if (transition.to === REQUIREMENT_STATUSES.CLOSED) {
    patch.closed_at = now;
    patch.actual_release_at = payload.actual_release_at || now;
  }

  const updated = await updateRequirement({ tenantId, id: requirement.id, patch });
  await addRequirementEvent({
    tenantId,
    requirementId: requirement.id,
    actorFeishuUserId,
    action,
    fromStatus: requirement.status,
    toStatus: transition.to,
    details: payload,
  });
  return updated;
}
