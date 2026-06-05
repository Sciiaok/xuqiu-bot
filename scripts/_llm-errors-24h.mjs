import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '/Users/a123/Desktop/LeadEngine/.env.local' });

const supabase = createClient(
  'https://exevqpqpsvojfowpzize.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

const { count } = await supabase
  .from('llm_usage_logs')
  .select('*', { count: 'exact', head: true })
  .gte('created_at', since)
  .not('error_message', 'is', null);

const rows = [];
for (let off = 0; off < (count || 0); off += 1000) {
  const { data } = await supabase
    .from('llm_usage_logs')
    .select('created_at, tenant_id, product_line, call_site, model, error_message, prompt_tokens, completion_tokens, cost_usd')
    .gte('created_at', since)
    .not('error_message', 'is', null)
    .range(off, off + 999);
  rows.push(...(data || []));
}

console.log(`Total error rows: ${rows.length}\n`);

// 按 call_site 分桶
const bySite = {};
for (const r of rows) {
  const k = r.call_site || 'unknown';
  (bySite[k] ||= []).push(r);
}
console.log('=== 按 call_site 分布 ===');
for (const [k, arr] of Object.entries(bySite).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${arr.length.toString().padStart(3)} × ${k}`);
}
console.log();

// 错误消息归一化(取前 140 字符)
const byMsg = {};
for (const r of rows) {
  const key = (r.error_message || '').slice(0, 140);
  (byMsg[key] ||= []).push(r);
}
console.log('=== 按 error_message 头部 140 字符聚合 ===');
const sorted = Object.entries(byMsg).sort((a, b) => b[1].length - a[1].length);
for (const [msg, arr] of sorted) {
  const sites = [...new Set(arr.map((r) => r.call_site))].join(',');
  const models = [...new Set(arr.map((r) => r.model).filter(Boolean))].join(',');
  console.log(`\n[${arr.length}×] sites=${sites} models=${models}`);
  console.log(`  msg: ${msg}`);
}

// 每个分桶给一个完整样本(取最新)
console.log('\n\n=== 每类 1 条完整样本(最新)===');
for (const [msg, arr] of sorted) {
  const latest = arr.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  console.log(`\n--- [${arr.length}×] ${msg.slice(0, 80)} ---`);
  console.log(JSON.stringify(latest, null, 2));
}
