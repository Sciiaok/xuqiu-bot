// One-off backfill: fill leads.product_line from conversations.product_line.
// Pairs with supabase/migrations/2026-05-17-backfill-leads-product-line.sql
// (which is the canonical statement; this script runs the same logic against
// the cloud DB via PostgREST since dev_exec_sql is read-only).
//
// Run: node scripts/backfill-leads-product-line.mjs
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = 'https://exevqpqpsvojfowpzize.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: groups, error: groupErr } = await sb.rpc('dev_exec_sql', {
  query: `SELECT c.product_line AS pl, array_agg(l.conversation_id) AS conv_ids
          FROM leads l JOIN conversations c ON c.id = l.conversation_id
          WHERE l.product_line IS NULL AND c.product_line IS NOT NULL
          GROUP BY c.product_line`,
});
if (groupErr) throw groupErr;

const CHUNK = 100;
let total = 0;
for (const g of groups) {
  const ids = g.conv_ids;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await sb
      .from('leads')
      .update({ product_line: g.pl })
      .is('product_line', null)
      .in('conversation_id', slice)
      .select('id');
    if (error) throw error;
    total += data.length;
    process.stdout.write(`[${g.pl}] +${data.length} (running total ${total})\n`);
  }
}
console.log(`backfilled ${total} rows`);
