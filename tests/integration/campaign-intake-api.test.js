import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Track created brief IDs for cleanup
const createdBriefIds = [];

after(async () => {
  // Cleanup: delete all test briefs (cascade deletes messages)
  for (const id of createdBriefIds) {
    await supabase.from('campaign_briefs').delete().eq('id', id);
  }
});

describe('campaign_briefs table', () => {
  it('creates a brief with default values', async () => {
    const { data, error } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();

    assert.equal(error, null);
    assert.ok(data.id);
    assert.equal(data.status, 'draft');
    assert.deepStrictEqual(data.brief, {});
    assert.deepStrictEqual(data.completion, {});
    assert.equal(data.expires_at, null);
    assert.ok(data.created_at);
    assert.ok(data.updated_at);

    createdBriefIds.push(data.id);
  });

  it('creates a brief with custom UUID', async () => {
    const customId = '00000000-0000-4000-a000-000000000001';
    const { data, error } = await supabase
      .from('campaign_briefs')
      .insert({ id: customId })
      .select()
      .single();

    assert.equal(error, null);
    assert.equal(data.id, customId);
    createdBriefIds.push(data.id);
  });

  it('enforces status CHECK constraint', async () => {
    const { error } = await supabase
      .from('campaign_briefs')
      .insert({ status: 'invalid_status' });

    assert.ok(error);
    assert.ok(error.message.includes('check') || error.code === '23514');
  });

  it('updates brief JSONB fields', async () => {
    const { data: created } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(created.id);

    const briefData = {
      company_name: 'Test Corp',
      industry: '农业机械',
      products: [{ name: 'Tractor X100', category: '拖拉机' }],
    };

    const { data, error } = await supabase
      .from('campaign_briefs')
      .update({ brief: briefData, status: 'collecting' })
      .eq('id', created.id)
      .select()
      .single();

    assert.equal(error, null);
    assert.equal(data.status, 'collecting');
    assert.equal(data.brief.company_name, 'Test Corp');
    assert.equal(data.brief.products.length, 1);
  });

  it('updates updated_at automatically via trigger', async () => {
    const { data: created } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(created.id);

    // Wait a moment to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 100));

    const { data: updated } = await supabase
      .from('campaign_briefs')
      .update({ status: 'collecting' })
      .eq('id', created.id)
      .select()
      .single();

    assert.ok(new Date(updated.updated_at) > new Date(created.updated_at));
  });
});

describe('campaign_messages table', () => {
  it('creates a user message', async () => {
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    const { data, error } = await supabase
      .from('campaign_messages')
      .insert({
        brief_id: brief.id,
        role: 'user',
        content: '我想投放农机广告',
        message_index: 0,
      })
      .select()
      .single();

    assert.equal(error, null);
    assert.equal(data.role, 'user');
    assert.equal(data.content, '我想投放农机广告');
    assert.equal(data.message_index, 0);
  });

  it('creates an assistant message with tool_use fields', async () => {
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    const { data, error } = await supabase
      .from('campaign_messages')
      .insert({
        brief_id: brief.id,
        role: 'assistant',
        content: 'Let me extract that info.',
        tool_name: 'update_brief',
        tool_use_id: 'toolu_123',
        tool_input: { fields: { company_name: 'Test' } },
        message_index: 1,
      })
      .select()
      .single();

    assert.equal(error, null);
    assert.equal(data.tool_name, 'update_brief');
    assert.equal(data.tool_use_id, 'toolu_123');
    assert.deepStrictEqual(data.tool_input, { fields: { company_name: 'Test' } });
  });

  it('creates a tool result message (content can be null)', async () => {
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    const { data, error } = await supabase
      .from('campaign_messages')
      .insert({
        brief_id: brief.id,
        role: 'tool',
        tool_name: 'update_brief',
        tool_use_id: 'toolu_123',
        tool_result: { brief: { company_name: 'Test' }, is_complete: false },
        message_index: 2,
      })
      .select()
      .single();

    assert.equal(error, null);
    assert.equal(data.role, 'tool');
    assert.equal(data.content, null);
    assert.ok(data.tool_result.brief);
  });

  it('enforces role CHECK constraint', async () => {
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    const { error } = await supabase
      .from('campaign_messages')
      .insert({
        brief_id: brief.id,
        role: 'system',
        content: 'test',
        message_index: 0,
      });

    assert.ok(error);
  });

  it('enforces content NOT NULL for non-tool roles', async () => {
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    const { error } = await supabase
      .from('campaign_messages')
      .insert({
        brief_id: brief.id,
        role: 'user',
        content: null,
        message_index: 0,
      });

    assert.ok(error);
  });

  it('cascades delete when brief is deleted', async () => {
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();

    // Create messages
    await supabase.from('campaign_messages').insert([
      { brief_id: brief.id, role: 'user', content: 'msg1', message_index: 0 },
      { brief_id: brief.id, role: 'assistant', content: 'msg2', message_index: 1 },
    ]);

    // Delete brief
    await supabase.from('campaign_briefs').delete().eq('id', brief.id);

    // Verify messages are gone
    const { data: messages } = await supabase
      .from('campaign_messages')
      .select('id')
      .eq('brief_id', brief.id);

    assert.equal(messages.length, 0);
    // No need to track for cleanup — already deleted
  });

  it('returns messages ordered by message_index', async () => {
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    await supabase.from('campaign_messages').insert([
      { brief_id: brief.id, role: 'assistant', content: 'second', message_index: 1 },
      { brief_id: brief.id, role: 'user', content: 'first', message_index: 0 },
      { brief_id: brief.id, role: 'user', content: 'third', message_index: 2 },
    ]);

    const { data } = await supabase
      .from('campaign_messages')
      .select('*')
      .eq('brief_id', brief.id)
      .order('message_index', { ascending: true });

    assert.equal(data.length, 3);
    assert.equal(data[0].content, 'first');
    assert.equal(data[1].content, 'second');
    assert.equal(data[2].content, 'third');
  });
});

