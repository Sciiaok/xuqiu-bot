import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { config, pickAggregationWindowMs } from '../../../src/config.js';
import { sendMessage, markAsRead } from '../../../src/whatsapp.service.js';
import { transcribeWhatsAppAudio } from '../../../src/whisper.service.js';
import {
  buildInboundMediaPlaceholder,
  buildMediaFilename,
  buildWhatsAppMediaProxyUrl,
} from '../../../src/whatsapp-media.service.js';
import { getOrCreateRoutedConversationContext } from '../../../lib/conversation-context.service.js';
import { enqueueMessage, hasPendingMessages } from '../../../lib/repositories/queue.repository.js';
import { isHumanTakeover, clearFaqEnded } from '../../../lib/repositories/conversation.repository.js';
import { processConversationQueue } from '../../../lib/queue-processor.js';
import { updateContactMetadata } from '../../../lib/repositories/contact.repository.js';
import { resolveTenantByPhoneNumberId } from '../../../lib/tenant-context.js';
import { resolveMetaTokenForTenant } from '../../../lib/meta-tenant-context.js';
import { markFirstMessageReceived } from '../../../lib/repositories/onboarding.repository.js';
import {
  mergeContactReferralMetadata,
  normalizeReferral,
} from '../../../lib/referral-context.js';
import { createTraceLogger, generateTraceId } from '../../../lib/core-trace.js';
import { dumpWebhookPayload } from '../../../lib/repositories/webhook-dump.repository.js';

/**
 * GET /api/webhook - Webhook verification endpoint
 * WhatsApp calls this to verify the webhook
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  console.log('Webhook verification request received');

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('Webhook verified successfully');
    return new Response(challenge, { status: 200 });
  } else {
    console.error('Webhook verification failed');
    return new Response('Forbidden', { status: 403 });
  }
}

/**
 * Verify Meta's X-Hub-Signature-256 over the raw request body.
 * Returns true iff the header is present AND HMAC-SHA256(body, appSecret)
 * matches in constant time. Anything else → false → POST 401.
 *
 * 没配 appSecret 时直接拒 —— 裸跑 webhook 等于任何知道 phone_number_id 的人
 * 都能伪造客户消息 / 烧 Medici 配额。
 */
