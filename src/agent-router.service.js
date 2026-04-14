import { anthropic, MODELS } from './llm-client.js';
import { buildRoutingCandidate } from './agent-runtime.service.js';
import {
  formatReferralContextForPrompt,
  resolveAgentAdContext,
} from '../lib/referral-context.js';
import { createTraceLogger } from '../lib/core-trace.js';

const ROUTER_SYSTEM_PROMPT = `You are an inbox router for Revopanda.

Your job is to choose the best product-line agent for the conversation.

Rules:
1. You MUST call the select_agent tool exactly once.
2. Choose only from the provided candidates.
3. Prefer explicit product/category signals from the latest user message.
4. Use conversation history only as supporting context.
5. If the intent is ambiguous across candidates, set needs_clarification=true and provide a short WhatsApp-style clarification question.
6. Keep the reason concise and concrete.
7. Treat inbound referral context and matched_ad_context as strong routing hints when present.
`;

const SELECT_AGENT_TOOL = {
  name: 'select_agent',
  description: 'Select the best agent for this conversation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['agent_id', 'confidence', 'reason', 'needs_clarification'],
    properties: {
      agent_id: {
        type: 'string',
        description: 'The selected candidate agent id.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
      },
      reason: {
        type: 'string',
        description: 'Short explanation for the choice.',
      },
      needs_clarification: {
        type: 'boolean',
        description: 'True when the user should clarify the product line before routing.',
      },
      clarification_message: {
        type: 'string',
        description: 'Short clarification question for the customer. Empty string if not needed.',
      },
    },
  },
};

function formatConversationHistory(conversationHistory) {
  if (!conversationHistory?.length) return 'No prior conversation history.';

  return conversationHistory
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n');
}

function formatCandidates(candidateAgents, routingContext = {}) {
  const adId = routingContext?.adId || '';

  return candidateAgents
    .map((agent) => {
      const candidate = buildRoutingCandidate(agent);
      const matchedAdContext = resolveAgentAdContext(agent, adId);
      return [
        `- id: ${candidate.id}`,
        `  name: ${candidate.name}`,
        `  product_line: ${candidate.product_line}`,
        `  summary: ${candidate.summary || 'No summary provided.'}`,
        `  routing_hints: ${candidate.routing_hints || 'No extra hints.'}`,
        `  matched_ad_context: ${matchedAdContext || 'No matched ad context.'}`,
      ].join('\n');
    })
    .join('\n');
}

export async function routeConversationWithClaudeToolUse({
  conversationHistory,
  userMessage,
  candidateAgents,
  routingContext = {},
  traceContext = {},
}) {
  if (!candidateAgents?.length) {
    throw new Error('No candidate agents available for Claude routing');
  }

  const logger = createTraceLogger({
    component: 'router',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId,
    wa_id: traceContext.waId,
  });

  const allowedAgentIds = new Set(candidateAgents.map((agent) => agent.id));
  const prompt = [
    'Candidate agents:',
    formatCandidates(candidateAgents, routingContext),
    '',
    'Inbound referral context:',
    formatReferralContextForPrompt(routingContext.contactReferral),
    '',
    'Conversation history:',
    formatConversationHistory(conversationHistory),
    '',
    `Latest user message:\n${userMessage}`,
  ].join('\n');

  logger.info('router.request.started', {
    candidate_count: candidateAgents.length,
    has_referral: Boolean(routingContext.contactReferral),
    latest_user_message_preview: String(userMessage || '').slice(0, 200),
  });

  const response = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 1024,
    system: ROUTER_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    tools: [SELECT_AGENT_TOOL],
    tool_choice: {
      type: 'tool',
      name: 'select_agent',
    },
  });

  const toolUse = response.content.find(
    (block) => block.type === 'tool_use' && block.name === 'select_agent'
  );

  if (!toolUse) {
    throw new Error('Claude router did not return a select_agent tool call');
  }

  const decision = toolUse.input || {};
  if (!decision.needs_clarification && !allowedAgentIds.has(decision.agent_id)) {
    throw new Error(`Claude router selected unknown agent: ${decision.agent_id}`);
  }

  logger.info('router.request.completed', {
    selected_agent_id: decision.needs_clarification ? null : decision.agent_id,
    needs_clarification: Boolean(decision.needs_clarification),
    confidence: decision.confidence || null,
    reason: decision.reason || null,
  });

  return {
    agentId: decision.needs_clarification ? '' : decision.agent_id,
    confidence: decision.confidence || 'low',
    reason: decision.reason || '',
    needsClarification: Boolean(decision.needs_clarification),
    clarificationMessage: decision.clarification_message || '',
    rawResponseId: response.id,
  };
}
