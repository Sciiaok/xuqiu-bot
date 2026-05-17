// One-off backfill: conversations.product_line for rows where it's NULL but
// the wa_phone_number_id maps to a product_lines row.
//
// Run before scripts/backfill-leads-product-line.mjs to cover the leads whose
// conversation row was also missing product_line.
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = 'https://exevqpqpsvojfowpzize.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: rows, error: qErr } = await sb.rpc('dev_exec_sql', {
  query: `SELECT pl.id AS product_line, pl.wa_phone_number_id AS phone_id,
                 array_agg(c.id) AS conv_ids
          FROM conversations c
          JOIN product_lines pl ON pl.wa_phone_number_id = c.wa_phone_number_id
          WHERE c.product_line IS NULL
          GROUP BY pl.id, pl.wa_phone_number_id`,
});
if (qErr) throw qErr;

let total = 0;
for (const g of rows) {
  const { data, error } = await sb
    .from('conversations')
    .update({ product_line: g.product_line })
    .is('product_line', null)
    .in('id', g.conv_ids)
    .select('id');
  if (error) throw error;
  total += data.length;
  console.log(`[${g.product_line}] +${data.length}`);
}
console.log(`backfilled ${total} conversations`);
