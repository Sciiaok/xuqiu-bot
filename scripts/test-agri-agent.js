/**
 * Test script for Agricultural Machinery Agent
 * Simulates 1, 2, 5, 10 turn conversations and verifies:
 * 1. Claude returns valid rfq_items + customer_profile
 * 2. normalizeAgentResponse maps to standard leads format
 * 3. All fields land in correct DB columns / details JSONB
 *
 * Usage: node --env-file=.env.local scripts/test-agri-agent.js
 */

import { getResponse } from '../src/claude.service.js';
import { AGRI_SYSTEM_PROMPT, AGRI_JSON_SCHEMA } from './seed-agri-machinery-agent.js';

const agentConfig = {
  system_prompt: AGRI_SYSTEM_PROMPT,
  output_schema: AGRI_JSON_SCHEMA,
};

// ═══ Test Scenarios ═══

const scenarios = [
  {
    name: '1-turn: vague first message',
    messages: [
      { role: 'user', content: 'Hi, I am looking for tractors' },
    ],
  },
  {
    name: '2-turn: product + destination',
    messages: [
      { role: 'user', content: 'Hello, I need tractors for my business' },
      { role: 'assistant', content: 'Hi friend! What horsepower and how many units do you need? Which country?' },
      { role: 'user', content: 'I need 20 units of 90HP 4WD tractors to ship to Nigeria, Lagos port' },
    ],
  },
  {
    name: '5-turn: full RFQ qualification',
    messages: [
      { role: 'user', content: 'Hi, we are interested in Chinese agricultural machinery' },
      { role: 'assistant', content: 'Hi friend! What type of machinery are you looking for? Tractors, harvesters, or other equipment?' },
      { role: 'user', content: 'We need tractors and also rice harvesters' },
      { role: 'assistant', content: 'Great! What specs do you need? And which country are you shipping to?' },
      { role: 'user', content: 'Tractors 90HP 4WD with cabin, about 30 units. Harvesters for paddy rice, 10 units. All going to Tanzania, Dar es Salaam port' },
      { role: 'assistant', content: 'Good order, friend! Do you prefer FOB or CIF terms? And what is your company name?' },
      { role: 'user', content: 'CIF please. Our company is AgriTech Tanzania Ltd, we are a dealer' },
      { role: 'assistant', content: 'Thanks dear! Have you imported machinery from China before?' },
      { role: 'user', content: 'Yes we bought 10 YTO tractors last year, quality was acceptable but we want better specs now' },
    ],
  },
  {
    name: '10-turn: full qualification + background + multi-product',
    messages: [
      { role: 'user', content: 'Hello, I found your company on Alibaba' },
      { role: 'assistant', content: 'Welcome friend! How can I help you today?' },
      { role: 'user', content: 'We are looking for farming equipment supplier from China' },
      { role: 'assistant', content: 'Great! What type of equipment do you need? And which country are you based in?' },
      { role: 'user', content: 'I am in Kenya. We need tractors mainly, maybe also some implements' },
      { role: 'assistant', content: 'Nice! What horsepower range for the tractors? And how many units?' },
      { role: 'user', content: 'We need 50HP and 90HP models. About 15 units of 50HP and 25 units of 90HP, all 4WD' },
      { role: 'assistant', content: 'That is a good volume, friend! Do you also need implements like plows or harrows?' },
      { role: 'user', content: 'Yes, we need disc plows and rotavators to match the tractors. 40 disc plows and 20 rotavators' },
      { role: 'assistant', content: 'Great! What trade terms do you prefer? FOB or CIF to Mombasa?' },
      { role: 'user', content: 'CIF Mombasa. We need delivery by August 2026' },
      { role: 'assistant', content: 'Noted, friend! What is your company name and what type of business do you run?' },
      { role: 'user', content: 'We are Greenfields Equipment Ltd. We are the largest tractor dealer in Western Kenya, 12 branches' },
      { role: 'assistant', content: 'Impressive! Have you imported from China before? What brands do you currently sell?' },
      { role: 'user', content: 'We currently sell Massey Ferguson and New Holland. We imported Lovol tractors from China 2 years ago, about 30 units. The quality was good but spare parts supply was slow' },
      { role: 'assistant', content: 'Thank you for sharing! We can ensure better parts support. Any certification requirements?' },
      { role: 'user', content: 'We need KEBS certification for Kenya market. Also all tractors must have ROPS. Can you handle that?' },
      { role: 'assistant', content: 'Yes we can arrange KEBS certification. Let me prepare a quotation for you.' },
      { role: 'user', content: 'Great, please also include pricing for spare parts packages. We want to stock common wear parts' },
    ],
  },
];

// ═══ Runner ═══

