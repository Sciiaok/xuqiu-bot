export const MOCK_CONTACT = {
  id: 'contact-001',
  wa_id: '8613800000001',
  company_name: 'Test Corp',
  name: 'Test User',
  conversationCount: 1,
  latestConversationId: 'conv-001',
  lastMessageAt: new Date().toISOString(),
};

export const MOCK_CONVERSATION = {
  id: 'conv-001',
  contact_id: 'contact-001',
  last_message_at: new Date().toISOString(),
  is_human_takeover: false,
  human_takeover_at: null,
  contact: {
    id: 'contact-001',
    wa_id: '8613800000001',
    company_name: 'Test Corp',
    name: 'Test User',
  },
};

export const MOCK_MESSAGES = [
  { id: 'msg-1', role: 'user', content: 'Hello', sent_at: new Date().toISOString(), sent_by: 'customer', conversation_id: 'conv-001' },
  { id: 'msg-2', role: 'assistant', content: 'Hi!', sent_at: new Date().toISOString(), sent_by: 'bot', conversation_id: 'conv-001' },
];

export const MOCK_AGENT = {
  id: 'agent-001',
  name: 'Vehicle Export Agent',
  product_line: 'auto',
  system_prompt: 'You are a vehicle export assistant.',
  output_schema: {},
  wa_phone_number_id: '123456',
  is_active: true,
  created_at: new Date().toISOString(),
};

export const MOCK_AGENTS_LIST = [
  MOCK_AGENT,
  {
    id: 'agent-002',
    name: 'Parts Agent',
    product_line: 'parts',
    system_prompt: 'You are a parts agent.',
    output_schema: {},
    wa_phone_number_id: '789012',
    is_active: true,
    created_at: new Date().toISOString(),
  },
];
