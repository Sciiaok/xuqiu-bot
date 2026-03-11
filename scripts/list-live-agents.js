/**
 * List live agents for routing inspection.
 *
 * Usage:
 *   node --env-file=.env.local scripts/list-live-agents.js
 */

import supabase from '../lib/supabase.js';

async function main() {
  const { data, error } = await supabase
    .from('agents')
    .select('id, name, product_line, is_active, created_at')
    .order('created_at', { ascending: true });

  if (error) throw error;
  console.log(JSON.stringify(data || [], null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