function verifyMetaSignature(rawBody, headerValue) {
  const appSecret = config.meta.appSecret;
  if (!appSecret) return false;
  if (!headerValue || typeof headerValue !== 'string') return false;
  if (!headerValue.startsWith('sha256=')) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  // timingSafeEqual 要等长 Buffer，否则直接 throw —— 长度先比一次避免抛错。
  const got = Buffer.from(headerValue);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

/**
 * Trigger queue processing after the aggregation window matures.
 * @param {string} conversationId - Conversation UUID
 * @param {number} delayMs - Same window used for the matching enqueue, so
 *   the timer fires right when the row becomes acquirable.
 */
function scheduleProcessing(conversationId, delayMs) {
  setTimeout(async () => {
    try {
      const hasReady = await hasPendingMessages(conversationId);
      if (!hasReady) return;
      await processConversationQueue(conversationId);
    } catch (error) {
      console.error('Error processing queue:', error);
    }
  }, delayMs);
}

async function buildQueuedMessage({
  message,
  waId,
  phoneNumberId,
  metaToken,
  isTakeover,
  logger,
  tenantId,
}) {
  const messageType = message.type;
  const referral = normalizeReferral(message.referral);
  let userMessage;
  let messageMetadata = {};

  if (messageType === 'text') {
    userMessage = message.text?.body || '';
  } else if (messageType === 'audio') {
    const mediaId = message.audio?.id;
    logger.info('webhook.audio.transcribe.start', { media_id: mediaId || null });
    messageMetadata = {
      media_type: 'audio',
      wa_media_id: mediaId || null,
      mime_type: message.audio?.mime_type || null,
    };

    try {
      userMessage = await transcribeWhatsAppAudio(mediaId, metaToken, { tenantId });
      if (!userMessage) {
        if (!isTakeover) {
          await sendMessage(waId, "Sorry, I couldn't understand the voice message. Could you please type your message?", phoneNumberId);
        }
        return { skip: true, referral };
      }
    } catch (err) {
      logger.error('webhook.audio.transcribe.failed', {
        media_id: mediaId || null,
        error: err.message,
      });
      if (!isTakeover) {
        await sendMessage(waId, 'Sorry, I had trouble processing the voice message. Could you please type your message?', phoneNumberId);
      }
      return { skip: true, referral };
    }
  } else if (messageType === 'image') {
    const mediaId = message.image?.id;
    const mimeType = message.image?.mime_type || 'image/jpeg';
    const caption = message.image?.caption?.trim() || '';
    const filename = buildMediaFilename('image', mimeType, mediaId);

    userMessage = buildInboundMediaPlaceholder({
      type: 'image',
      filename,
      caption,
    });
    messageMetadata = {
      media_type: 'image',
      wa_media_id: mediaId,
      mime_type: mimeType,
      filename,
      caption,
      media_url: buildWhatsAppMediaProxyUrl(mediaId),
    };
  } else {
    logger.warn('webhook.message.unsupported', { message_type: messageType });
    if (!isTakeover) {
      await sendMessage(waId, 'I can only process text, image, and voice messages.', phoneNumberId);
    }
    return { skip: true, referral };
  }

  if (referral) {
    messageMetadata.referral = referral;
  }

  return {
    skip: false,
    referral,
    userMessage,
    messageType,
    metadata: messageMetadata,
  };
}

/**
 * POST /api/webhook - Receive incoming WhatsApp messages
 * Messages are queued for aggregated processing
 *
 * 必须先读 raw body 做 HMAC 校验（Node Request body 只能消费一次，所以是
 * text → 校验 → JSON.parse 这个顺序，不能用 request.json()）。
 */
export async function POST(request) {
  const receivedAt = new Date();
  const traceId = generateTraceId('wa');
  const logger = createTraceLogger({
    component: 'webhook',
    trace_id: traceId,
  });

  // 1) raw body
  let rawBody;
  try {
    rawBody = await request.text();
  } catch (err) {
    logger.error('webhook.body_read_failed', { error: err.message });
    return new Response('Bad Request', { status: 400 });
  }

  // 2) HMAC 签名校验 —— 配置 / header / 签名任一不对都 401
  const signatureHeader = request.headers.get('x-hub-signature-256');
  if (!verifyMetaSignature(rawBody, signatureHeader)) {
    logger.warn('webhook.signature.invalid', {
      has_header: Boolean(signatureHeader),
      app_secret_configured: Boolean(config.meta.appSecret),
    });
    return new Response('Unauthorized', { status: 401 });
  }

  // 3) parse JSON 一次，校验通过后再解析
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    logger.error('webhook.body_parse_failed', { error: err.message });
    return new Response('Bad Request', { status: 400 });
  }

  // 4) 立刻 200，剩下的异步跑
  const responsePromise = NextResponse.json({ status: 'ok' }, { status: 200 });

  (async () => {
    try {

      // Observability-only raw payload archive. Fire-and-forget — never gates
      // the message-processing path; failures are logged but swallowed.
      dumpWebhookPayload({ receivedAt, payload: body }).catch((err) => {
        logger.warn('webhook.dump.failed', { error: err.message });
      });

      // Check if this is a message notification
      if (!body.entry || !body.entry[0].changes || !body.entry[0].changes[0].value.messages) {
        logger.info('webhook.ignored.non_message_notification');
        return;
      }

      const change = body.entry[0].changes[0].value;
      const inboundMessages = Array.isArray(change.messages) ? change.messages : [];
      if (inboundMessages.length === 0) {
        logger.info('webhook.ignored.no_messages');
        return;
      }

      // Extract message details
      const waId = inboundMessages[0].from;
      const webhookContact = change.contacts?.[0];
      const profileName = webhookContact?.profile?.name?.trim() || null;
      const bsuid = webhookContact?.user_id || null;       // BSUID — always present once rolled out
      const waUsername = webhookContact?.username || null;  // WhatsApp username (optional)
      const phoneNumberId = change.metadata?.phone_number_id || null;

      // 按 phoneNumberId 反查 tenant —— 单一路径：meta_phone_numbers。找不到
      // 说明该号码所属 tenant 还没接 Meta BM，webhook 直接返 200 跳过（Meta
      // 不重投，对方需先在 /settings/meta-connection 完成接入）。
      const tenantId = await resolveTenantByPhoneNumberId(phoneNumberId);
      if (!tenantId) {
        logger.warn('webhook.unknown_phone_number', { phone_number_id: phoneNumberId });
        return;
      }

      // 该 tenant 的 system token —— 媒体下载、模板回复等都走这条
      const metaToken = await resolveMetaTokenForTenant(tenantId);
      if (!metaToken) {
        logger.warn('webhook.tenant_no_token', { tenant_id: tenantId, phone_number_id: phoneNumberId });
        return;
      }

      // Onboarding：第一次收到客户消息（per-tenant）
      markFirstMessageReceived(tenantId).catch(err =>
        console.warn('[webhook] markFirstMessageReceived failed:', err.message));

      // Get the minimum context needed
      const context = await getOrCreateRoutedConversationContext({ tenantId, waId, profileName, phoneNumberId, bsuid, username: waUsername });
      const scopedLogger = logger.child({
        wa_id: waId,
        contact_id: context.contact_id,
        conversation_id: context.conversation_id,
        phone_number_id: phoneNumberId || null,
        inbound_count: inboundMessages.length,
      });
      scopedLogger.info('webhook.ingest.received', {
        routing_mode: context.routing_mode,
      });

      // Check takeover status for auto-reply suppression
      const isTakeover = await isHumanTakeover(context.conversation_id);
      let contactMetadata = context._contact?.metadata || {};
      let shouldUpdateContactMetadata = false;
      let queuedCount = 0;

      // 单一窗口 per POST：所有消息共享同一 deadline + 同一个 setTimeout，
      // 与 acquire_queue_messages "ANY 成熟则锁全部 pending" 的语义自然吻合。
      // processAfter 在循环前算一次,避免每条 enqueue 重新算 Date.now() 漂移。
      const aggregationWindowMs = pickAggregationWindowMs();
      const aggregationDeadline = new Date(Date.now() + aggregationWindowMs);

      for (const message of inboundMessages) {
        await markAsRead(message.id, phoneNumberId);

        const queuedMessage = await buildQueuedMessage({
          message,
          waId,
          phoneNumberId,
          metaToken,
          isTakeover,
          tenantId,
          logger: scopedLogger.child({ wa_message_id: message.id, message_type: message.type }),
        });

        if (queuedMessage.referral) {
          contactMetadata = mergeContactReferralMetadata(contactMetadata, queuedMessage.referral);
          shouldUpdateContactMetadata = true;
        }

        if (queuedMessage.skip) {
          continue;
        }

        const queuedMsg = await enqueueMessage({
          conversationId: context.conversation_id,
          contactId: context.contact_id,
          waId,
          content: queuedMessage.userMessage,
          messageType: queuedMessage.messageType,
          metadata: {
            ...queuedMessage.metadata,
            trace_id: traceId,
          },
          waMessageId: message.id,
          processAfter: aggregationDeadline,
        });

        // Meta 重投同一 wa_message_id 时 enqueueMessage 返回带 _duplicate
        // 的现有行，绝不重置其状态。dup 不计入 queuedCount —— 避免给已经
        // 处理完 / 处理中的会话再起一个 setTimeout。
        if (queuedMsg._duplicate) {
          scopedLogger.info('webhook.message.duplicate', {
            queue_id: queuedMsg.id,
            wa_message_id: message.id,
            existing_status: queuedMsg.status,
          });
          continue;
        }

        queuedCount += 1;
        scopedLogger.info('webhook.message.queued', {
          queue_id: queuedMsg.id,
          wa_message_id: message.id,
          message_type: queuedMessage.messageType,
          has_referral: Boolean(queuedMessage.referral),
          process_after: queuedMsg.process_after,
        });
      }

      if (shouldUpdateContactMetadata) {
        await updateContactMetadata(context.contact_id, contactMetadata);
        scopedLogger.info('webhook.contact_referral.updated', {
          has_first_referral: Boolean(contactMetadata.first_referral),
          has_last_referral: Boolean(contactMetadata.last_referral),
          last_referral_ad_id: contactMetadata.last_referral?.ad_id || null,
        });

        // 客户带着新 referral 进来 → 视作新意图，解除 FAQ_END 静默（如果之前
        // 被 mute 过）。clearFaqEnded 自带 WHERE faq_ended_at IS NOT NULL，
        // 无 set 时是 no-op。失败不阻断主流程。
        clearFaqEnded(context.conversation_id).catch(err =>
          scopedLogger.warn('webhook.faq_ended.clear_failed', { error: err.message }));
      }

      if (queuedCount > 0) {
        // setTimeout 延迟用绝对 deadline 反推，确保 acquire 触发时刻 = 行的
        // process_after 时刻，跟循环耗时无关。
        const delayMs = Math.max(0, aggregationDeadline.getTime() - Date.now());
        scheduleProcessing(context.conversation_id, delayMs);
        scopedLogger.info('webhook.processing.scheduled', {
          queued_count: queuedCount,
          aggregation_window_ms: aggregationWindowMs,
          actual_delay_ms: delayMs,
        });
      }

    } catch (error) {
      logger.error('webhook.ingest.failed', {
        error: error.message,
      });
    }
  })();

  return responsePromise;
}
