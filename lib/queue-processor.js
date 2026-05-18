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
  isFaqEnded,
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

/**
 * 兜底通道：把客户消息原样落库，但不调 Medici、不发回复。
 * takeover 期间和 FAQ_END 静默期共用。
 *
 * 落库分流（与主路径 aiReplyPersisted 同思路）：
 * - 全部 createMessage 成功 → markAsCompleted 正常收尾
 * - 已写过任何一条然后失败 → markAsCompleted 截断，防 retry 双写 inbox
 * - 一条都没写就失败 → markAsFailed 走正常重试
 */
async function persistMessagesOnly({
  messages,
  messageIds,
  conversationId,
  tenantId,
  logger,
  reasonTag,
}) {
  let anyPersisted = false;
  try {
    for (const msg of messages) {
      await createMessage({
        tenantId,
        conversationId,
        role: 'user',
        content: msg.content,
        sentBy: 'customer',
        metadata: msg.metadata || {},
      });
      anyPersisted = true;
      await updateConversationOnMessage(conversationId);
    }
    await markAsCompleted(messageIds);
    return { processed: true, messageCount: messages.length };
  } catch (err) {
    if (anyPersisted) {
      logger.error(`queue.${reasonTag}.partial_persist_failed`, {
        error: err.message,
        message_ids: messageIds,
      });
      try { await markAsCompleted(messageIds); }
      catch (e) { logger.error(`queue.${reasonTag}.complete_failed`, { error: e.message }); }
      return { processed: true, deliveryFailed: true, error: err.message, messageCount: messages.length };
    }
    await markAsFailed(messageIds, err.message);
    return { processed: false, error: err.message, messageCount: messages.length };
  }
}

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
    const result = await persistMessagesOnly({
      messages, messageIds, conversationId, tenantId, logger, reasonTag: 'takeover',
    });
    return { ...result, humanTakeover: true };
  }

  // FAQ_END 静默期：和 takeover 对称的"客户消息只入库不喂 AI"通道。
  // routing.service.js 在 FAQ_END 分支末尾 markFaqEnded；webhook 检测到新
  // CTWA referral 会清空（视为新意图）；其余情况持续静默直到 3 天 idle
  // 自然走 markConversationIdle 起新会话。
  const faqMuted = await isFaqEnded(conversationId);
  if (faqMuted) {
    logger.info('queue.processing.skipped_faq_ended');
    const result = await persistMessagesOnly({
      messages, messageIds, conversationId, tenantId, logger, reasonTag: 'faq_ended',
    });
    return { ...result, faqEnded: true };
  }

  // 一旦 processMessageForConversation 成功落库（user + assistant + leads），
  // 后续任何步骤失败都不能触发 retry —— 否则会再跑一遍 Medici、再写一份
  // 重复行、再发一遍 WhatsApp。catch 里据此分流：未落库 → markAsFailed 走
  // 正常重试链；已落库 → markAsCompleted 截断，error log 给 ops 兜底。
  let aiReplyPersisted = false;

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

      // 同 takeover 分支：落库分流防止 retry 双写。
      let anyPersistedUnbound = false;
      try {
        for (const msg of messages) {
          await createMessage({
            tenantId,
            conversationId,
            role: 'user',
            content: msg.content,
            sentBy: 'customer',
            metadata: msg.metadata || {},
          });
          anyPersistedUnbound = true;
          await updateConversationOnMessage(conversationId);
        }
      } catch (err) {
        if (anyPersistedUnbound) {
          logger.error('queue.unbound_phone.partial_persist_failed', {
            error: err.message,
            message_ids: messageIds,
          });
          try { await markAsCompleted(messageIds); }
          catch (e) { logger.error('queue.unbound_phone.complete_failed', { error: e.message }); }
          return { processed: true, deliveryFailed: true, error: err.message, messageCount: messages.length };
        }
        await markAsFailed(messageIds, err.message);
        return { processed: false, error: err.message, messageCount: messages.length };
      }

      // sendMessage 已经自带 swallow（fire-and-forget 风格的最佳努力发回复）—— 失败不影响 markAsCompleted。
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
        car_model: session._lead.details?.car_model || session._lead.details?.product_name || null,
        qty_bucket: session._lead.details?.qty_bucket || null,
        destination_country: session._lead.details?.destination_country || null,
        company_name: session._lead.details?.company_name || null,
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
    // 8.5. 落库分水岭 —— 此点之后再失败，重试就是双写 + 重复发。把开关
    //      置位，让 catch 走"截断重试"路径。
    aiReplyPersisted = true;

    // Log multi-lead info
    const leadsCount = (claudeResponse.leads || []).length;
    if (leadsCount > 1) {
      logger.info('queue.claude.multi_lead', {
        leads_count: leadsCount,
        lead_targets: claudeResponse.leads.map((lead) => ({
          car_model: lead.details?.car_model || null,
          destination_country: lead.details?.destination_country || null,
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
      // Hand the freshest lead's product fields to the guard so it can drop
      // any picked asset whose linked_skus contradicts what the customer's
      // actually been asking about. See attachment-guard.js.
      const freshLead = Array.isArray(claudeResponse.leads) ? claudeResponse.leads[0] : null;
      const productContext = freshLead ? {
        carModel: freshLead.details?.car_model || null,
        brand: freshLead.details?.brand || null,
        productName: freshLead.details?.product_name || null,
      } : {};
      const result = await sendMediciAttachments({
        attachments: claudeResponse.attachments,
        conversationId: updatedSession.conversation_id,
        tenantId,
        waId,
        phoneNumberId: sessionPhoneNumberId,
        productContext,
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
    if (aiReplyPersisted) {
      // 落库已成功，失败只可能在 sendMessage / sendMediciAttachments /
      // executeConversationRouting / markAsCompleted 这几步。retry 会让
      // Medici 再算一遍 + messages 表多一份重复 user/assistant 行 + WhatsApp
      // 再发一遍 —— 是更糟的结果。截断重试，记 error 让 ops 看 messages
      // 表里那条 assistant 回复手动派发即可（HUMAN_NOW 的 feishu 通知本身
      // 已经在 routing.service.js 里幂等）。
      logger.error('queue.delivery_failed_post_persist', {
        error: error.message,
        message_ids: messageIds,
      });
      try {
        await markAsCompleted(messageIds);
      } catch (completeErr) {
        // markAsCompleted 自己挂的极端 case —— 行会停在 processing 上，
        // release_stale_queue_locks 90s 后回收。那时 retry 仍然双写，但
        // 至少不是这个路径能优雅处理的。继续抛让外层看到。
        logger.error('queue.complete_after_delivery_failure_failed', {
          error: completeErr.message,
        });
      }
      return {
        processed: true,
        deliveryFailed: true,
        error: error.message,
        messageCount: messages.length,
      };
    }

    logger.error('queue.processing.failed', {
      error: error.message,
    });

    // Mark as failed for retry — 落库前失败，重试是安全的。
    await markAsFailed(messageIds, error.message);

    return {
      processed: false,
      error: error.message,
      messageCount: messages.length,
    };
  }
}
