import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY);

const { data: convs } = await supabase
  .from('conversations')
  .select('id, agent_id, message_count')
  .not('agent_id', 'is', null)
  .gt('message_count', 1)
  .order('last_message_at', { ascending: false })
  .limit(30);

const convIds = convs.map(c => c.id);

const { data: msgs } = await supabase
  .from('messages')
  .select('conversation_id, role, content, sent_by')
  .in('conversation_id', convIds)
  .eq('role', 'user')
  .order('sent_at', { ascending: true });

const { data: leads } = await supabase
  .from('leads')
  .select('conversation_id, conversation_intent, inquiry_quality, business_value, route, car_model, product_name, destination_country, qty_bucket')
  .in('conversation_id', convIds)
  .order('updated_at', { ascending: false });

const agentMap = {};
for (const c of convs) agentMap[c.id] = c.agent_id;

const AGENT_NAMES = {
  'b5280fed-d8e7-48d8-9a18-7f610c6aee65': 'agri',
  '01a8019a-251e-45a7-9f14-4ca3e593c096': 'vehicle',
  '68c8b84d-e4e5-4f4f-afeb-1b76e450847d': 'auto_parts',
};

const byConv = {};
for (const m of msgs) {
  if (!byConv[m.conversation_id]) byConv[m.conversation_id] = [];
  byConv[m.conversation_id].push(m.content);
}

for (const [convId, messages] of Object.entries(byConv)) {
  const lead = leads.find(l => l.conversation_id === convId);
  const agent = AGENT_NAMES[agentMap[convId]] || 'unknown';
  console.log(`\n[${agent}] conv=${convId.substring(0, 8)} msgs=${messages.length}`);
  for (const m of messages) {
    console.log(`  > ${m.substring(0, 140)}`);
  }
  if (lead) {
    console.log(`  LEAD: intent=${lead.conversation_intent} quality=${lead.inquiry_quality} value=${lead.business_value} route=${lead.route}`);
    console.log(`  product=${lead.car_model || lead.product_name} dest=${lead.destination_country} qty=${lead.qty_bucket}`);
  }
}
