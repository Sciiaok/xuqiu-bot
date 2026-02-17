/**
 * Queue Processor - Aggregates and processes queued messages
 * Handles rapid message sequences by combining them into a single Claude call
 */

import {
  acquirePendingMessages,
  markAsCompleted,
  markAsFailed,
} from './repositories/queue.repository.js';
import { getSession, processMessage, updateSessionStage } from './session.js';
import { getResponse } from '../src/claude.service.js';
import {
  shouldAdvanceStage,
  getStageGuidance,
  hasReachedGlobalMaxTurns,
  getGlobalMaxTurns,
} from '../src/state-machine.js';
import { getScoreBreakdown } from '../src/lead-scorer.js';
import { executeConversationRouting } from '../src/routing.service.js';
import { sendMessage } from '../src/whatsapp.service.js';

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
    console.log(`No pending messages for conversation ${conversationId} (possibly handled by another instance)`);
    return { processed: false, reason: 'no_messages' };
  }

  const waId = messages[0].wa_id;
  const messageIds = messages.map((m) => m.id);
  console.log(`\n--- Processing ${messages.length} aggregated message(s) for ${waId} ---`);

  try {
    // 2. Aggregate message content (newline-separated)
    const aggregatedContent = messages.map((m) => m.content).join('\n');
    console.log(`Aggregated content: "${aggregatedContent}"`);

    // 3. Get session (includes full conversation history)
    const session = await getSession(waId);

    // 4. Get stage guidance for Claude
    const stageInfo = getStageGuidance(session.stage, session.lead_data);

    // 5. Single Claude call to process all aggregated messages
    const claudeResponse = await getResponse(
      session.messages,
      aggregatedContent,
      stageInfo,
      session.score
    );

    // 6. Process message and update all data (handles multi-lead internally)
    const updatedSession = await processMessage(waId, aggregatedContent, claudeResponse);

    // Log multi-lead info
    const leadsCount = (claudeResponse.leads || []).length;
    if (leadsCount > 1) {
      console.log(`  Multi-lead: ${leadsCount} leads extracted`);
      claudeResponse.leads.forEach((lead, i) => {
        console.log(`    Lead ${i + 1}: ${lead.car_model || '?'} → ${lead.destination_country || '?'}`);
      });
    }
    console.log(`  Primary lead data:`, updatedSession.lead_data);

    // 7. Check if stage should advance
    const advancement = shouldAdvanceStage(updatedSession);
    if (advancement.shouldAdvance && advancement.nextStage) {
      console.log(`Stage advancing: ${updatedSession.stage} -> ${advancement.nextStage} (${advancement.reason})`);
      await updateSessionStage(waId, advancement.nextStage);
    }

    // 8. Log scoring info
    console.log(`Stage: ${updatedSession.stage}, Score Δ: ${claudeResponse.score_delta}, Total: ${updatedSession.score}`);
    if (claudeResponse.reasons && claudeResponse.reasons.length > 0) {
      console.log(`Reasons: ${claudeResponse.reasons.join(', ')}`);
    }
    if (claudeResponse.risk_flags && claudeResponse.risk_flags.length > 0) {
      console.log(`Risk Flags: ${claudeResponse.risk_flags.join(', ')}`);
    }

    // Show score breakdown
    const breakdown = getScoreBreakdown(updatedSession.lead_data, updatedSession.risk_flags);
    console.log(`Score Breakdown: Identity=${breakdown.breakdown.identity_trust}, Transaction=${breakdown.breakdown.transaction_intent}, Clarity=${breakdown.breakdown.requirement_clarity}, Risk=${breakdown.breakdown.risk_deductions}`);

    console.log(`Route: ${claudeResponse.route}`);

    // 9. Send single response to user
    await sendMessage(waId, claudeResponse.next_message);
    console.log(`Assistant: ${claudeResponse.next_message}`);

    // 10. Check global max turns - force FAQ_END if exceeded
    let finalRoute = claudeResponse.route;
    if (hasReachedGlobalMaxTurns(updatedSession)) {
      console.log(`Global max turns (${getGlobalMaxTurns()}) reached - routing to FAQ_END`);
      finalRoute = 'FAQ_END';
    }

    // 11. Handle routing for all active leads in conversation
    if (finalRoute !== 'CONTINUE') {
      console.log(`\nExecuting routing: ${finalRoute}`);
      const routingResult = await executeConversationRouting(
        finalRoute,
        updatedSession.conversation_id,
        waId,
        claudeResponse.handoff_summary
      );

      if (routingResult.success) {
        console.log(`Routing completed: ${routingResult.leadsRouted || 1} lead(s) routed`);
      } else {
        console.log(`Routing failed: ${routingResult.reason || 'unknown'}`);
      }
    }

    // 12. Mark queue messages as completed
    await markAsCompleted(messageIds);
    console.log('---\n');

    return {
      processed: true,
      messageCount: messages.length,
      aggregatedContent,
      response: claudeResponse.next_message,
    };
  } catch (error) {
    console.error(`Error processing queue for ${waId}:`, error);

    // Mark as failed for retry
    await markAsFailed(messageIds, error.message);

    return {
      processed: false,
      error: error.message,
      messageCount: messages.length,
    };
  }
}
