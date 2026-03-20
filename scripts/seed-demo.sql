-- =====================================================
-- Demo Seed Data for Lead Engine
-- Run after applying all migrations on a fresh Supabase project
-- =====================================================

-- 1. Agents
INSERT INTO agents (id, name, product_line, system_prompt, output_schema, is_active, qualification_config, ad_context_map)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Auto Parts Agent', 'auto_parts', 'You are an auto parts sales assistant.', '{}', true, '{}', '{}'),
  ('a0000000-0000-0000-0000-000000000002', 'Vehicle Agent', 'vehicle', 'You are a vehicle sales assistant.', '{}', true, '{}', '{}'),
  ('a0000000-0000-0000-0000-000000000003', 'Agri Machinery Agent', 'agri_machinery', 'You are an agricultural machinery sales assistant.', '{}', true, '{}', '{}');

-- 2. Contacts
INSERT INTO contacts (id, wa_id, name, company_name, created_at, updated_at, metadata)
VALUES
  ('c0000000-0000-0000-0000-000000000001', '971501234567', 'Ahmed Al-Rashid', 'Gulf Auto Trading LLC', NOW() - INTERVAL '15 days', NOW() - INTERVAL '1 day', '{}'),
  ('c0000000-0000-0000-0000-000000000002', '234801234567', 'Chukwu Obi', 'Lagos Motors Import', NOW() - INTERVAL '12 days', NOW() - INTERVAL '2 days', '{}'),
  ('c0000000-0000-0000-0000-000000000003', '255712345678', 'James Mwangi', 'East Africa Vehicles', NOW() - INTERVAL '10 days', NOW() - INTERVAL '3 days', '{}'),
  ('c0000000-0000-0000-0000-000000000004', '593912345678', 'Carlos Mendez', 'Mendez Auto Parts', NOW() - INTERVAL '8 days', NOW() - INTERVAL '1 day', '{}'),
  ('c0000000-0000-0000-0000-000000000005', '77071234567', 'Nursultan Abayev', 'KZ Farm Equipment', NOW() - INTERVAL '6 days', NOW() - INTERVAL '2 days', '{}'),
  ('c0000000-0000-0000-0000-000000000006', '84912345678', 'Nguyen Thanh', 'Vietnam Trade Co.', NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day', '{}'),
  ('c0000000-0000-0000-0000-000000000007', '201012345678', 'Fatima Hassan', 'Cairo Import Export', NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day', '{}'),
  ('c0000000-0000-0000-0000-000000000008', '998901234567', 'Dilshod Karimov', 'Tashkent Agro', NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day', '{}');

-- 3. Conversations
INSERT INTO conversations (id, contact_id, status, last_message_at, message_count, created_at, is_human_takeover, agent_id)
VALUES
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'active', NOW() - INTERVAL '1 day',  12, NOW() - INTERVAL '15 days', false, 'a0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'active', NOW() - INTERVAL '2 days',  8, NOW() - INTERVAL '12 days', true,  'a0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003', 'active', NOW() - INTERVAL '3 days',  6, NOW() - INTERVAL '10 days', false, 'a0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000004', 'active', NOW() - INTERVAL '1 day', 15, NOW() - INTERVAL '8 days',  false, 'a0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000005', 'active', NOW() - INTERVAL '2 days', 10, NOW() - INTERVAL '6 days',  false, 'a0000000-0000-0000-0000-000000000003'),
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000006', 'idle',   NOW() - INTERVAL '1 day',  4, NOW() - INTERVAL '5 days',  false, 'a0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000007', 'active', NOW() - INTERVAL '1 day',  9, NOW() - INTERVAL '4 days',  false, 'a0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000008', 'active', NOW() - INTERVAL '1 day',  7, NOW() - INTERVAL '3 days',  false, 'a0000000-0000-0000-0000-000000000003');

-- 4. Leads
INSERT INTO leads (id, conversation_id, contact_id, route, destination_country, car_model, qty_bucket, buyer_type, timeline, handoff_summary, inquiry_quality, business_value, conversation_intent, brand, product_name, approved, approved_at, agent_id, created_at, updated_at)
VALUES
  -- Ahmed - auto parts, high value
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'HUMAN_NOW', 'UAE', 'Toyota Hilux 2024', '20+', 'dealer', '2 weeks',
   'Large dealer in Dubai looking for bulk brake pads and filters for Toyota Hilux fleet.',
   'PROOF', 'HIGH', 'business_inquiry', 'Toyota', 'Brake Pads', true, NOW() - INTERVAL '1 day',
   'a0000000-0000-0000-0000-000000000001', NOW() - INTERVAL '14 days', NOW() - INTERVAL '1 day'),

  -- Chukwu - vehicle, human now
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002',
   'HUMAN_NOW', 'Nigeria', 'Toyota Land Cruiser', '6-20', 'trading_org', '1 month',
   'Trading company wants 10 Land Cruisers for resale in Lagos market.',
   'QUALIFY', 'HIGH', 'business_inquiry', 'Toyota', 'Land Cruiser', false, NULL,
   'a0000000-0000-0000-0000-000000000002', NOW() - INTERVAL '11 days', NOW() - INTERVAL '2 days'),

  -- James - vehicle
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003',
   'CONTINUE', 'Tanzania', 'Isuzu D-Max', '1-5', 'dealer', '3 months',
   NULL, 'GOOD', 'MEDIUM', 'business_inquiry', 'Isuzu', 'D-Max', false, NULL,
   'a0000000-0000-0000-0000-000000000002', NOW() - INTERVAL '9 days', NOW() - INTERVAL '3 days'),

  -- Carlos - auto parts
  ('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000004',
   'HUMAN_NOW', 'Ecuador', 'Hyundai Accent', '20+', 'store_owner', '1 week',
   'Auto parts store owner needs headlights and bumpers for Hyundai Accent.',
   'PROOF', 'MEDIUM', 'business_inquiry', 'Hyundai', 'Headlights', true, NOW() - INTERVAL '1 day',
   'a0000000-0000-0000-0000-000000000001', NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day'),

  -- Nursultan - agri machinery
  ('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000005',
   'CONTINUE', 'Kazakhstan', NULL, '1-5', 'dealer', '2 months',
   NULL, 'QUALIFY', 'HIGH', 'business_inquiry', 'YTO', 'Tractor YTO-504', false, NULL,
   'a0000000-0000-0000-0000-000000000003', NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days'),

  -- Nguyen - auto parts, low value
  ('e0000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000006',
   'NURTURE', 'Vietnam', 'Honda Civic', '1-5', NULL, NULL,
   NULL, 'GOOD', 'LOW', 'price_check', 'Honda', 'Oil Filter', false, NULL,
   'a0000000-0000-0000-0000-000000000001', NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day'),

  -- Fatima - vehicle
  ('e0000000-0000-0000-0000-000000000007', 'd0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000007',
   'HUMAN_NOW', 'Egypt', 'Changan CS75', '6-20', 'trading_org', '2 weeks',
   'Wants to import 8 Changan CS75 Plus for Egyptian market.',
   'QUALIFY', 'HIGH', 'business_inquiry', 'Changan', 'CS75 Plus', false, NULL,
   'a0000000-0000-0000-0000-000000000002', NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day'),

  -- Dilshod - agri machinery
  ('e0000000-0000-0000-0000-000000000008', 'd0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000008',
   'CONTINUE', 'Uzbekistan', NULL, '6-20', 'dealer', '1 month',
   NULL, 'QUALIFY', 'MEDIUM', 'business_inquiry', 'Lovol', 'Harvester', false, NULL,
   'a0000000-0000-0000-0000-000000000003', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day');

-- 5. Messages (sample conversations)
INSERT INTO messages (conversation_id, role, content, sent_at, sent_by)
VALUES
  -- Ahmed conversation
  ('d0000000-0000-0000-0000-000000000001', 'user',      'Hi, I need brake pads for Toyota Hilux 2024 model.',                NOW() - INTERVAL '15 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000001', 'assistant',  'Hello Ahmed! Welcome. I can help you with Toyota Hilux brake pads. Could you tell me the quantity you need and your delivery location?', NOW() - INTERVAL '15 days' + INTERVAL '30 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000001', 'user',      'I need 500 sets, delivery to Dubai. We are a dealer.',              NOW() - INTERVAL '14 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000001', 'assistant',  'Great! 500 sets of brake pads for Toyota Hilux 2024, delivered to Dubai. Let me connect you with our sales team for pricing on this bulk order.', NOW() - INTERVAL '14 days' + INTERVAL '25 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000001', 'user',      'Also need oil filters, same quantity.',                              NOW() - INTERVAL '13 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000001', 'assistant',  'Noted! Adding 500 oil filters to your inquiry. Our team will prepare a combined quotation for you.', NOW() - INTERVAL '13 days' + INTERVAL '20 seconds', 'bot'),

  -- Chukwu conversation
  ('d0000000-0000-0000-0000-000000000002', 'user',      'Good day. We want to buy Toyota Land Cruiser for Nigeria.',          NOW() - INTERVAL '12 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000002', 'assistant',  'Hello! Thank you for your interest in Toyota Land Cruiser. How many units are you looking for, and what specifications do you need?', NOW() - INTERVAL '12 days' + INTERVAL '28 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000002', 'user',      'We need 10 units, 2024 model, diesel engine. FOB Shanghai.',         NOW() - INTERVAL '11 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000002', 'assistant',  'Understood - 10 Toyota Land Cruiser 2024 diesel units, FOB Shanghai to Nigeria. Let me transfer you to our vehicle specialist.', NOW() - INTERVAL '11 days' + INTERVAL '22 seconds', 'bot'),

  -- Carlos conversation
  ('d0000000-0000-0000-0000-000000000004', 'user',      'Necesito luces y bumpers para Hyundai Accent.',                     NOW() - INTERVAL '8 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000004', 'assistant',  'Hola Carlos! I can help with Hyundai Accent parts. What year model, and how many sets do you need?', NOW() - INTERVAL '8 days' + INTERVAL '30 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000004', 'user',      '2020-2023 model, 100 sets of headlights and 50 front bumpers.',      NOW() - INTERVAL '7 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000004', 'assistant',  'Got it! 100 headlight sets and 50 front bumpers for Hyundai Accent 2020-2023. I will get our team to prepare pricing for you.', NOW() - INTERVAL '7 days' + INTERVAL '25 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000004', 'user',      'CIF Guayaquil please.',                                             NOW() - INTERVAL '6 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000004', 'assistant',  'CIF Guayaquil noted. Our team will include shipping costs in the quotation.', NOW() - INTERVAL '6 days' + INTERVAL '20 seconds', 'bot'),

  -- Nursultan conversation
  ('d0000000-0000-0000-0000-000000000005', 'user',      'I am interested in YTO tractor for my farm equipment dealership.',   NOW() - INTERVAL '6 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000005', 'assistant',  'Hello Nursultan! Great to hear your interest in YTO tractors. Which model are you looking for, and how many units?', NOW() - INTERVAL '6 days' + INTERVAL '35 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000005', 'user',      'YTO-504 model, 3 units first as trial order.',                       NOW() - INTERVAL '5 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000005', 'assistant',  'YTO-504, 3 units as a trial order to Kazakhstan. Could you share your preferred delivery terms and timeline?', NOW() - INTERVAL '5 days' + INTERVAL '25 seconds', 'bot'),

  -- Fatima conversation
  ('d0000000-0000-0000-0000-000000000007', 'user',      'We want Changan CS75 Plus for Egypt. Can you give price?',           NOW() - INTERVAL '4 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000007', 'assistant',  'Hello Fatima! The Changan CS75 Plus is a great choice. How many units do you need, and what is your preferred delivery term?', NOW() - INTERVAL '4 days' + INTERVAL '30 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000007', 'user',      '8 units, 2024 model, automatic. CIF Alexandria.',                    NOW() - INTERVAL '3 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000007', 'assistant',  '8 Changan CS75 Plus 2024 automatic, CIF Alexandria. Let me connect you with our vehicle team for a detailed quotation.', NOW() - INTERVAL '3 days' + INTERVAL '25 seconds', 'bot'),

  -- Dilshod conversation
  ('d0000000-0000-0000-0000-000000000008', 'user',      'Hello, looking for Lovol harvester machines.',                        NOW() - INTERVAL '3 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000008', 'assistant',  'Hello Dilshod! We carry Lovol harvesters. Which model interests you, and how many units do you need?', NOW() - INTERVAL '3 days' + INTERVAL '32 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000008', 'user',      'Need 8 combine harvesters for wheat. Delivery to Tashkent.',          NOW() - INTERVAL '2 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000008', 'assistant',  '8 Lovol combine harvesters for wheat, delivered to Tashkent. I will check stock and pricing for you. What is your expected delivery timeline?', NOW() - INTERVAL '2 days' + INTERVAL '28 seconds', 'bot');
