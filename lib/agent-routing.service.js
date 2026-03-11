import { getMessagesForClaude } from './repositories/message.repository.js';
import { findConversationById, linkConversationToAgent } from './repositories/conversation.repository.js';
import { findContactById } from './repositories/contact.repository.js';
import {
  findAgentById,
  getAllAgents,
} from './repositories/agent.repository.js';
import { routeConversationWithClaudeToolUse } from '../src/agent-router.service.js';
import { buildRuntimeAgentConfig } from '../src/agent-runtime.service.js';
import { getReferralAdId } from './referral-context.js';
import { createTraceLogger } from './core-trace.js';

export async function resolveAgentForConversation({
  conversationId,
  latestUserMessage,
  traceContext = {},
}) {
  const logger = createTraceLogger({
    component: 'agent_routing',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId || conversationId,
    wa_id: traceContext.waId,
  });
  const conversation = await findConversationById(conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  if (conversation.agent_id) {
    const existingAgent = await findAgentById(conversation.agent_id);
    logger.info('agent_routing.reuse_existing_agent', {
      agent_id: existingAgent?.id || null,
    });
    return {
      agent: buildRuntimeAgentConfig(existingAgent),
      routingDecision: null,
      usedRouter: false,
    };
  }

  const activeAgents = await getAllAgents(true);
  const candidateAgents = activeAgents;

  if (candidateAgents.length === 0) {
    logger.warn('agent_routing.no_candidate_agents');
    return {
      agent: null,
      routingDecision: null,
      usedRouter: false,
    };
  }

  const conversationHistory = await getMessagesForClaude(conversationId);
  const contact = await findContactById(conversation.contact_id);
  const lastReferral = contact?.metadata?.last_referral || null;
  logger.info('agent_routing.invoke_router', {
    candidate_count: candidateAgents.length,
    has_referral: Boolean(lastReferral),
    referral_ad_id: getReferralAdId(lastReferral),
  });
  const routingDecision = await routeConversationWithClaudeToolUse({
    conversationHistory,
    userMessage: latestUserMessage,
    candidateAgents,
    routingContext: {
      contactReferral: lastReferral,
      adId: getReferralAdId(lastReferral),
    },
    traceContext,
  });

  if (routingDecision.needsClarification) {
    logger.info('agent_routing.needs_clarification', {
      reason: routingDecision.reason || null,
    });
    return {
      agent: null,
      routingDecision,
      usedRouter: true,
    };
  }

  const selectedAgent = candidateAgents.find((agent) => agent.id === routingDecision.agentId);
  if (!selectedAgent) {
    throw new Error(`Selected agent not found: ${routingDecision.agentId}`);
  }

  await linkConversationToAgent(conversationId, selectedAgent.id);
  logger.info('agent_routing.agent_linked', {
    selected_agent_id: selectedAgent.id,
    confidence: routingDecision.confidence || null,
  });

  return {
    agent: buildRuntimeAgentConfig(selectedAgent),
    routingDecision,
    usedRouter: true,
  };
}

export function buildRoutingClarificationResponse(routingDecision) {
  const clarificationMessage = routingDecision?.clarificationMessage?.trim()
    || 'Friend, are you asking about vehicles, auto parts, or agricultural machinery?';

  return {
    conversation_intent: ['business_inquiry'],
    conversation_intent_summary: `Shared inbox clarification required. ${routingDecision?.reason || ''}`.trim(),
    inquiry_quality: 'GOOD',
    business_value: 'LOW',
    leads: [],
    route: 'CONTINUE',
    next_message: clarificationMessage,
    handoff_summary: '',
  };
}
