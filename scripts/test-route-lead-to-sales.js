/**
 * Test routeLeadToSales() end-to-end with a synthetic lead.
 *
 * Run:  node scripts/test-route-lead-to-sales.js
 *
 * Sends one real Feishu message into the configured chat — watch the group
 * to confirm. The function fires-and-forgets, so we sleep at the end to let
 * the network call finish before the process exits.
 */

import { routeLeadToSales } from '../src/routing.service.js';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const rand = Math.random().toString(36).slice(2, 8).toUpperCase();

const fakeLead = {
  id: `00000000-0000-4000-8000-${stamp.slice(-12)}`,
  conversation_id: `00000000-0000-4000-8000-${rand.padStart(12, '0')}`,
  inquiry_quality: 'PROOF',
  business_value: 'HIGH',
  car_model: 'BYD Sea Lion 06',
  destination_country: 'Djibouti',
  destination_port: 'Doraleh',
  qty_bucket: '20-50',
  color_quantity: [
    { color: 'Black', qty: 15 },
    { color: 'White', qty: 10 },
  ],
  incoterm: 'FOB',
  loading_port: 'Shanghai',
  timeline: '本月内下单',
  conversation_intent_summary: `[TEST ${stamp}-${rand}] 这是一条测试消息，用于验证 routeLeadToSales() → 飞书发送链路是否正常。`,
  updated_at: new Date().toISOString(),
  contact: {
    wa_id: '8613000000000',
    name: `测试客户-${rand}`,
    company_name: `Test Trading Co. (${rand})`,
  },
};

const handoffSummary = `测试 handoff_summary：客户为高意向 PROOF 线索，建议立即跟进。trace=${stamp}-${rand}`;

console.log(`[test] 发起 routeLeadToSales — lead_id=${fakeLead.id}, trace=${stamp}-${rand}`);
const result = routeLeadToSales(fakeLead, handoffSummary, {
  traceId: `test-${stamp}-${rand}`,
  conversationId: fakeLead.conversation_id,
  waId: fakeLead.contact.wa_id,
});
console.log('[test] routeLeadToSales 同步返回:', result);

// Feishu send is fire-and-forget (.catch() only, no return). Give it time
// to actually hit the network before the process exits.
await new Promise((r) => setTimeout(r, 6000));
console.log('[test] 等待结束。请在飞书群里查看是否收到测试消息。');
