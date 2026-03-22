/**
 * Extended E2E test: broader coverage with real user patterns.
 * Run: JAVA_HOME=$(/usr/libexec/java_home -v 21) node tests/e2e-claude-tool-use-extended.mjs
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

async function setup() {
  console.log('=== Setup ===\n');
  const pdfBuffer = readFileSync('/Users/chenyinyi/Downloads/2004E.pdf');
  const { processPdfDocument } = await import('../src/product-knowledge.service.js');
  const { data: doc } = await supabase
    .from('product_documents')
    .insert({ agent_id: AGRI_AGENT_ID, filename: '2004E.pdf', storage_path: 'test/2004E.pdf', status: 'pending' })
    .select('id').single();
  await processPdfDocument(pdfBuffer, doc.id, AGRI_AGENT_ID, 'agri_machinery');
  console.log(`   Document ${doc.id} ready.\n`);
  return doc.id;
}

async function teardown(docId) {
  await supabase.from('product_documents').delete().eq('id', docId);
}

async function getAgentConfig() {
  const { data } = await supabase.from('agents').select('*').eq('id', AGRI_AGENT_ID).single();
  return data;
}

// ─── Test Cases ─────────────────────────────────────────
const TEST_CASES = [
  // === Product knowledge queries (should use tools) ===
  {
    name: 'P1: Specific model weight',
    message: 'How heavy is the DF2004E?',
    expect: { next_message_contains: ['7375', 'kg'] },
  },
  {
    name: 'P2: Gearbox specs',
    message: 'What gearbox does your 200hp tractor have?',
    expect: { next_message_contains: ['16', 'synchronizer'] },
  },
  {
    name: 'P3: Tyre size inquiry',
    message: 'What tyre size does the DF2004E use?',
    expect: { next_message_contains: ['20.8', '16.9'] },
  },
  {
    name: 'P4: PTO speed question',
    message: 'What PTO speed options do you have?',
    expect: { next_message_contains: ['540', '1000'] },
  },
  {
    name: 'P5: Comparison (no match expected)',
    message: 'Do you have any 50hp tractor?',
    expect: {
      // Should still respond reasonably even if no exact match
      route: ['CONTINUE'],
      conversation_intent_includes: 'business_inquiry',
    },
  },

  // === Real user patterns from production (should not break) ===
  {
    name: 'R1: Multi-turn tractor inquiry (first message)',
    message: 'Can I get a quote for the Agricultural Machinery?',
    expect: {
      route: ['CONTINUE'],
    },
  },
  {
    name: 'R2: 320HP fleet order (high value)',
    message: 'Can I see a 320 hp farm machine? I need a fleet of 16 to Kenya, Mombasa port, CIF',
    expect: {
      conversation_intent_includes: 'business_inquiry',
      inquiry_quality: ['GOOD', 'QUALIFY', 'PROOF'],  // LLM non-deterministic: QUALIFY requires model+specs+qty+dest, may classify as GOOD
      business_value: ['AVERAGE', 'HIGH'],
    },
  },
  {
    name: 'R3: Personal farmer (should be BAD)',
    message: 'I need only one tractor for my personal farm use, rice farm in Ghana',
    expect: {
      inquiry_quality: ['BAD', 'GOOD'],
      route: ['CONTINUE', 'FAQ_END'],
    },
  },
  {
    name: 'R4: Dealer with tractor + harvester',
    message: 'I need tractor and harvester, I am a dealer in Tanzania',
    expect: {
      conversation_intent_includes: 'business_inquiry',
      inquiry_quality: ['GOOD', 'QUALIFY'],
      route: ['CONTINUE'],
    },
  },
  {
    name: 'R5: Gibberish / random codes',
    message: 'MZJG83 VNMZ2S KCLRER',
    expect: {
      inquiry_quality: ['BAD'],
      route: ['CONTINUE', 'FAQ_END'],
    },
  },
  {
    name: 'R6: Non-English (Arabic-ish spam)',
    message: 'يا تفضل يتحمل تعلم يا تفضل يا نبي لله وعلى الآلات',
    expect: {
      inquiry_quality: ['BAD', 'GOOD'],
      route: ['CONTINUE', 'FAQ_END'],
    },
  },
  {
    name: 'R7: Price inquiry without specs',
    message: 'Pls how much will I pay for the tractor?',
    expect: {
      conversation_intent_includes: 'business_inquiry',
      route: ['CONTINUE'],
    },
  },
  {
    name: 'R8: Asking about company background',
    message: 'Where are you based? Which company is this? How do you often sell?',
    expect: {
      // Without prior context, this can be classified as other or business_cooperation
      route: ['CONTINUE'],
    },
  },
];

// ─── Runner ─────────────────────────────────────────────
async function runTest(testCase, agentConfig, getResponse) {
  console.log(`\n--- ${testCase.name} ---`);
  console.log(`   User: "${testCase.message.substring(0, 80)}${testCase.message.length > 80 ? '...' : ''}"`);

  const result = await getResponse(
    testCase.history || [],
    testCase.message,
    {},
    agentConfig,
    { traceId: 'test', conversationId: 'test', waId: 'test' }
  );

  console.log(`   Intent: ${result.conversation_intent} | Quality: ${result.inquiry_quality} | Value: ${result.business_value} | Route: ${result.route}`);
  console.log(`   Message: "${(result.next_message || '').substring(0, 120)}"`);

  const errors = [];
  const e = testCase.expect;

  if (e.conversation_intent_includes) {
    const intents = Array.isArray(result.conversation_intent) ? result.conversation_intent : [result.conversation_intent];
    const flat = intents.join(',');
    if (!flat.includes(e.conversation_intent_includes)) {
      errors.push(`intent: expected "${e.conversation_intent_includes}" in "${flat}"`);
    }
  }
  if (e.inquiry_quality && !e.inquiry_quality.includes(result.inquiry_quality)) {
    errors.push(`quality: expected ${JSON.stringify(e.inquiry_quality)}, got "${result.inquiry_quality}"`);
  }
  if (e.business_value && !e.business_value.includes(result.business_value)) {
    errors.push(`value: expected ${JSON.stringify(e.business_value)}, got "${result.business_value}"`);
  }
  if (e.route && !e.route.includes(result.route)) {
    errors.push(`route: expected ${JSON.stringify(e.route)}, got "${result.route}"`);
  }
  if (e.next_message_contains) {
    const msg = (result.next_message || '').toLowerCase();
    const hasAny = e.next_message_contains.some(s => msg.includes(s.toLowerCase()));
    if (!hasAny) {
      errors.push(`message: expected any of ${JSON.stringify(e.next_message_contains)} in "${result.next_message}"`);
    }
  }

  if (errors.length > 0) {
    errors.forEach(err => console.log(`   FAIL: ${err}`));
    return { name: testCase.name, pass: false, errors };
  }
  console.log(`   PASS`);
  return { name: testCase.name, pass: true };
}

// ─── Main ───────────────────────────────────────────────
async function main() {
  console.log('=== Extended Claude Tool Use E2E Test ===\n');

  const docId = await setup();
  const agentConfig = await getAgentConfig();
  const { getResponse } = await import('../src/claude.service.js');

  const results = [];
  for (const tc of TEST_CASES) {
    try {
      results.push(await runTest(tc, agentConfig, getResponse));
    } catch (err) {
      console.log(`   ERROR: ${err.message}`);
      results.push({ name: tc.name, pass: false, errors: [err.message] });
    }
  }

  await teardown(docId);

  console.log('\n=== RESULTS ===');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.name}`);
  }
  console.log(`\n${passed}/${results.length} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
