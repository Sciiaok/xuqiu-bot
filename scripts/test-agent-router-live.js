/**
 * Live test:
 * 1. Pull one real conversation from Supabase
 * 2. Route it via Claude tool use
 * 3. Generate one real reply with the selected agent (or clarification)
 *
 * Usage:
 *   node --env-file=.env.local scripts/test-agent-router-live.js <conversation-id>
 */

import { getMessagesByConversation } from '../lib/repositories/message.repository.js';
import { findConversationById } from '../lib/repositories/conversation.repository.js';
import { getAllAgents } from '../lib/repositories/agent.repository.js';
import { routeConversationWithClaudeToolUse } from '../src/agent-router.service.js';
import { buildRuntimeAgentConfig } from '../src/agent-runtime.service.js';
import { getResponse } from '../src/claude.service.js';

function usage() {
  console.error('Usage: node --env-file=.env.local scripts/test-agent-router-live.js <conversation-id> [--all-active-agents] [--expect <product_line>]');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const conversationId = args[0];
  if (!conversationId) usage();
  const useAllActiveAgents = args.includes('--all-active-agents');
  const expectIndex = args.indexOf('--expect');
  const expectedProductLine = expectIndex >= 0 ? args[expectIndex + 1] : null;

  const conversation = await findConversationById(conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  const messages = await getMessagesByConversation(conversationId, 50);
  if (!messages.length) {
    throw new Error(`No messages found for conversation: ${conversationId}`);
  }

  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!latestUserMessage) {
    throw new Error(`No user messages found for conversation: ${conversationId}`);
  }
  const history = messages
    .filter((message) => message.id !== latestUserMessage.id)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  const activeAgents = await getAllAgents(true);
  const candidateAgents = activeAgents;
  if (!candidateAgents.length) {
    throw new Error('No active agents found.');
  }

  console.log(`Conversation: ${conversationId}`);
  console.log(`Messages loaded: ${messages.length}`);
  console.log(`Latest user message: ${latestUserMessage.content}`);

  const routingDecision = await routeConversationWithClaudeToolUse({
    conversationHistory: history,
    userMessage: latestUserMessage.content,
    candidateAgents,
  });

  const selectedAgent = candidateAgents.find((agent) => agent.id === routingDecision.agentId);
  if (!selectedAgent) {
    throw new Error(`Selected agent not found in candidates: ${routingDecision.agentId}`);
  }

  console.log('\nRouting decision:');
  console.log(JSON.stringify({
    ...routingDecision,
    selected_product_line: selectedAgent.product_line,
    expected_product_line: expectedProductLine,
    match: expectedProductLine ? selectedAgent.product_line === expectedProductLine : null,
  }, null, 2));

  if (routingDecision.needsClarification) {
    console.log('\nRouter requested clarification only:');
    console.log(routingDecision.clarificationMessage);
    return;
  }

  const reply = await getResponse(
    history,
    latestUserMessage.content,
    { missing_fields: [] },
    buildRuntimeAgentConfig(selectedAgent)
  );

  console.log('\nReply payload:');
  console.log(JSON.stringify(reply, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
