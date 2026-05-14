/**
 * Queue Processor - Aggregates and processes queued messages
 * Handles rapid message sequences by combining them into a single Claude call
 */

import {
  acquirePendingMessages,
  markAsCompleted,
  markAsFailed,
} from './repositories/queue.repository.js';
import { getSessionByConversationId, processMessageForConversation } from './session.js';
import { runMedici } from '../src/agents/medici/index.js';
import {
  getMissingFields,
  hasReachedGlobalMaxTurns,
  getGlobalMaxTurns,
} from '../src/inquiry-quality.js';
import { executeConversationRouting } from '../src/routing.service.js';
import { sendMessage } from '../src/whatsapp.service.js';
import { createMessage } from './repositories/message.repository.js';
import {
  checkAndExpireTakeover,
  updateConversationOnMessage,
  findConversationById,
} from './repositories/conversation.repository.js';
import { loadMediciConfig } from '../src/agents/medici/config.js';
import { sendMediciAttachments } from '../src/agents/medici/send-attachments.js';
import { markFirstAiReply } from './repositories/onboarding.repository.js';
import { resolveMetaTokenForTenant } from './meta-tenant-context.js';
import {
  createTraceLogger,
  extractTraceIdFromMessages,
  generateTraceId,
} from './core-trace.js';
import {
  extractMetaAdIdFromMessageMetadata,
  formatReferralContextForPrompt,
} from './referral-context.js';
import { findContactById } from './repositories/contact.repository.js';

function buildStoredUserMessage(messages, aggregatedContent) {
  const metaAdId = extractMetaAdIdFromMessageMetadata({
    aggregated_messages: messages.map((msg) => ({
      metadata: msg.metadata || {},
    })),
  });

  if (messages.length === 1) {
    return {
      content: messages[0].content,
      metadata: {
        ...(messages[0].metadata || {}),
        ...(metaAdId ? { meta_ad_id: metaAdId } : {}),
      },
    };
  }

  return {
    content: aggregatedContent,
    metadata: {
      ...(metaAdId ? { meta_ad_id: metaAdId } : {}),
      aggregated_messages: messages.map((msg) => ({
        content: msg.content,
        message_type: msg.message_type || 'text',
        wa_message_id: msg.wa_message_id || null,
        metadata: msg.metadata || {},
      })),
    },
  };
}

/**
 * Process the message queue for a single conversation
 * Multi-instance safe: uses SELECT FOR UPDATE SKIP LOCKED
 *
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Processing result
 */