const DB_COLUMNS = [
  'brand', 'car_model', 'destination_country', 'destination_port',
  'loading_port', 'color_quantity', 'qty_bucket', 'incoterm',
  'timeline', 'company_name', 'buyer_type', 'product_name',
  'sku_description', 'details',
];

function printLeadMapping(lead, index) {
  console.log(`\n    --- Lead ${index + 1} → DB Column Mapping ---`);
  for (const col of DB_COLUMNS) {
    const val = lead[col];
    if (val === undefined || val === '' || val === null) continue;
    if (col === 'details') {
      console.log(`    ${col.padEnd(22)} = ${JSON.stringify(val, null, 6).split('\n').join('\n' + ' '.repeat(27))}`);
    } else if (Array.isArray(val)) {
      console.log(`    ${col.padEnd(22)} = ${JSON.stringify(val)}`);
    } else {
      console.log(`    ${col.padEnd(22)} = ${val}`);
    }
  }
}

async function runScenario(scenario) {
  const turns = Math.ceil(scenario.messages.filter(m => m.role === 'user').length);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SCENARIO: ${scenario.name} (${turns} user turn${turns > 1 ? 's' : ''})`);
  console.log(`${'═'.repeat(70)}`);

  // Split: history = all but last user message, userMessage = last user message
  const lastUserIdx = scenario.messages.length - 1;
  const history = scenario.messages.slice(0, lastUserIdx);
  const userMessage = scenario.messages[lastUserIdx].content;

  console.log(`\n  Latest user message: "${userMessage}"`);

  const contextInfo = { missing_fields: [] };

  try {
    const result = await getResponse(history, userMessage, contextInfo, agentConfig);

    // Top-level fields
    console.log('\n  ┌─ Response Summary ─────────────────────────');
    console.log(`  │ intent:          ${JSON.stringify(result.conversation_intent)}`);
    console.log(`  │ intent_summary:  ${result.conversation_intent_summary}`);
    console.log(`  │ inquiry_quality: ${result.inquiry_quality}`);
    console.log(`  │ business_value:  ${result.business_value}`);
    console.log(`  │ route:           ${result.route}`);
    console.log(`  │ next_message:    ${result.next_message}`);
    if (result.handoff_summary) {
      console.log(`  │ handoff_summary: ${result.handoff_summary}`);
    }
    console.log(`  └──────────────────────────────────────────────`);

    // Verify normalization happened
    if (result.rfq_items !== undefined) {
      console.log('\n  ⚠️  FAIL: rfq_items still present — normalization did NOT run!');
    }
    if (result.customer_profile !== undefined) {
      console.log('\n  ⚠️  FAIL: customer_profile still present — normalization did NOT run!');
    }

    // Leads (normalized from rfq_items)
    const leads = result.leads || [];
    console.log(`\n  Leads count: ${leads.length}`);

    if (leads.length === 0) {
      console.log('  (no leads — expected for initial greeting)');
    }

    for (let i = 0; i < leads.length; i++) {
      printLeadMapping(leads[i], i);
    }

    // Validate critical mappings
    console.log('\n  ┌─ Validation Checks ─────────────────────────');
    for (const lead of leads) {
      const hasCarModel = !!lead.car_model;
      const hasProductName = !!lead.product_name;
      const passFilter = hasCarModel || hasProductName;
      console.log(`  │ session.js:165 filter (car_model||product_name): ${passFilter ? '✓ PASS' : '✗ FAIL'}`);
      console.log(`  │   car_model="${lead.car_model || ''}" product_name="${lead.product_name || ''}"`);

      const hasCompanyName = !!lead.company_name;
      console.log(`  │ company_name extraction: ${hasCompanyName ? `✓ "${lead.company_name}"` : '○ not yet collected'}`);

      const hasDetails = lead.details && Object.keys(lead.details).length > 0;
      console.log(`  │ details JSONB preserved: ${hasDetails ? '✓ PASS' : '✗ FAIL'}`);

      if (lead.details?.customer_profile) {
        const cp = lead.details.customer_profile;
        const cpFields = Object.keys(cp);
        console.log(`  │ customer_profile fields: ${cpFields.join(', ')}`);
      }
    }
    console.log(`  └──────────────────────────────────────────────`);

    return { success: true };
  } catch (err) {
    console.error(`\n  ✗ ERROR: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function main() {
  console.log('Agricultural Machinery Agent — Integration Test');
  console.log(`Model: ${process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push({ name: scenario.name, ...result });
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  SUMMARY');
  console.log(`${'═'.repeat(70)}`);
  for (const r of results) {
    console.log(`  ${r.success ? '✓' : '✗'} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }
}

main();
