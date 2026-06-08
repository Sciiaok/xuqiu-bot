import {
  handleFeishuUrlVerification,
  extractSenderName,
  normalizeFeishuUserId,
  parseFeishuTextMessage,
  replyFeishuText,
  resolveRequirementBotTenantId,
  sendFeishuCard,
  updateFeishuCard,
} from '@/src/feishu-app.service';
import {
  computeDraftInitialStatus,
  generateRequirementDraft,
} from '@/src/requirement-draft.service';
import {
  buildRequirementDraftCard,
  buildRequirementExecutionCard,
} from '@/src/requirement-card.service';
import { syncRequirementToBitable } from '@/src/requirement-bitable.service';
import {
  handleRequirementEditCommand,
  handleRequirementFollowUp,
  handleRequirementSyncCommand,
  isExplicitNewRequirement,
  stripNewRequirementMarker,
} from '@/src/requirement-command.service';
import {
  CURRENT_OWNER_BY_STATUS,
  REQUIREMENT_ACTIONS,
  REQUIREMENT_STATUSES,
} from '@/src/requirement-constants';
import {
  createRequirementWithEvent,
  getRequirementBotSettings,
  markFeishuMessageProcessed,
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

function cardFor(requirement) {
  if ([
    REQUIREMENT_STATUSES.NEEDS_PM,
    REQUIREMENT_STATUSES.NEEDS_INFO,
  ].includes(requirement.status)) {
    return buildRequirementDraftCard(requirement);
  }
  return buildRequirementExecutionCard(requirement);
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

  const messageId = message.message_id || '';
  const isFirstDelivery = await markFeishuMessageProcessed({ tenantId, messageId });
  if (!isFirstDelivery) {
    return Response.json({ ok: true, skipped: 'duplicate_message' });
  }

  const settings = await getRequirementBotSettings(tenantId);
  const chatId = messageChatId(message, settings);
  if (!chatId) return Response.json({ error: 'Feishu chat id is required' }, { status: 400 });

  const submitter = extractSenderId(sender);
  if (!submitter) return Response.json({ error: 'Feishu sender id is required' }, { status: 400 });
  const submitterName = extractSenderName(sender);

  const syncResult = await handleRequirementSyncCommand({
    tenantId,
    text: rawText,
    syncRequirementToBitable,
  });
  if (syncResult.handled) {
    if (message.message_id) {
      await replyFeishuText({
        tenantId,
        messageId: message.message_id,
        content: syncResult.ok ? syncResult.message : `同步失败：${syncResult.error}`,
      });
    }
    return Response.json({
      ok: Boolean(syncResult.ok),
      handled: 'sync_command',
      requirement_id: syncResult.requirement?.id || null,
      error: syncResult.error || null,
    });
  }

  const commandResult = await handleRequirementEditCommand({
    tenantId,
    text: rawText,
    actorFeishuUserId: submitter,
  });
  if (commandResult.handled) {
    if (message.message_id) {
      await replyFeishuText({
        tenantId,
        messageId: message.message_id,
        content: commandResult.ok ? commandResult.message : `修改失败：${commandResult.error}`,
      });
    }

    if (commandResult.ok) {
      const updated = commandResult.requirement;
      if (updated.feishu_card_message_id) {
        await updateFeishuCard({
          tenantId,
          messageId: updated.feishu_card_message_id,
          card: cardFor(updated),
        }).catch(err => {
          console.warn('[requirements] card refresh after edit command failed:', err.message);
        });
      }
      syncRequirementToBitable({ tenantId, requirement: updated }).catch(err => {
        console.warn('[requirements] bitable sync after edit command failed:', err.message);
      });
    }

    return Response.json({
      ok: Boolean(commandResult.ok),
      handled: 'edit_command',
      requirement_id: commandResult.requirement?.id || null,
      error: commandResult.error || null,
    });
  }

  const followUpResult = await handleRequirementFollowUp({
    tenantId,
    chatId,
    text: rawText,
    actorFeishuUserId: submitter,
  });
  if (followUpResult.handled) {
    if (message.message_id) {
      await replyFeishuText({
        tenantId,
        messageId: message.message_id,
        content: followUpResult.ok ? followUpResult.message : `补充失败：${followUpResult.error}`,
      });
    }

    if (followUpResult.ok) {
      const updated = followUpResult.requirement;
      if (updated.feishu_card_message_id) {
        await updateFeishuCard({
          tenantId,
          messageId: updated.feishu_card_message_id,
          card: cardFor(updated),
        }).catch(err => {
          console.warn('[requirements] card refresh after follow-up failed:', err.message);
        });
      }
      syncRequirementToBitable({ tenantId, requirement: updated }).catch(err => {
        console.warn('[requirements] bitable sync after follow-up failed:', err.message);
      });
    }

    return Response.json({
      ok: Boolean(followUpResult.ok),
      handled: 'follow_up',
      requirement_id: followUpResult.requirement?.id || null,
      error: followUpResult.error || null,
    });
  }

  if (!isExplicitNewRequirement(rawText)) {
    if (message.message_id) {
      await replyFeishuText({
        tenantId,
        messageId: message.message_id,
        content: '我没有新建需求。请带上需求编号，例如：REQ-20260608-001 补充一下：具体说明。只有写【新需求】才会新建需求。',
      });
    }
    return Response.json({ ok: true, skipped: 'missing_requirement_id_or_new_marker' });
  }

  const requirementText = stripNewRequirementMarker(rawText);
  if (!requirementText) {
    if (message.message_id) {
      await replyFeishuText({
        tenantId,
        messageId: message.message_id,
        content: '请在【新需求】后面写需求内容。',
      });
    }
    return Response.json({ ok: true, skipped: 'empty_new_requirement' });
  }

  const draft = await generateRequirementDraft({
    tenantId,
    rawDescription: requirementText,
    submitterName: submitter,
  });
  const status = computeDraftInitialStatus(draft);
  const reqNo = await nextRequirementNo();
  const currentOwnerField = CURRENT_OWNER_BY_STATUS[status];
  const currentOwner = currentOwnerField === 'submitter_feishu_user_id'
    ? submitter
    : settings?.default_pm_feishu_user_id || null;
  const currentOwnerName = currentOwnerField === 'submitter_feishu_user_id'
    ? submitterName
    : null;

  let requirement = await createRequirementWithEvent({
    tenantId,
    requirement: {
      tenant_id: tenantId,
      req_no: reqNo,
      title: draft.title,
      raw_description: requirementText,
      status,
      requirement_type: draft.requirement_type,
      prd_template_type: draft.prd_template_type,
      priority: draft.priority,
      priority_reason: draft.priority_reason,
      submitter_feishu_user_id: submitter,
      submitter_feishu_name: submitterName,
      pm_owner_feishu_user_id: settings?.default_pm_feishu_user_id || null,
      pm_owner_name: '',
      developer_feishu_user_id: settings?.default_developer_feishu_user_id || null,
      developer_name: '',
      tester_feishu_user_id: settings?.default_tester_feishu_user_id || null,
      tester_name: '',
      acceptor_feishu_user_id: settings?.default_acceptor_feishu_user_id || null,
      acceptor_name: '',
      current_owner_feishu_user_id: currentOwner,
      current_owner_name: currentOwnerName,
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
  const cardMessageId = cardResult?.message_id || cardResult?.data?.message_id || null;
  if (cardMessageId) {
    requirement = await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: { feishu_card_message_id: cardMessageId },
    });
  }

  const bitableResult = await syncRequirementToBitable({ tenantId, requirement });
  if (!bitableResult.ok && !bitableResult.skipped && message.message_id) {
    await replyFeishuText({
      tenantId,
      messageId: message.message_id,
      content: `需求 ${requirement.req_no} 已记录，但同步多维表格失败：${bitableResult.error}`,
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
