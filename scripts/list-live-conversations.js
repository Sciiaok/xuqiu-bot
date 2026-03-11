/**
 * List recent live conversations for manual testing.
 *
 * Usage:
 *   node --env-file=.env.local scripts/list-live-conversations.js
 */

import supabase from '../lib/supabase.js';

async function main() {
  const { data, error } = await supabase
    .from('conversations')
    .select(`
      id,
      contact_id,
      agent_id,
      started_at,
      last_message_at,
      message_count,
      status,
      contacts!inner (
        wa_id,
        name,
        company_name
      )
    `)
    .order('last_message_at', { ascending: false })
    .limit(20);

  if (error) {
    throw error;
  }

  console.log(JSON.stringify(data || [], null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
