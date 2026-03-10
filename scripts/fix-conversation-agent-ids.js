/**
 * Fix conversation agent_ids
 *
 * Problem: Agricultural agent was mistakenly called, creating empty agent-scoped
 * conversations. Queue-processor stored messages in agent_id=null conversations.
 * This caused "2 个对话" with only 1 having messages.
 *
 * Steps:
 * 1. Delete all empty conversations (message_count=0)
 * 2. Update ALL remaining conversations to the correct agent_id
 */

import supabase from '../lib/supabase.js';

const AGENT_ID = '01a8019a-251e-45a7-9f14-4ca3e593c096';

async function fix() {
  // Step 1: Delete all empty conversations (message_count=0)
  const { data: emptyConvs, error: fetchErr } = await supabase
    .from('conversations')
    .select('id')
    .eq('message_count', 0);

  if (fetchErr) {
    console.error('Error fetching empty conversations:', fetchErr);
    process.exit(1);
  }

  console.log(`Found ${emptyConvs?.length || 0} empty conversations to delete`);

  if (emptyConvs?.length > 0) {
    const ids = emptyConvs.map(c => c.id);

    // Delete leads first (FK constraint)
    const { error: leadsErr } = await supabase
      .from('leads')
      .delete()
      .in('conversation_id', ids);
    if (leadsErr) console.error('Error deleting leads:', leadsErr);

    // Delete the empty conversations
    const { error: delErr } = await supabase
      .from('conversations')
      .delete()
      .in('id', ids);

    if (delErr) {
      console.error('Error deleting empty conversations:', delErr);
      process.exit(1);
    }
    console.log(`Deleted ${ids.length} empty conversations`);
  }

  // Step 2: Update ALL remaining conversations to the correct agent_id
  const { data: updated, error: updateErr } = await supabase
    .from('conversations')
    .update({ agent_id: AGENT_ID })
    .neq('agent_id', AGENT_ID)
    .select('id');

  if (updateErr) {
    console.error('Error updating conversations:', updateErr);
    // Also try null ones
  }
  console.log(`Updated ${updated?.length || 0} conversations with wrong agent_id`);

  // Also update agent_id IS NULL conversations
  const { data: updatedNull, error: nullErr } = await supabase
    .from('conversations')
    .update({ agent_id: AGENT_ID })
    .is('agent_id', null)
    .select('id');

  if (nullErr) console.error('Error updating null agent_id conversations:', nullErr);
  console.log(`Updated ${updatedNull?.length || 0} conversations with null agent_id`);

  // Step 3: Update ALL leads to the correct agent_id
  const { data: updatedLeads, error: leadsUpdateErr } = await supabase
    .from('leads')
    .update({ agent_id: AGENT_ID })
    .neq('agent_id', AGENT_ID)
    .select('id');

  if (leadsUpdateErr) console.error('Error updating leads:', leadsUpdateErr);
  console.log(`Updated ${updatedLeads?.length || 0} leads with wrong agent_id`);

  const { data: updatedNullLeads, error: nullLeadsErr } = await supabase
    .from('leads')
    .update({ agent_id: AGENT_ID })
    .is('agent_id', null)
    .select('id');

  if (nullLeadsErr) console.error('Error updating null agent_id leads:', nullLeadsErr);
  console.log(`Updated ${updatedNullLeads?.length || 0} leads with null agent_id`);

  // Verify
  const { data: remaining } = await supabase
    .from('conversations')
    .select('id, agent_id')
    .or(`agent_id.is.null,agent_id.neq.${AGENT_ID}`);

  console.log(`\nVerification: ${remaining?.length || 0} conversations not on correct agent_id`);
  console.log('Done!');
}

fix();
