/**
 * Test Claude tool-use routing against real image-derived parts inquiries.
 *
 * Usage:
 *   node --env-file=.env.local scripts/test-agent-router-image-cases.js
 */

import { getAllAgents } from '../lib/repositories/agent.repository.js';
import { routeConversationWithClaudeToolUse } from '../src/agent-router.service.js';
import { buildRuntimeAgentConfig } from '../src/agent-runtime.service.js';
import { getResponse } from '../src/claude.service.js';

const cases = [
  {
    name: 'Toyota fuel pump OEM list',
    userMessage: `FUEL PUMPS FOR TOYOTA BRANDS:
(1) 23221-0D010 COROLLA 2001-2002 Electric Fuel Pumps
(2) 23221-0A030 COROLLA 2003-2005 JPP-Sedan
(3) 77020-02180 COROLLA 2006-2007 JPP-Sedan Fuel Suction Tube Assy with Pump & Gage
(4) 77020-02181 COROLLA 2008 JPP-Sedan Fuel Suction Tube Assy with Pump & Gage`,
    expectedProductLine: 'auto_parts',
  },
  {
    name: 'Honda HRV door handle from photos',
    userMessage: `I'm looking for this door handles. Honda HRV 2000 model.`,
    expectedProductLine: 'auto_parts',
  },
  {
    name: 'Nissan Murano control board',
    userMessage: `Nissan murano 2004 control board`,
    expectedProductLine: 'auto_parts',
  },
  {
    name: 'Neutral greeting only',
    userMessage: `Hi`,
    expectedProductLine: null,
    expectedClarification: true,
  },
  {
    name: 'BYD Seal vehicle quote to Dubai',
    userMessage: `Hi friend, I need quotation for 20 units BYD Seal to Dubai. Please quote CIF Jebel Ali.`,
    expectedProductLine: 'vehicle',
  },
  {
    name: 'Changan vehicle bulk order',
    userMessage: `We want to buy 12 Changan CS55 Plus cars for our dealership in Kazakhstan. Please share FOB price and delivery time.`,
    expectedProductLine: 'vehicle',
  },
  {
    name: 'GAC GS8 whole vehicle inquiry',
    userMessage: `Do you export full vehicles? I need 5 units of GAC GS8 for Nigeria market.`,
    expectedProductLine: 'vehicle',
  },
];

async function main() {
  const agents = await getAllAgents(true);
  if (!agents.length) {
    throw new Error('No active agents found');
  }

  console.log(`Active agents: ${agents.map((agent) => `${agent.product_line}(${agent.id})`).join(', ')}`);

  for (const testCase of cases) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`CASE: ${testCase.name}`);
    console.log(`${'='.repeat(80)}`);
    console.log(`User message:\n${testCase.userMessage}\n`);

    const routingDecision = await routeConversationWithClaudeToolUse({
      conversationHistory: [],
      userMessage: testCase.userMessage,
      candidateAgents: agents,
    });

    const selectedAgent = agents.find((agent) => agent.id === routingDecision.agentId);
    if (!selectedAgent) {
      throw new Error(`Selected agent missing: ${routingDecision.agentId}`);
    }

    console.log('Routing decision:');
    console.log(JSON.stringify({
      ...routingDecision,
      selected_product_line: selectedAgent.product_line,
      expected_product_line: testCase.expectedProductLine,
      expected_clarification: testCase.expectedClarification || false,
      product_match: testCase.expectedProductLine
        ? selectedAgent.product_line === testCase.expectedProductLine
        : null,
      clarification_match: testCase.expectedClarification !== undefined
        ? routingDecision.needsClarification === testCase.expectedClarification
        : null,
    }, null, 2));

    if (routingDecision.needsClarification) {
      console.log('\nClarification requested:');
      console.log(routingDecision.clarificationMessage);
      continue;
    }

    const reply = await getResponse(
      [],
      testCase.userMessage,
      { missing_fields: [] },
      buildRuntimeAgentConfig(selectedAgent)
    );

    console.log('\nReply summary:');
    console.log(JSON.stringify({
      next_message: reply.next_message,
      route: reply.route,
      inquiry_quality: reply.inquiry_quality,
      business_value: reply.business_value,
      leads: reply.leads || [],
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
