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
import { getResponse } from '../src/claude.service.js';
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
import {
  buildRoutingClarificationResponse,
  resolveAgentForConversation,
} from './agent-routing.service.js';
import {
  createTraceLogger,
  extractTraceIdFromMessages,
  generateTraceId,
} from './core-trace.js';
import { extractMetaAdIdFromMessageMetadata } from './referral-context.js';
import { buildCarCatalogContext } from './car-catalog-context.js';

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

  // Check if human is controlling this conversation (with timeout expiry)
  const humanActive = await checkAndExpireTakeover(conversationId);
  if (humanActive) {
    logger.info('queue.processing.skipped_human_takeover');

    // FIX (Codex W3): Save each message and update count for each
    for (const msg of messages) {
      await createMessage({
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

    // 3. Resolve agent for this conversation before building session context.
    const conversation = await findConversationById(conversationId);
    const agentResolution = await resolveAgentForConversation({
      conversationId,
      latestUserMessage: aggregatedContent,
      traceContext: { traceId, conversationId, waId },
    });
    const agentConfig = agentResolution.agent;
    const conversationPhoneNumberId = conversation?.wa_phone_number_id || null;

    if (agentResolution.usedRouter) {
      logger.info('queue.router.decision', {
        selected_agent_id: agentResolution.routingDecision?.agentId || null,
        confidence: agentResolution.routingDecision?.confidence || null,
        needs_clarification: Boolean(agentResolution.routingDecision?.needsClarification),
        reason: agentResolution.routingDecision?.reason || null,
      });
    }

    if (!conversation?.agent_id && agentResolution.routingDecision?.needsClarification) {
      const clarificationResponse = buildRoutingClarificationResponse(agentResolution.routingDecision);
      await processMessageForConversation(conversationId, latestUserMessageForStorage, clarificationResponse);

      if (clarificationResponse.next_message) {
        await sendMessage(waId, clarificationResponse.next_message, conversationPhoneNumberId);
      }

      await markAsCompleted(messageIds);

      return {
        processed: true,
        messageCount: messages.length,
        clarificationRequired: true,
        response: clarificationResponse.next_message,
      };
    }

    // 4. Get session after routing (includes correct agent context on new links).
    const session = await getSessionByConversationId(conversationId);
    const sessionPhoneNumberId = session._conversation?.wa_phone_number_id || conversationPhoneNumberId;

    // 5. Build context info (missing fields + prior classification state)
    const contextInfo = {
      missing_fields: getMissingFields(
        session._lead?.inquiry_quality || 'GOOD',
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

    // 5b. Inject car catalog context (keyword + region matching)
    const carContext = buildCarCatalogContext(aggregatedContent, waId, logger);
    if (carContext) {
      contextInfo.car_recommendation = carContext;
    }

    // 6. Single Claude call to process all aggregated messages
    const claudeResponse = await getResponse(
      session.messages,
      latestUserInput,
      contextInfo,
      agentConfig,
      { traceId, conversationId, waId }
    );

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
    } else {
      logger.info('queue.reply.skipped_empty');
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
