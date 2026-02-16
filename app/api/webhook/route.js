import { NextResponse } from 'next/server';
import { config } from '../../../src/config.js';
import { getResponse } from '../../../src/claude.service.js';
import { sendMessage, markAsRead } from '../../../src/whatsapp.service.js';
import { transcribeWhatsAppAudio } from '../../../src/whisper.service.js';
import { shouldAdvanceStage, getStageGuidance, hasReachedGlobalMaxTurns, getGlobalMaxTurns } from '../../../src/state-machine.js';
import { getScoreBreakdown } from '../../../src/lead-scorer.js';
import { executeRouting } from '../../../src/routing.service.js';
import { getSession, processMessage, updateSessionStage } from '../../../lib/session.js';

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
    console.log('✓ Webhook verified successfully');
    return new Response(challenge, { status: 200 });
  } else {
    console.error('✗ Webhook verification failed');
    return new Response('Forbidden', { status: 403 });
  }
}

/**
 * POST /api/webhook - Receive incoming WhatsApp messages
 */
export async function POST(request) {
  // Quickly acknowledge receipt to WhatsApp
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

      console.log(`\n--- Incoming message from ${waId} ---`);

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

      // Get or create session from new schema
      const session = await getSession(waId);

      // Get stage guidance for Claude
      const stageInfo = getStageGuidance(session.stage, session.lead_data);

      // Call Claude API with stage context
      const claudeResponse = await getResponse(session.messages, userMessage, stageInfo, session.score);

      // Process message and update all data
      const updatedSession = await processMessage(waId, userMessage, claudeResponse);

      console.log(`  Lead data:`, updatedSession.lead_data);

      // Check if stage should advance using the updated session
      const advancement = shouldAdvanceStage(updatedSession);
      if (advancement.shouldAdvance && advancement.nextStage) {
        console.log(`📈 Stage advancing: ${updatedSession.stage} → ${advancement.nextStage} (${advancement.reason})`);
        await updateSessionStage(waId, advancement.nextStage);
      }

      // Log scoring and stage info
      console.log(`Stage: ${updatedSession.stage}, Score Δ: ${claudeResponse.score_delta}, Total: ${updatedSession.score}`);
      if (claudeResponse.reasons && claudeResponse.reasons.length > 0) {
        console.log(`Reasons: ${claudeResponse.reasons.join(', ')}`);
      }
      if (claudeResponse.risk_flags && claudeResponse.risk_flags.length > 0) {
        console.log(`⚠️  Risk Flags: ${claudeResponse.risk_flags.join(', ')}`);
      }

      // Show score breakdown
      const breakdown = getScoreBreakdown(updatedSession.lead_data, updatedSession.risk_flags);
      console.log(`Score Breakdown: Identity=${breakdown.breakdown.identity_trust}, Transaction=${breakdown.breakdown.transaction_intent}, Clarity=${breakdown.breakdown.requirement_clarity}, Risk=${breakdown.breakdown.risk_deductions}`);

      console.log(`Route: ${claudeResponse.route}`);

      // Send response to user
      await sendMessage(waId, claudeResponse.next_message);
      console.log(`Assistant: ${claudeResponse.next_message}`);

      // Check global max turns - force FAQ_END if exceeded
      let finalRoute = claudeResponse.route;
      if (hasReachedGlobalMaxTurns(updatedSession)) {
        console.log(`⚠️  Global max turns (${getGlobalMaxTurns()}) reached - routing to FAQ_END`);
        finalRoute = 'FAQ_END';
      }

      // Handle routing (async, don't block user response)
      if (finalRoute !== 'CONTINUE') {
        console.log(`\n🎯 Executing routing: ${finalRoute}`);
        const routingResult = await executeRouting(finalRoute, updatedSession, claudeResponse.handoff_summary);

        if (routingResult.success) {
          console.log(`✅ Routing completed successfully`);
        } else {
          console.log(`⚠️  Routing failed: ${routingResult.reason || 'unknown'}`);
        }
      }
      console.log('---\n');

    } catch (error) {
      console.error('Error handling webhook:', error);
    }
  })();

  return responsePromise;
}
