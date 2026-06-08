import {
  handleFeishuUrlVerification,
  normalizeFeishuUserId,
  resolveRequirementBotTenantId,
} from '@/src/feishu-app.service';
import {
  buildRequirementDraftCard,
  buildRequirementExecutionCard,
} from '@/src/requirement-card.service';
import {
  cardCallbackResponse,
  requirementActionToastMessage,
} from '@/src/requirement-card-callback.service';
import { syncRequirementToBitable } from '@/src/requirement-bitable.service';
import { applyRequirementAction } from '@/src/requirement-state.service';
import {
  REQUIREMENT_ACTIONS,
  REQUIREMENT_STATUSES,
} from '@/src/requirement-constants';
import {
  addRequirementEvent,
  getRequirementById,
  updateRequirement,
} from '@/lib/repositories/requirement.repository';

function callbackValue(body) {
  return body?.event?.action?.value || body?.action?.value || {};
}

function callbackUser(body) {
  return normalizeFeishuUserId(
    body?.event?.operator || body?.operator || body?.event?.user || {},
  );
}

function callbackToast(type, content) {
  return cardCallbackResponse(type, content);
}

function cardFor(requirement) {
  if ([
    REQUIREMENT_STATUSES.NEEDS_PM,
    REQUIREMENT_STATUSES.NEEDS_INFO,
  ].includes(requirement.status)) {
    return buildRequirementDraftCard(requirement);
  }
  return buildRequirementExecutionCard(requirement);
}

async function applyNonTransitionAction({ tenantId, requirement, actorFeishuUserId, action, value }) {
  if (action === REQUIREMENT_ACTIONS.BLOCK) {
    const updated = await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: {
        blocked_reason: value.reason || '未填写原因',
        bitable_sync_status: 'pending',
      },
    });
    await addRequirementEvent({
      tenantId,
      requirementId: requirement.id,
      actorFeishuUserId,
      action,
      fromStatus: requirement.status,
      toStatus: requirement.status,
      details: { reason: updated.blocked_reason },
    });
    return updated;
  }

  if (action === REQUIREMENT_ACTIONS.EXTEND_DEADLINE) {
    const patch = {
      bitable_sync_status: 'pending',
    };
    for (const field of ['pm_due_at', 'dev_due_at', 'test_due_at', 'acceptance_due_at', 'planned_release_at']) {
      if (value[field]) patch[field] = value[field];
    }
    const updated = await updateRequirement({ tenantId, id: requirement.id, patch });
    await addRequirementEvent({
      tenantId,
      requirementId: requirement.id,
      actorFeishuUserId,
      action,
      fromStatus: requirement.status,
      toStatus: requirement.status,
      details: patch,
    });
    return updated;
  }

  if (action === REQUIREMENT_ACTIONS.GENERATE_PLAN) {
    return requirement;
  }

  throw new Error(`Unsupported requirement action: ${action}`);
}

export async function POST(request) {
  const body = await request.json();
  const verification = handleFeishuUrlVerification(body);
  if (verification) return Response.json(verification);

  const tenantId = resolveRequirementBotTenantId();
  const value = callbackValue(body);
  const actorFeishuUserId = callbackUser(body);
  const action = value.action;
  const requirementId = value.requirement_id;
  if (!action || !requirementId) {
    return callbackToast('error', '卡片参数缺失');
  }

  const requirement = await getRequirementById({ tenantId, id: requirementId });
  if (!requirement) {
    return callbackToast('error', '需求不存在');
  }

  try {
    const updated = [
      REQUIREMENT_ACTIONS.BLOCK,
      REQUIREMENT_ACTIONS.EXTEND_DEADLINE,
      REQUIREMENT_ACTIONS.GENERATE_PLAN,
    ].includes(action)
      ? await applyNonTransitionAction({ tenantId, requirement, actorFeishuUserId, action, value })
      : await applyRequirementAction({
        tenantId,
        requirement,
        actorFeishuUserId,
        action,
        payload: value,
      });

    syncRequirementToBitable({ tenantId, requirement: updated }).catch(err => {
      console.warn('[requirements] bitable sync after card action failed:', err.message);
    });
    const message = requirementActionToastMessage({ action });
    return cardCallbackResponse('success', message, cardFor(updated));
  } catch (err) {
    return callbackToast('error', err.message);
  }
}
