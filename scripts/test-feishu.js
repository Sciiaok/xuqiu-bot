import supabase from '../lib/supabase.js';
import { sendFeishuMessage } from '../src/feishu.service.js';

const { data: lead, error } = await supabase
  .from('leads')
  .select('*, contact:contacts(wa_id, name, company_name)')
  .eq('route', 'HUMAN_NOW')
  .order('updated_at', { ascending: false })
  .limit(1)
  .single();

if (error || !lead) {
  console.error('未找到 HUMAN_NOW 线索:', error?.message);
  process.exit(1);
}

console.log('找到线索:', lead.id, lead.contact?.company_name);

const lines = [
  '🔥 **意向线索 - 需立即跟进**',
  '',
  `**联系人：** ${lead.contact?.name || '未知'}`,
  `**公司：** ${lead.contact?.company_name || '未知'}`,
  `**WhatsApp：** ${lead.contact?.wa_id || '未知'}`,
  '',
  `**车型：** ${lead.car_model || '-'}`,
  `**目的国：** ${lead.destination_country || '-'}`,
  `**目的港：** ${lead.destination_port || '-'}`,
  `**数量：** ${lead.qty_bucket || '-'}`,
  `**贸易条款：** ${lead.incoterm || '-'}`,
  `**装运港：** ${lead.loading_port || '-'}`,
  `**采购商类型：** ${lead.buyer_type || '-'}`,
  `**时间线：** ${lead.timeline || '-'}`,
  '',
  `**评分：** ${lead.score ?? '-'}`,
  `**意图摘要：** ${lead.conversation_intent_summary || lead.handoff_summary || '-'}`,
].join('\n');

const result = await sendFeishuMessage(lines, true);
console.log('发送结果:', result.msg);
