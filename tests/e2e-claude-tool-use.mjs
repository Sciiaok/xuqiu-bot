/**
 * E2E test: Claude tool_use integration with product knowledge
 * Tests both product-knowledge scenarios and existing inquiry scenarios.
 *
 * Run: JAVA_HOME=$(/usr/libexec/java_home -v 21) node tests/e2e-claude-tool-use.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

const AGRI_AGENT_ID = 'b5280fed-d8e7-48d8-9a18-7f610c6aee65';

// ─── Setup: upload test product data ────────────────────────────────
async function setup() {
  console.log('=== Setup: inserting test product data ===\n');
  const pdfBuffer = readFileSync('/Users/chenyinyi/Downloads/2004E.pdf');
  const { processPdfDocument } = await import('../src/product-knowledge.service.js');

  const { data: doc } = await supabase
    .from('product_documents')
    .insert({
      agent_id: AGRI_AGENT_ID,
      filename: '2004E.pdf',
      storage_path: 'agri_machinery/test_2004E.pdf',
      status: 'pending',
    })
    .select('id')
    .single();

  await processPdfDocument(pdfBuffer, doc.id, AGRI_AGENT_ID, 'agri_machinery');
  console.log(`   Document ${doc.id} processed.\n`);
  return doc.id;
}

// ─── Teardown ───────────────────────────────────────────────────────
async function teardown(docId) {
  console.log('\n=== Teardown: cleaning up test data ===');
  await supabase.from('product_documents').delete().eq('id', docId);
  console.log('   Done.\n');
}

// ─── Load agent config ──────────────────────────────────────────────
async function getAgentConfig() {
  const { data } = await supabase
    .from('agents')
    .select('*')
    .eq('id', AGRI_AGENT_ID)
    .single();
  return data;
}

// ─── Test cases ─────────────────────────────────────────────────────
const TEST_CASES = [
  // === Group A: Should trigger product knowledge tools ===
  {
    name: 'A1: Ask about specific model specs',
    message: 'What is the horsepower of DF2004E?',
    history: [],
    expect: {
      should_have_product_info: true,
      next_message_contains: ['147', '162', 'DF2004E'],  // any of these
      route: null, // don't assert
    },
  },
  {
    name: 'A2: Ask for tractor recommendation by power',
    message: 'Do you have any tractor above 100 horsepower?',
    history: [],
    expect: {
      should_have_product_info: true,
      next_message_contains: ['DF2004E', '147', '200'],  // should mention the product
      route: null,
    },
  },
  {
    name: 'A3: Ask about fuel tank capacity',
    message: 'How big is the fuel tank on your tractors?',
    history: [],
    expect: {
      should_have_product_info: true,
      next_message_contains: ['400'],  // 400L
      route: null,
    },
  },

  // === Group B: Normal inquiries (should NOT break existing behavior) ===
  {
    name: 'B1: Simple greeting',
    message: 'Hi',
    history: [],
    expect: {
      inquiry_quality: ['BAD', 'GOOD'],  // either is acceptable
      route: ['CONTINUE', 'FAQ_END'],
      should_have_product_info: false,
    },
  },
  {
    name: 'B2: Basic tractor inquiry (real user pattern)',
    message: 'I want tractor',
    history: [],
    expect: {
      conversation_intent_includes: 'business_inquiry',
      inquiry_quality: ['GOOD'],
      route: ['CONTINUE'],
    },
  },
  {
    name: 'B3: Tractor with specs and destination (qualifying inquiry)',
    message: '90hp tractor with cabin, 2 units to Ghana',
    history: [],
    expect: {
      conversation_intent_includes: 'business_inquiry',
      inquiry_quality: ['GOOD', 'QUALIFY', 'PROOF'],  // agri agent needs specific model+specs for QUALIFY
      route: ['CONTINUE', 'HUMAN_NOW'],
    },
  },
  {
    name: 'B4: Spam / begging (real pattern)',
    message: 'i don\'t want a car but i need money to live on?',
    history: [],
    expect: {
      conversation_intent_includes: 'other',
      inquiry_quality: ['BAD'],
      route: ['FAQ_END'],
    },
  },
];

// ─── Runner ─────────────────────────────────────────────────────────
async function runTest(testCase, agentConfig) {
  const { getResponse } = await import('../src/claude.service.js');

  console.log(`\n--- ${testCase.name} ---`);
  console.log(`   User: "${testCase.message}"`);

  const contextInfo = {};
  const result = await getResponse(
    testCase.history,
    testCase.message,
    contextInfo,
    agentConfig,
    { traceId: 'test', conversationId: 'test', waId: 'test' }
  );

  console.log(`   Intent: ${result.conversation_intent}`);
  console.log(`   Quality: ${result.inquiry_quality}, Value: ${result.business_value}`);
  console.log(`   Route: ${result.route}`);
  console.log(`   Message: "${result.next_message}"`);

  // Assertions
  const errors = [];

  if (testCase.expect.conversation_intent_includes) {
    const intents = Array.isArray(result.conversation_intent)
      ? result.conversation_intent
      : [result.conversation_intent];
    if (!intents.some(i => i.includes(testCase.expect.conversation_intent_includes))) {
      errors.push(`Expected intent to include "${testCase.expect.conversation_intent_includes}", got ${JSON.stringify(intents)}`);
    }
  }

  if (testCase.expect.inquiry_quality) {
    if (!testCase.expect.inquiry_quality.includes(result.inquiry_quality)) {
      errors.push(`Expected quality in ${JSON.stringify(testCase.expect.inquiry_quality)}, got "${result.inquiry_quality}"`);
    }
  }

  if (testCase.expect.route) {
    if (!testCase.expect.route.includes(result.route)) {
      errors.push(`Expected route in ${JSON.stringify(testCase.expect.route)}, got "${result.route}"`);
    }
  }

  if (testCase.expect.next_message_contains) {
    const msg = (result.next_message || '').toLowerCase();
    const hasAny = testCase.expect.next_message_contains.some(s => msg.includes(s.toLowerCase()));
    if (!hasAny) {
      errors.push(`Expected message to contain any of ${JSON.stringify(testCase.expect.next_message_contains)}, got "${result.next_message}"`);
    }
  }

  if (errors.length > 0) {
    console.log(`   FAIL:`);
    errors.forEach(e => console.log(`     - ${e}`));
    return { name: testCase.name, pass: false, errors };
  }

  console.log(`   PASS`);
  return { name: testCase.name, pass: true };
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log('=== Claude Tool Use E2E Test ===\n');

  const docId = await setup();
  const agentConfig = await getAgentConfig();

  const results = [];
  for (const tc of TEST_CASES) {
    try {
      const r = await runTest(tc, agentConfig);
      results.push(r);
    } catch (err) {
      console.log(`   ERROR: ${err.message}`);
      results.push({ name: tc.name, pass: false, errors: [err.message] });
    }
  }

  await teardown(docId);

  // Summary
  console.log('=== RESULTS ===');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.name}`);
  }
  console.log(`\n${passed}/${results.length} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
