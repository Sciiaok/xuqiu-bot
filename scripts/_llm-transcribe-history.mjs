import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '/Users/a123/Desktop/LeadEngine/.env.local' });
const supabase = createClient('https://exevqpqpsvojfowpzize.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY);

// 看 7 天内的 webhook.audio.transcribe 调用,成功 vs 失败 by day
const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
const rows = [];
let off = 0;
while (true) {
  const { data, error } = await supabase
    .from('llm_usage_logs')
    .select('created_at, error_message, model, cost_usd')
    .eq('call_site', 'webhook.audio.transcribe')
    .gte('created_at', since)
    .range(off, off + 999);
  if (error) throw error;
  if (!data || data.length === 0) break;
  rows.push(...data);
  if (data.length < 1000) break;
  off += 1000;
}
console.log(`7d total transcribe calls: ${rows.length}`);
const byDay = {};
for (const r of rows) {
  const d = r.created_at.slice(0, 10);
  (byDay[d] ||= { total: 0, err: 0, ok: 0 });
  byDay[d].total++;
  if (r.error_message) byDay[d].err++; else byDay[d].ok++;
}
console.log('day | total | ok | err');
for (const [d, v] of Object.entries(byDay).sort()) {
  console.log(`${d} | ${v.total} | ${v.ok} | ${v.err}`);
}

// 看更早:30 天最近 20 条成功 + 最早的失败
const { data: lastOk } = await supabase
  .from('llm_usage_logs')
  .select('created_at, model, cost_usd, error_message')
  .eq('call_site', 'webhook.audio.transcribe')
  .is('error_message', null)
  .order('created_at', { ascending: false })
  .limit(5);
console.log('\nlast 5 SUCCESSFUL transcriptions ever:');
for (const r of lastOk || []) console.log(`  ${r.created_at} ${r.model} cost=${r.cost_usd}`);

const { data: firstFail } = await supabase
  .from('llm_usage_logs')
  .select('created_at, error_message')
  .eq('call_site', 'webhook.audio.transcribe')
  .not('error_message', 'is', null)
  .order('created_at', { ascending: true })
  .limit(3);
console.log('\nfirst 3 FAILED transcriptions ever:');
for (const r of firstFail || []) console.log(`  ${r.created_at} :: ${(r.error_message || '').slice(0, 110)}`);
