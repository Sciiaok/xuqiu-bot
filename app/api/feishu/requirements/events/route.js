import {
  handleFeishuUrlVerification,
  normalizeFeishuUserId,
  parseFeishuTextMessage,
  replyFeishuText,
  resolveRequirementBotTenantId,
  sendFeishuCard,
} from '@/src/feishu-app.service';
import {
  computeDraftInitialStatus,
  generateRequirementDraft,
} from '@/src/requirement-draft.service';
import { buildRequirementDraftCard } from '@/src/requirement-card.service';
import {
  CURRENT_OWNER_BY_STATUS,
  REQUIREMENT_ACTIONS,
} from '@/src/requirement-constants';
import {
  createRequirementWithEvent,
  getRequirementBotSettings,
  nextRequirementNo,
  updateRequirement,
} from '@/lib/repositories/requirement.repository';

function addHours(hours) {
  const d = new Date();
  d.setHours(d.getHours() + Number(hours || 0));
  return d.toISOString();
}

function extractEvent(body) {
  return body?.event || body?.event_callback?.event || {};
}

function extractSenderId(sender) {
  return normalizeFeishuUserId(sender?.sender_id || sender || {});
}

function messageChatId(message, settings) {
  return message.chat_id || settings?.default_chat_id || '';
}

export async function POST(request) {
  const body = await request.json();
  const verification = handleFeishuUrlVerification(body);
  if (verification) return Response.json(verification);

  const tenantId = resolveRequirementBotTenantId();
  const event = extractEvent(body);
  const message = event.message || {};
  const sender = event.sender || {};
  const rawText = parseFeishuTextMessage(message);
  if (!rawText) return Response.json({ ok: true, skipped: 'empty_text' });

  const settings = await getRequirementBotSettings(tenantId);
  const chatId = messageChatId(message, settings);
  if (!chatId) return Response.json({ error: 'Feishu chat id is required' }, { status: 400 });

  const submitter = extractSenderId(sender);
  if (!submitter) return Response.json({ error: 'Feishu sender id is required' }, { status: 400 });

  const draft = await generateRequirementDraft({
    tenantId,
    rawDescription: rawText,
    submitterName: submitter,
  });
  const status = computeDraftInitialStatus(draft);
  const reqNo = await nextRequirementNo();
  const currentOwnerField = CURRENT_OWNER_BY_STATUS[status];
  const currentOwner = currentOwnerField === 'submitter_feishu_user_id'
    ? submitter
    : settings?.default_pm_feishu_user_id || null;

  const requirement = await createRequirementWithEvent({
    tenantId,
    requirement: {
      tenant_id: tenantId,
      req_no: reqNo,
      title: draft.title,
      raw_description: rawText,
      status,
      requirement_type: draft.requirement_type,
      prd_template_type: draft.prd_template_type,
      priority: draft.priority,
      priority_reason: draft.priority_reason,
      submitter_feishu_user_id: submitter,
      pm_owner_feishu_user_id: settings?.default_pm_feishu_user_id || null,
      developer_feishu_user_id: settings?.default_developer_feishu_user_id || null,
      tester_feishu_user_id: settings?.default_tester_feishu_user_id || null,
      acceptor_feishu_user_id: settings?.default_acceptor_feishu_user_id || null,
      current_owner_feishu_user_id: currentOwner,
      feishu_chat_id: chatId,
      feishu_root_message_id: message.message_id || null,
      ai_confidence: draft.ai_confidence,
      ai_raw_output: draft.ai_raw_output,
      prd: draft.prd,
      pm_due_at: addHours(draft.suggested_schedule.pm_hours || 24),
      dev_due_at: addHours(draft.suggested_schedule.dev_hours || 72),
      test_due_at: addHours(draft.suggested_schedule.test_hours || 96),
      acceptance_due_at: addHours(draft.suggested_schedule.acceptance_hours || 120),
    },
    event: {
      actorFeishuUserId: submitter,
      action: REQUIREMENT_ACTIONS.CREATE_FROM_FEISHU,
      details: { message_id: message.message_id || null, chat_id: chatId },
    },
  });

  const cardResult = await sendFeishuCard({
    tenantId,
    receiveId: requirement.feishu_chat_id,
    card: buildRequirementDraftCard(requirement),
  });
  const messageId = cardResult?.message_id || cardResult?.data?.message_id || null;
  if (messageId) {
    await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: { feishu_card_message_id: messageId },
    });
  }

  if (status === 'needs_info' && message.message_id) {
    await replyFeishuText({
      tenantId,
      messageId: message.message_id,
      content: `需求 ${requirement.req_no} 已记录，但信息还不够，请补充后 @机器人继续说明。`,
    });
  }

  return Response.json({ ok: true, requirement_id: requirement.id });
}
