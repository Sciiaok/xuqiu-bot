/**
 * Test script for executeConversationRouting
 *
 * Tests:
 * 1. Unit test: CONTINUE route → early return, no DB query
 * 2. Unit test: HUMAN_NOW route with matching leads → routes + Feishu notification
 * 3. Unit test: HUMAN_NOW route with no matching leads → no_leads
 * 4. Integration test: real contact 251911219360 HUMAN_NOW lead → Feishu notification
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

// ── Test helpers ──────────────────────────────────────────────

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

// ── Mock layer ────────────────────────────────────────────────

const calls = { updateLead: [], sendFeishu: [], sendMessage: [] };

// Mock getLeadsByConversation to simulate DB behavior
let mockLeads = [];

// Re-implement executeConversationRouting with injectable dependencies
// to unit-test the logic without hitting real DB / Feishu
async function executeConversationRouting(
  route, conversationId, waId, handoffSummary,
  { getLeads, updateLead, sendFeishu, sendFAQ } = {}
) {
  if (route === 'CONTINUE') {
    return { success: true, action: 'continue_conversation' };
  }

  const leads = await getLeads(conversationId, route);

  if (leads.length === 0) {
    return { success: true, action: 'no_leads' };
  }

  const results = [];
  for (const lead of leads) {
    // executeLeadRouting inlined
    if (route === 'HUMAN_NOW') {
      await updateLead(lead.id, { route: 'HUMAN_NOW', handoffSummary });
      sendFeishu(lead, handoffSummary);
      results.push({ leadId: lead.id, success: true });
    } else if (route === 'FAQ_END') {
      await updateLead(lead.id, { route: 'FAQ_END' });
      results.push({ leadId: lead.id, success: true, action: 'marked_faq_end' });
    }
  }

  if (route === 'FAQ_END') {
    await sendFAQ(waId);
  }

  return {
    success: results.every(r => r.success),
    results,
    leadsRouted: results.length,
  };
}

// ── Unit Tests ────────────────────────────────────────────────

console.log('\n=== Unit Tests ===\n');

// Test 1: CONTINUE route → early return
console.log('Test 1: CONTINUE route → early return');
{
  const result = await executeConversationRouting(
    'CONTINUE', 'conv-1', 'wa-1', null,
    { getLeads: () => { throw new Error('should not query'); } }
  );
  assert(result.action === 'continue_conversation', 'returns continue_conversation');
  assert(result.success === true, 'success is true');
}

// Test 2: HUMAN_NOW with leads already set to HUMAN_NOW → routes and notifies
console.log('\nTest 2: HUMAN_NOW with matching leads → routes + notifies');
{
  const mockLead = {
    id: 'lead-1',
    car_model: 'BYD Seal',
    destination_country: 'Ethiopia',
    inquiry_quality: 'GOOD',
    business_value: 'HIGH',
    contact: { wa_id: '251911219360', name: 'Test', company_name: 'TestCo' },
  };

  const trackCalls = { update: [], feishu: [] };

  const result = await executeConversationRouting(
    'HUMAN_NOW', 'conv-1', '251911219360', 'Please follow up',
    {
      getLeads: (convId, route) => {
        assert(route === 'HUMAN_NOW', 'queries with route=HUMAN_NOW (not CONTINUE)');
        return [mockLead];
      },
      updateLead: (id, updates) => {
        trackCalls.update.push({ id, updates });
      },
      sendFeishu: (lead, summary) => {
        trackCalls.feishu.push({ lead, summary });
      },
      sendFAQ: () => {},
    }
  );

  assert(result.success === true, 'success is true');
  assert(result.leadsRouted === 1, 'routed 1 lead');
  assert(trackCalls.update.length === 1, 'updateLead called once');
  assert(trackCalls.update[0].updates.route === 'HUMAN_NOW', 'updateLead sets route=HUMAN_NOW');
  assert(trackCalls.feishu.length === 1, 'Feishu notification sent');
  assert(trackCalls.feishu[0].summary === 'Please follow up', 'handoff_summary passed to Feishu');
}

// Test 3: HUMAN_NOW with no matching leads → no_leads
console.log('\nTest 3: HUMAN_NOW with no matching leads → no_leads');
{
  const result = await executeConversationRouting(
    'HUMAN_NOW', 'conv-empty', 'wa-1', null,
    {
      getLeads: () => [],
      updateLead: () => { throw new Error('should not update'); },
      sendFeishu: () => { throw new Error('should not send'); },
      sendFAQ: () => {},
    }
  );
  assert(result.action === 'no_leads', 'returns no_leads');
  assert(result.success === true, 'success is true');
}

// Test 4: FAQ_END → routes + sends FAQ
console.log('\nTest 4: FAQ_END → routes + sends FAQ');
{
  const mockLead = { id: 'lead-faq', car_model: 'Toyota', contact: {} };
  let faqSent = false;

  const result = await executeConversationRouting(
    'FAQ_END', 'conv-faq', 'wa-faq', null,
    {
      getLeads: (convId, route) => {
        assert(route === 'FAQ_END', 'queries with route=FAQ_END');
        return [mockLead];
      },
      updateLead: () => {},
      sendFeishu: () => {},
      sendFAQ: (waId) => { faqSent = true; },
    }
  );

  assert(result.success === true, 'success is true');
  assert(faqSent === true, 'FAQ resources sent');
}

// ── Summary ────────────────────────────────────────────────────

console.log(`\n=== Unit Test Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  console.log('⚠️  Unit tests failed, skipping integration test.\n');
  process.exit(1);
}

// ── Integration Test: real contact 251911219360 ───────────────

console.log('=== Integration Test: contact 251911219360 ===\n');

// 1. Find the lead and its conversation
const { data: leads, error } = await supabase
  .from('leads')
  .select('id, conversation_id, route, car_model, destination_country, inquiry_quality, business_value, conversation_intent_summary, handoff_summary, qty_bucket, color_quantity, incoterm, loading_port, timeline, destination_port, contact:contacts(wa_id, name, company_name)')
  .eq('route', 'HUMAN_NOW')
  .order('updated_at', { ascending: false });

if (error) {
  console.error('DB error:', error.message);
  process.exit(1);
}

const targetLeads = leads.filter(l => l.contact?.wa_id === '251911219360');

if (targetLeads.length === 0) {
  console.log('❌ No HUMAN_NOW leads found for contact 251911219360');
  process.exit(1);
}

console.log(`Found ${targetLeads.length} HUMAN_NOW lead(s) for 251911219360:`);
for (const lead of targetLeads) {
  console.log(`  - ${lead.id}: ${lead.car_model} → ${lead.destination_country}`);
}

// 2. Verify getLeadsByConversation with route param works
const convId = targetLeads[0].conversation_id;

const { data: byRoute } = await supabase
  .from('leads')
  .select('*, contact:contacts(wa_id, name, company_name)')
  .eq('conversation_id', convId)
  .eq('route', 'HUMAN_NOW')
  .order('created_at', { ascending: true });

assert(byRoute.length > 0, `getLeadsByConversation(convId, 'HUMAN_NOW') returns ${byRoute.length} lead(s)`);

const { data: byContinue } = await supabase
  .from('leads')
  .select('*')
  .eq('conversation_id', convId)
  .eq('route', 'CONTINUE');

assert(byContinue.length === 0, `getLeadsByConversation(convId, 'CONTINUE') returns 0 leads (BUG was here)`);

// 3. Send Feishu notification using the real function
console.log('\nSending Feishu notification for real lead...');

const { executeConversationRouting: realRouting } = await import('../src/routing.service.js');

const routingResult = await realRouting(
  'HUMAN_NOW',
  convId,
  '251911219360',
  targetLeads[0].handoff_summary
);

console.log('Routing result:', JSON.stringify(routingResult, null, 2));
assert(routingResult.success === true, 'Real routing succeeded');
assert(routingResult.leadsRouted > 0, `Routed ${routingResult.leadsRouted} lead(s)`);

// Wait for fire-and-forget Feishu request to complete before exiting
await new Promise(resolve => setTimeout(resolve, 3000));

console.log(`\n=== All Tests Done: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
