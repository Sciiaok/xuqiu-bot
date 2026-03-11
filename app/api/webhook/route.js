import { NextResponse } from 'next/server';
import { config } from '../../../src/config.js';
import { sendMessage, markAsRead } from '../../../src/whatsapp.service.js';
import { transcribeWhatsAppAudio } from '../../../src/whisper.service.js';
import {
  buildInboundMediaPlaceholder,
  buildMediaFilename,
  buildWhatsAppMediaProxyUrl,
} from '../../../src/whatsapp-media.service.js';
import { getOrCreateRoutedConversationContext } from '../../../lib/conversation-context.service.js';
import { enqueueMessage } from '../../../lib/repositories/queue.repository.js';
import { isHumanTakeover } from '../../../lib/repositories/conversation.repository.js';
import { updateContactMetadata } from '../../../lib/repositories/contact.repository.js';
import {
  mergeContactReferralMetadata,
  normalizeReferral,
} from '../../../lib/referral-context.js';
import { createTraceLogger, generateTraceId } from '../../../lib/core-trace.js';

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
 * Trigger queue processing after aggregation window
 * @param {string} conversationId - Conversation UUID
 */
async function scheduleProcessing(conversationId) {
  const delay = config.queue.aggregationWindowMs;

  setTimeout(async () => {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${config.server.port}`;
      const response = await fetch(`${baseUrl}/api/webhook/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      });

      if (!response.ok) {
        console.error('Failed to trigger queue processing:', await response.text());
      }
    } catch (error) {
      console.error('Error triggering queue processing:', error);
    }
  }, delay);
}

async function buildQueuedMessage({
  message,
  waId,
  phoneNumberId,
  isTakeover,
  logger,
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
      userMessage = await transcribeWhatsAppAudio(mediaId);
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
 */
export async function POST(request) {
  // Immediately acknowledge receipt to WhatsApp
  const responsePromise = NextResponse.json({ status: 'ok' }, { status: 200 });

  // Process asynchronously after returning 200
  (async () => {
    const traceId = generateTraceId('wa');
    const logger = createTraceLogger({
      component: 'webhook',
      trace_id: traceId,
    });

    try {
      const body = await request.json();

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
      const profileName = change.contacts?.[0]?.profile?.name?.trim() || null;
      const phoneNumberId = change.metadata?.phone_number_id || null;

      // Get the minimum context needed
      const context = await getOrCreateRoutedConversationContext({ waId, profileName, phoneNumberId });
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

      for (const message of inboundMessages) {
        await markAsRead(message.id, phoneNumberId);

        const queuedMessage = await buildQueuedMessage({
          message,
          waId,
          phoneNumberId,
          isTakeover,
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
        });

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
      }

      if (queuedCount > 0) {
        scheduleProcessing(context.conversation_id);
        scopedLogger.info('webhook.processing.scheduled', {
          queued_count: queuedCount,
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
