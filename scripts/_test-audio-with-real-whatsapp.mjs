#!/usr/bin/env node
// 端到端: 用生产 DB 里最近一条真实 WhatsApp 语音 message,跑完整 transcribe
// 链路 (Meta media download → Gemini transcribe)。验证 ogg/opus 编码也能过。
import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '/Users/a123/Desktop/LeadEngine/.env.local' });

const supabase = createClient('https://exevqpqpsvojfowpzize.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY);

// 找最近一条 audio message + 关联的 tenant
// .eq 对 jsonb 路径不支持,用 .filter
const { data: msgs } = await supabase
  .from('messages')
  .select('id, conversation_id, metadata, sent_at')
  .filter('metadata->>media_type', 'eq', 'audio')
  .order('sent_at', { ascending: false })
  .limit(20);

// 拿对应 conversation 的 tenant_id
const convIds = [...new Set((msgs || []).map((m) => m.conversation_id).filter(Boolean))];
const { data: convs } = await supabase
  .from('conversations')
  .select('id, tenant_id')
  .in('id', convIds);
const tenantByConv = Object.fromEntries((convs || []).map((c) => [c.id, c.tenant_id]));
for (const m of msgs || []) m.tenant_id = tenantByConv[m.conversation_id];

if (!msgs?.length) { console.error('没找到 audio message (查询返回空)'); process.exit(1); }

console.log(`找到 ${msgs.length} 条 audio messages`);
for (const m of msgs.slice(0, 5)) {
  console.log(`  ${m.sent_at}  tenant=${m.tenant_id?.slice(0,8)}  mediaId=${m.metadata?.wa_media_id?.slice(0,20)}  mime=${m.metadata?.mime_type}`);
}

const pick = msgs[0];
const mediaId = pick.metadata?.wa_media_id;
const mimeType = pick.metadata?.mime_type;
const tenantId = pick.tenant_id;
if (!mediaId) { console.error('选中的 message 缺 wa_media_id'); process.exit(1); }

// 拿这个 tenant 的 Meta token
console.log(`\n选 mediaId=${mediaId} mime=${mimeType} tenant=${tenantId.slice(0,8)}`);
const { data: conn } = await supabase
  .from('meta_connections')
  .select('system_user_token_encrypted')
  .eq('tenant_id', tenantId)
  .eq('status', 'active')
  .maybeSingle();
if (!conn) { console.error('该 tenant 无 active meta_connection'); process.exit(1); }

const { decryptToken } = await import('../lib/meta-token-crypto.js');
const token = decryptToken(conn.system_user_token_encrypted);
console.log('Meta token 解密成功');

// 跑改造后的 transcribeWhatsAppAudio (完整链路)
const { transcribeWhatsAppAudio } = await import('../src/whisper.service.js');
try {
  const t0 = Date.now();
  const text = await transcribeWhatsAppAudio(mediaId, token, { tenantId, mimeType });
  const dt = Date.now() - t0;
  console.log(`\n✅ transcribe 成功 (${dt}ms)`);
  console.log(`   transcript: "${text}"`);
  if (!text) { console.error('   ⚠️ 空字符串'); process.exit(1); }
} catch (e) {
  console.error(`\n❌ transcribe 失败: ${e.message}`);
  if (e.message.includes('media') || e.message.includes('expired')) {
    console.log('   (mediaId 可能已过期 30d TTL,这不是我们改造的问题)');
  }
  process.exit(1);
}