export async function processConversationQueue(conversationId) {
  // 1. Acquire and lock pending messages (distributed lock)
  const messages = await acquirePendingMessages(conversationId);

  // If no messages (possibly handled by another instance), return
  if (!messages || messages.length === 0) {
    createTraceLogger({
      component: 'queue',
      conversation_id: conversationId,
    }).info('queue.no_pending_messages');
    return { processed: false, reason: 'no_messages' };
  }

  const waId = messages[0].wa_id;
  const messageIds = messages.map((m) => m.id);
  const traceId = extractTraceIdFromMessages(messages) || generateTraceId('queue');
  const logger = createTraceLogger({
    component: 'queue',
    trace_id: traceId,
    conversation_id: conversationId,
    wa_id: waId,
    queue_ids: messageIds,
    queued_count: messages.length,
  });
  logger.info('queue.processing.started');

  // 早 load conversation 一次：拿 tenant_id 给后续所有 createMessage / lead 写入
  // 用，避免依赖 DEFAULT 兜底。下面 medici 流程也复用这条记录。
  const conversation = await findConversationById(conversationId);
  const tenantId = conversation?.tenant_id;
  if (!tenantId) {
    logger.error('queue.processing.missing_tenant', { conversation_id: conversationId });
    await markAsFailed(messageIds, 'missing tenant_id on conversation');
    return { processed: false, reason: 'missing_tenant' };
  }

  // Check if human is controlling this conversation (with timeout expiry)
  const humanActive = await checkAndExpireTakeover(conversationId);
  if (humanActive) {
    logger.info('queue.processing.skipped_human_takeover');

    // FIX (Codex W3): Save each message and update count for each
    for (const msg of messages) {
      await createMessage({
        tenantId,
        conversationId,
        role: 'user',
        content: msg.content,
        sentBy: 'customer',
        metadata: msg.metadata || {},
      });
      await updateConversationOnMessage(conversationId);
    }
    await markAsCompleted(messageIds);

    return { processed: true, messageCount: messages.length, humanTakeover: true };
  }

  try {
    // 2. Aggregate message content (newline-separated)
    const aggregatedContent = messages.map((m) => m.content).join('\n');
    logger.info('queue.messages.aggregated', {
      aggregated_preview: aggregatedContent.slice(0, 240),
      includes_media: messages.some((msg) => Boolean(msg.metadata?.media_type)),
    });
    const latestUserInput = messages.length === 1
      ? {
          role: 'user',
          content: messages[0].content,
          metadata: messages[0].metadata || {},
        }
      : messages.map((msg) => ({
          role: 'user',
          content: msg.content,
          metadata: msg.metadata || {},
        }));
    const latestUserMessageForStorage = buildStoredUserMessage(messages, aggregatedContent);

    // 3. Resolve the product_line for this conversation.
    //    Routing is a pure phone_number_id → product_lines lookup (managed via
    //    the /product-lines admin UI). No router LLM.
    const agentConfig = await loadMediciConfig(conversation);
    const conversationPhoneNumberId = conversation?.wa_phone_number_id || null;

    // Strategy C: unbound phone number — no product_line is mapped to the
    // WhatsApp number this message arrived on. Reply with a polite placeholder,
    // persist the inbound messages so ops can see what the customer asked once
    // they bind the number, then ack without running Claude / routing leads.
    if (!agentConfig) {
      logger.warn('queue.unbound_phone', {
        phone_number_id: conversationPhoneNumberId,
      });

      for (const msg of messages) {
        await createMessage({
          tenantId,
          conversationId,
          role: 'user',
          content: msg.content,
          sentBy: 'customer',
          metadata: msg.metadata || {},
        });
        await updateConversationOnMessage(conversationId);
      }

      if (conversationPhoneNumberId) {
        try {
          await sendMessage(
            waId,
            "Thanks for your message! We're still setting up for this number. Please reach out via our website or try again later.",
            conversationPhoneNumberId,
          );
        } catch (err) {
          logger.warn('queue.unbound_phone.reply_failed', { error: err.message });
        }
      }

      await markAsCompleted(messageIds);

      return {
        processed: true,
        messageCount: messages.length,
        unboundPhone: true,
      };
    }

    // 4. Get session after routing (includes correct agent context on new links).
    const session = await getSessionByConversationId(conversationId);
    const sessionPhoneNumberId = session._conversation?.wa_phone_number_id || conversationPhoneNumberId;

    // 5. Build context info (missing fields + prior classification state)
    //    qualify_missing_fields = QUALIFY tier 缺什么；非空 → 报价闸口锁住，
    //    KB 工具会从返回里去掉价格字段（见 medici/kb-tools.js）。
    const contextInfo = {
      missing_fields: getMissingFields(
        session._lead?.inquiry_quality || 'GOOD',
        session.lead_data,
        {
          qualificationConfig: agentConfig?.qualification_config,
          lead: session._lead,
        }
      ),
      qualify_missing_fields: getMissingFields(
        'QUALIFY',
        session.lead_data,
        {
          qualificationConfig: agentConfig?.qualification_config,
          lead: session._lead,
        }
      ),
      prior_state: session._lead ? {
        conversation_intent: session._lead.conversation_intent,
        inquiry_quality: session._lead.inquiry_quality,
        business_value: session._lead.business_value,
        car_model: session._lead.car_model || session._lead.product_name || null,
        qty_bucket: session._lead.qty_bucket || null,
        destination_country: session._lead.destination_country || null,
        company_name: session._lead.company_name || null,
      } : null,
    };

    // 5b. Inject the Meta ad creative that brought this customer in. Persisted
    //     on the contact as last_referral by the webhook; we surface it on
    //     every turn so Claude can acknowledge ad-specific hooks (headline,
    //     body copy, landing URL) without the customer having to restate them.
    const contact = conversation?.contact_id ? await findContactById(conversation.contact_id) : null;
    const adReferral = formatReferralContextForPrompt(contact?.metadata?.last_referral);
    if (adReferral) {
      contextInfo.ad_referral = adReferral;
    }

    // 6. Single Medici call to process all aggregated messages
    //    metaToken 让 medici 内部下载 inbound media 时用 tenant 的 token
    const metaToken = await resolveMetaTokenForTenant(tenantId);
    const claudeResponse = await runMedici({
      history: session.messages,
      input: latestUserInput,
      context: contextInfo,
      agentConfig,
      metaToken,
      trace: { traceId, conversationId, waId },
    });

    // 8. Process message and update all data (handles multi-lead internally)
    const updatedSession = await processMessageForConversation(
      conversationId,
      latestUserMessageForStorage,
      claudeResponse
    );

    // Log multi-lead info
    const leadsCount = (claudeResponse.leads || []).length;
    if (leadsCount > 1) {
      logger.info('queue.claude.multi_lead', {
        leads_count: leadsCount,
        lead_targets: claudeResponse.leads.map((lead) => ({
          car_model: lead.car_model || null,
          destination_country: lead.destination_country || null,
        })),
      });
    }

    logger.info('queue.claude.completed', {
      intent: claudeResponse.conversation_intent,
      inquiry_quality: claudeResponse.inquiry_quality,
      business_value: claudeResponse.business_value,
      route: claudeResponse.route,
      leads_count: leadsCount,
    });

    // 9. Send single response to user (skip if empty - spam case)
    if (claudeResponse.next_message && claudeResponse.next_message.trim() !== '') {
      await sendMessage(waId, claudeResponse.next_message, sessionPhoneNumberId);
      logger.info('queue.reply.sent', {
        reply_preview: claudeResponse.next_message.slice(0, 240),
      });
      // Onboarding：第一次 AI 回复成功
      markFirstAiReply(tenantId).catch(err =>
        logger.warn('queue.markFirstAiReply.failed', { error: err.message }));
    } else {
      logger.info('queue.reply.skipped_empty');
    }

    // 9b. Deliver any KB image attachments Medici chose to send. Runs after the
    //     text so the customer sees the reply first, then the image bubble(s).
    if (Array.isArray(claudeResponse.attachments) && claudeResponse.attachments.length > 0) {
      const result = await sendMediciAttachments({
        attachments: claudeResponse.attachments,
        conversationId: updatedSession.conversation_id,
        tenantId,
        waId,
        phoneNumberId: sessionPhoneNumberId,
        logger,
      });
      logger.info('queue.attachments.completed', result);
    }

    // 10. Check global max turns - force FAQ_END if exceeded
    let finalRoute = claudeResponse.route;
    if (hasReachedGlobalMaxTurns(updatedSession.messages?.length || 0)) {
      logger.warn('queue.route.forced_faq_end', {
        global_max_turns: getGlobalMaxTurns(),
      });
      finalRoute = 'FAQ_END';
    }

    // 11. Handle routing for all active leads in conversation
    if (finalRoute !== 'CONTINUE') {
      logger.info('queue.routing.execute', {
        final_route: finalRoute,
      });
      const routingResult = await executeConversationRouting(
        finalRoute,
        updatedSession.conversation_id,
        waId,
        claudeResponse.handoff_summary,
        updatedSession._conversation?.wa_phone_number_id || sessionPhoneNumberId,
        { traceId, conversationId: updatedSession.conversation_id, waId }
      );

      logger.info('queue.routing.completed', {
        success: routingResult.success,
        leads_routed: routingResult.leadsRouted || 0,
        reason: routingResult.reason || null,
      });
    }

    // 12. Mark queue messages as completed
    await markAsCompleted(messageIds);
    logger.info('queue.processing.completed');

    return {
      processed: true,
      messageCount: messages.length,
      aggregatedContent,
      response: claudeResponse.next_message,
    };
  } catch (error) {
    logger.error('queue.processing.failed', {
      error: error.message,
    });

    // Mark as failed for retry
    await markAsFailed(messageIds, error.message);

    return {
      processed: false,
      error: error.message,
      messageCount: messages.length,
    };
  }
}
