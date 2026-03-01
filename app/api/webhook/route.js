import { NextResponse } from 'next/server';
import { config } from '../../../src/config.js';
import { sendMessage, markAsRead } from '../../../src/whatsapp.service.js';
import { transcribeWhatsAppAudio } from '../../../src/whisper.service.js';
import { getOrCreateConversationContext } from '../../../lib/session.js';
import { enqueueMessage } from '../../../lib/repositories/queue.repository.js';

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

/**
 * POST /api/webhook - Receive incoming WhatsApp messages
 * Messages are queued for aggregated processing
 */
export async function POST(request) {
  // Immediately acknowledge receipt to WhatsApp
  const responsePromise = NextResponse.json({ status: 'ok' }, { status: 200 });

  // Process asynchronously after returning 200
  (async () => {
    try {
      const body = await request.json();

      // Check if this is a message notification
      if (!body.entry || !body.entry[0].changes || !body.entry[0].changes[0].value.messages) {
        console.log('Not a message notification, ignoring');
        return;
      }

      const change = body.entry[0].changes[0].value;
      const message = change.messages[0];

      // Extract message details
      const waId = message.from;
      const messageId = message.id;
      const messageType = message.type;
      const profileName = change.contacts?.[0]?.profile?.name?.trim() || null;

      console.log(`\n--- Incoming message from ${waId} (queuing) ---`);

      // Handle text and audio (voice) messages
      let userMessage;

      if (messageType === 'text') {
        userMessage = message.text.body;
      } else if (messageType === 'audio') {
        const mediaId = message.audio.id;
        console.log(`Voice message received, transcribing: ${mediaId}`);
        try {
          userMessage = await transcribeWhatsAppAudio(mediaId);
          if (!userMessage) {
            await sendMessage(waId, "Sorry, I couldn't understand the voice message. Could you please type your message?");
            return;
          }
        } catch (err) {
          console.error('Transcription error:', err);
          await sendMessage(waId, "Sorry, I had trouble processing the voice message. Could you please type your message?");
          return;
        }
      } else {
        console.log(`Unsupported message type: ${messageType}`);
        await sendMessage(waId, "I can only process text and voice messages.");
        return;
      }
      console.log(`User: ${userMessage}`);

      // Mark message as read
      await markAsRead(messageId);

      // Get the minimum context needed to queue the message and sync contact name
      const context = await getOrCreateConversationContext({ waId, profileName });

      // Enqueue message for aggregated processing
      const queuedMsg = await enqueueMessage({
        conversationId: context.conversation_id,
        contactId: context.contact_id,
        waId: waId,
        content: userMessage,
        messageType: messageType,
        waMessageId: messageId,
      });

      console.log(`Message queued: ${queuedMsg.id}, process_after: ${queuedMsg.process_after}`);

      // Schedule processing after aggregation window
      scheduleProcessing(context.conversation_id);

    } catch (error) {
      console.error('Error handling webhook:', error);
    }
  })();

  return responsePromise;
}
