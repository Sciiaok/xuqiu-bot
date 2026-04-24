/**
 * Reload leads for a contact by re-running the full queue-processor pipeline.
 * Usage: node scripts/reload-leads.js <wa_id>
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { runMedici } from '../src/agents/medici/index.js';
import { getMissingFields } from '../src/inquiry-quality.js';
import { loadMediciConfig } from '../src/agents/medici/config.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

const waId = process.argv[2];
if (!waId) {
  console.error('Usage: node scripts/reload-leads.js <wa_id>');
  process.exit(1);
}

async function main() {
  // 1. Find contact
  const { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('wa_id', waId)
    .single();
  if (!contact) { console.error('Contact not found:', waId); process.exit(1); }
  console.log(`Contact: ${contact.name} (${contact.wa_id})`);

  // 2. Find latest conversation
  const { data: convs } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contact.id)
    .order('last_message_at', { ascending: false })
    .limit(1);
  if (!convs?.length) { console.error('No conversations found'); process.exit(1); }
  const conv = convs[0];
  console.log(`Conversation: ${conv.id} (status=${conv.status}, msgs=${conv.message_count})`);

  // 3. Find current lead
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: true });
  const currentLead = leads?.[0] || null;
  console.log(`\n=== CURRENT LEADS (${leads?.length || 0}) ===`);
  for (const l of (leads || [])) {
    console.log(JSON.stringify({
      id: l.id,
      car_model: l.car_model,
      product_name: l.product_name,
      qty_bucket: l.qty_bucket,
      destination_country: l.destination_country,
      conversation_intent: l.conversation_intent,
      inquiry_quality: l.inquiry_quality,
      business_value: l.business_value,
      route: l.route,
    }, null, 2));
  }

  // 4. Get messages
  const { data: messages } = await supabase
    .from('messages')
    .select('role, content, metadata, sent_at')
    .eq('conversation_id', conv.id)
    .order('sent_at', { ascending: true });
  console.log(`\n=== MESSAGES (${messages?.length}) ===`);
  for (const m of messages) {
    console.log(`[${m.role}] ${m.content?.slice(0, 120)}`);
  }

  // 5. Load runtime config (assembled from product_lines slots; resolved by
  //    conv.product_line or conv.wa_phone_number_id → product_lines mapping).
  const agentConfig = await loadMediciConfig(conv);
  if (agentConfig) {
    console.log(`\nProduct line: ${agentConfig.product_line} (${agentConfig.name})`);
  } else {
    console.log('\n(no product_line resolved — phone not bound?)');
  }

  // 6. Build context info (same as queue-processor)
  const priorState = currentLead ? {
    conversation_intent: currentLead.conversation_intent,
    inquiry_quality: currentLead.inquiry_quality,
    business_value: currentLead.business_value,
    car_model: currentLead.car_model || currentLead.product_name || null,
    qty_bucket: currentLead.qty_bucket || null,
    destination_country: currentLead.destination_country || null,
    company_name: currentLead.company_name || null,
  } : null;

  const contextInfo = {
    missing_fields: getMissingFields(
      currentLead?.inquiry_quality || 'GOOD',
      {},
      {
        qualificationConfig: agentConfig?.qualification_config,
        lead: currentLead,
      }
    ),
    prior_state: priorState,
  };
  console.log('\n=== CONTEXT INFO ===');
  console.log(JSON.stringify(contextInfo, null, 2));

  // 7. Split: history (all but last user msg) + latest user msg
  const history = messages.slice(0, -1).map(m => ({
    role: m.role,
    content: m.content,
    metadata: m.metadata || {},
  }));
  const lastMsg = messages[messages.length - 1];
  const latestUserInput = lastMsg.content;

  console.log(`\n=== CALLING CLAUDE (history=${history.length} msgs, latest="${latestUserInput?.slice(0, 80)}") ===\n`);

  // 8. Call Medici
  const response = await runMedici({
    history,
    input: latestUserInput,
    context: contextInfo,
    agentConfig,
    trace: { traceId: 'reload-test', conversationId: conv.id, waId },
  });

  console.log('=== CLAUDE RESPONSE ===');
  console.log(JSON.stringify(response, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
