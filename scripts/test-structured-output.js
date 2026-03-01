/**
 * Test: claude.service.js with output_config structured output
 *
 * Calls getResponse() directly and verifies:
 * 1. API call succeeds (no errors)
 * 2. Response is valid JSON matching JSON_SCHEMA
 * 3. All required fields present with correct types/enums
 */

import { getResponse, JSON_SCHEMA } from '../src/claude.service.js';

const requiredFields = JSON_SCHEMA.required;
const validIntents = JSON_SCHEMA.properties.conversation_intent.items.enum;
const validQualities = JSON_SCHEMA.properties.inquiry_quality.enum;
const validValues = JSON_SCHEMA.properties.business_value.enum;
const validRoutes = JSON_SCHEMA.properties.route.enum;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// Test 1: Business inquiry
console.log('\n=== Test 1: Business inquiry ===\n');
{
  const result = await getResponse(
    [], // empty history
    'I want 20 units BYD Seal to Dubai, FOB price please',
    { missing_fields: ['company_name', 'color_quantity'] }
  );

  console.log('Raw result:', JSON.stringify(result, null, 2));

  // Verify all required fields exist
  for (const field of requiredFields) {
    assert(field in result, `required field "${field}" present`);
  }

  // Verify enum values
  assert(
    result.conversation_intent.every(i => validIntents.includes(i)),
    `conversation_intent values valid: ${result.conversation_intent}`
  );
  assert(validQualities.includes(result.inquiry_quality), `inquiry_quality valid: ${result.inquiry_quality}`);
  assert(validValues.includes(result.business_value), `business_value valid: ${result.business_value}`);
  assert(validRoutes.includes(result.route), `route valid: ${result.route}`);

  // Verify leads structure
  assert(Array.isArray(result.leads), 'leads is array');
  if (result.leads.length > 0) {
    const lead = result.leads[0];
    assert(typeof lead.car_model === 'string', `lead has car_model: ${lead.car_model}`);
    console.log('  Lead:', JSON.stringify(lead));
  }

  assert(typeof result.next_message === 'string', 'next_message is string');
}

// Test 2: Personal consumer → FAQ_END
console.log('\n=== Test 2: Personal consumer ===\n');
{
  const result = await getResponse(
    [],
    'I want to buy one BYD Dolphin for myself, where is the nearest dealer?',
    {}
  );

  console.log('Raw result:', JSON.stringify(result, null, 2));

  assert(result.conversation_intent.includes('personal_consumer'), `detected personal_consumer intent`);
  assert(result.route === 'FAQ_END', `route is FAQ_END: ${result.route}`);
  assert(result.inquiry_quality === 'BAD', `quality is BAD: ${result.inquiry_quality}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
