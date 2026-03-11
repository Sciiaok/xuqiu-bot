/**
 * Search live messages by content keyword.
 *
 * Usage:
 *   node --env-file=.env.local scripts/search-live-messages.js <keyword>
 */

import supabase from '../lib/supabase.js';

async function main() {
  const keyword = process.argv[2];
  if (!keyword) {
    console.error('Usage: node --env-file=.env.local scripts/search-live-messages.js <keyword>');
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('messages')
    .select('id, conversation_id, role, sent_by, content, sent_at')
    .ilike('content', `%${keyword}%`)
    .order('sent_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  console.log(JSON.stringify(data || [], null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
