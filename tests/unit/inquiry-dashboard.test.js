import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDateWindows,
  buildInquiryRecords,
  createDateSeries,
} from '../../lib/inquiry-dashboard.js';

test('buildDateWindows returns exactly seven calendar days for 7d', () => {
  const windows = buildDateWindows({
    days: 7,
    now: new Date('2026-04-06T09:30:00+08:00'),
  });

  assert.equal(windows.current.fromDate, '2026-03-31');
  assert.equal(windows.current.toDate, '2026-04-06');
  assert.deepEqual(createDateSeries(windows.current.fromDate, windows.current.toDate), [
    '2026-03-31',
    '2026-04-01',
    '2026-04-02',
    '2026-04-03',
    '2026-04-04',
    '2026-04-05',
    '2026-04-06',
  ]);
  assert.equal(windows.previous.fromDate, '2026-03-24');
  assert.equal(windows.previous.toDate, '2026-03-30');
});

test('buildDateWindows returns yesterday as the full current window for 1d', () => {
  const windows = buildDateWindows({
    preset: '1d',
    days: 1,
    now: new Date('2026-04-06T09:30:00+08:00'),
  });

  assert.equal(windows.current.fromDate, '2026-04-05');
  assert.equal(windows.current.toDate, '2026-04-05');
  assert.equal(windows.current.fromISO, '2026-04-04T16:00:00.000Z');
  assert.equal(windows.current.toISO, '2026-04-05T15:59:59.999Z');
  assert.equal(windows.previous.fromDate, '2026-04-04');
  assert.equal(windows.previous.toDate, '2026-04-04');
});

test('buildDateWindows keeps custom end date inclusive and previous period equal length', () => {
  const windows = buildDateWindows({
    startDate: '2026-04-05',
    endDate: '2026-04-05',
  });

  assert.equal(windows.current.fromDate, '2026-04-05');
  assert.equal(windows.current.toDate, '2026-04-05');
  assert.equal(windows.current.fromISO, '2026-04-04T16:00:00.000Z');
  assert.equal(windows.current.toISO, '2026-04-05T15:59:59.999Z');
  assert.equal(windows.previous.fromDate, '2026-04-04');
  assert.equal(windows.previous.toDate, '2026-04-04');
});

test('buildInquiryRecords rolls up one inquiry per conversation', () => {
  const conversations = [
    {
      id: 'conv-1',
      agent_id: 'agent-vehicle',
      created_at: '2026-04-05T04:31:53.57398+00:00',
    },
    {
      id: 'conv-2',
      agent_id: 'agent-parts',
      created_at: '2026-04-05T06:48:54.106451+00:00',
    },
  ];
  const leads = [
    {
      id: 'lead-1',
      conversation_id: 'conv-1',
      inquiry_quality: 'GOOD',
      business_value: 'AVERAGE',
      buyer_type: 'dealer',
      conversation_intent: 'business_inquiry',
      destination_country: 'Kenya',
      car_model: 'Leopard 5',
      brand: null,
      product_name: null,
      details: {},
      created_at: '2026-04-05T05:00:00.000Z',
    },
    {
      id: 'lead-2',
      conversation_id: 'conv-1',
      inquiry_quality: 'PROOF',
      business_value: 'HIGH',
      buyer_type: 'dealer',
      conversation_intent: 'business_inquiry,other',
      destination_country: 'Kenya',
      car_model: 'Leopard 5',
      brand: null,
      product_name: null,
      details: {},
      created_at: '2026-04-05T06:00:00.000Z',
    },
  ];
  const agentMap = {
    'agent-vehicle': { id: 'agent-vehicle', name: 'Vehicle Export Agent', product_line: 'vehicle' },
    'agent-parts': { id: 'agent-parts', name: 'Japanese Auto Parts Export Agent', product_line: 'auto_parts' },
  };

  const inquiries = buildInquiryRecords({ conversations, leads, agentMap });

  assert.equal(inquiries.length, 2);
  assert.deepEqual(inquiries[0], {
    conversationId: 'conv-1',
    agentId: 'agent-vehicle',
    agentName: 'Vehicle Export Agent',
    productLine: 'vehicle',
    date: '2026-04-05',
    quality: 'PROOF',
    businessValue: 'HIGH',
    country: 'Kenya',
    buyerType: 'dealer',
    intent: 'business_inquiry',
    productName: 'Leopard 5',
  });
  assert.deepEqual(inquiries[1], {
    conversationId: 'conv-2',
    agentId: 'agent-parts',
    agentName: 'Japanese Auto Parts Export Agent',
    productLine: 'auto_parts',
    date: '2026-04-05',
    quality: 'BAD',
    businessValue: null,
    country: 'Unknown',
    buyerType: 'other',
    intent: 'other',
    productName: null,
  });
});