describe('full intake flow simulation', () => {
  it('simulates a complete brief collection lifecycle', async () => {
    // 1. Create brief
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);
    assert.equal(brief.status, 'draft');

    // 2. Start collecting — user sends first message
    await supabase.from('campaign_messages').insert({
      brief_id: brief.id,
      role: 'user',
      content: '我是XX农机公司，想在非洲投放拖拉机广告',
      message_index: 0,
    });

    // 3. Agent extracts info and updates brief
    const partialBrief = {
      company_name: 'XX农机',
      industry: '农业机械',
      products: [{ name: '拖拉机', category: '拖拉机' }],
      target_countries: ['Kenya', 'Tanzania', 'Nigeria'],
    };

    await supabase
      .from('campaign_briefs')
      .update({
        status: 'collecting',
        brief: partialBrief,
        completion: {
          filled: ['company_name', 'industry', 'products', 'target_countries'],
          missing: ['target_audience', 'budget_total', 'budget_currency', 'campaign_duration_days', 'objectives', 'preferred_platforms'],
          completion_pct: 40,
        },
      })
      .eq('id', brief.id);

    // 4. More conversation — agent recommends defaults, user confirms
    await supabase.from('campaign_messages').insert([
      { brief_id: brief.id, role: 'assistant', content: '建议预算$5000，投放Meta+Google，周期30天', message_index: 1 },
      { brief_id: brief.id, role: 'user', content: '可以，就按这个来', message_index: 2 },
    ]);

    // 5. Complete the brief
    const completeBrief = {
      ...partialBrief,
      target_audience: { age_range: [25, 55], gender: 'male', interests: ['agriculture', 'farming'] },
      budget_total: 5000,
      budget_currency: 'USD',
      campaign_duration_days: 30,
      objectives: ['lead_gen'],
      preferred_platforms: ['meta', 'google'],
    };

    await supabase
      .from('campaign_briefs')
      .update({
        status: 'completed',
        brief: completeBrief,
        completion: {
          filled: ['company_name', 'industry', 'products', 'target_countries', 'target_audience', 'budget_total', 'budget_currency', 'campaign_duration_days', 'objectives', 'preferred_platforms'],
          missing: [],
          completion_pct: 100,
        },
      })
      .eq('id', brief.id);

    // 6. Verify final state
    const { data: finalBrief } = await supabase
      .from('campaign_briefs')
      .select('*')
      .eq('id', brief.id)
      .single();

    assert.equal(finalBrief.status, 'completed');
    assert.equal(finalBrief.brief.company_name, 'XX农机');
    assert.equal(finalBrief.brief.budget_total, 5000);
    assert.equal(finalBrief.completion.completion_pct, 100);
    assert.equal(finalBrief.completion.missing.length, 0);

    const { data: allMessages } = await supabase
      .from('campaign_messages')
      .select('*')
      .eq('brief_id', brief.id)
      .order('message_index');

    assert.equal(allMessages.length, 3);
  });
});
