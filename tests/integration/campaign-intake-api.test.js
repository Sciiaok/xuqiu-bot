import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Track created IDs for cleanup
const createdBriefIds = [];
const createdSessionIds = [];

after(async () => {
  for (const id of createdSessionIds) {
    await supabase.from('orchestrator_sessions').delete().eq('id', id);
  }
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
  });

  it('updates updated_at automatically via trigger', async () => {
    const { data: created } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(created.id);

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

describe('orchestrator_messages with intake phase', () => {
  it('stores intake messages via orchestrator_sessions', async () => {
    // Create brief → session → messages
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    const { data: session } = await supabase
      .from('orchestrator_sessions')
      .insert({ brief_id: brief.id })
      .select()
      .single();
    createdSessionIds.push(session.id);

    // Insert intake messages
    const { data: msgs, error } = await supabase
      .from('orchestrator_messages')
      .insert([
        { session_id: session.id, phase: 'intake', role: 'user', content: '我想投放广告', message_index: 0 },
        { session_id: session.id, phase: 'intake', role: 'assistant', content: null, tool_name: 'update_brief', tool_use_id: 'tu_1', tool_input: { fields: { industry: '农机' } }, message_index: 1 },
        { session_id: session.id, phase: 'intake', role: 'tool', content: null, tool_use_id: 'tu_1', tool_result: { brief: { industry: '农机' } }, message_index: 2 },
        { session_id: session.id, phase: 'intake', role: 'assistant', content: '好的，已记录', message_index: 3 },
      ])
      .select();

    assert.equal(error, null);
    assert.equal(msgs.length, 4);
  });

  it('filters messages by phase', async () => {
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    const { data: session } = await supabase
      .from('orchestrator_sessions')
      .insert({ brief_id: brief.id })
      .select()
      .single();
    createdSessionIds.push(session.id);

    await supabase.from('orchestrator_messages').insert([
      { session_id: session.id, phase: 'intake', role: 'user', content: 'intake msg', message_index: 0 },
      { session_id: session.id, phase: null, role: 'user', content: 'orchestrator msg', message_index: 1 },
    ]);

    // Filter by intake phase
    const { data: intakeMsgs } = await supabase
      .from('orchestrator_messages')
      .select('*')
      .eq('session_id', session.id)
      .eq('phase', 'intake');

    assert.equal(intakeMsgs.length, 1);
    assert.equal(intakeMsgs[0].content, 'intake msg');

    // Filter by null phase (orchestrator)
    const { data: orchMsgs } = await supabase
      .from('orchestrator_messages')
      .select('*')
      .eq('session_id', session.id)
      .is('phase', null);

    assert.equal(orchMsgs.length, 1);
    assert.equal(orchMsgs[0].content, 'orchestrator msg');
  });

  it('cascades delete from session to messages', async () => {
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    const { data: session } = await supabase
      .from('orchestrator_sessions')
      .insert({ brief_id: brief.id })
      .select()
      .single();

    await supabase.from('orchestrator_messages').insert([
      { session_id: session.id, phase: 'intake', role: 'user', content: 'test', message_index: 0 },
    ]);

    // Delete session
    await supabase.from('orchestrator_sessions').delete().eq('id', session.id);

    const { data: remaining } = await supabase
      .from('orchestrator_messages')
      .select('id')
      .eq('session_id', session.id);

    assert.equal(remaining.length, 0);
  });
});

describe('full intake flow with orchestrator', () => {
  it('simulates brief → session → intake messages → completed', async () => {
    // 1. Create brief
    const { data: brief } = await supabase
      .from('campaign_briefs')
      .insert({})
      .select()
      .single();
    createdBriefIds.push(brief.id);

    // 2. Create orchestrator session
    const { data: session } = await supabase
      .from('orchestrator_sessions')
      .insert({ brief_id: brief.id })
      .select()
      .single();
    createdSessionIds.push(session.id);

    // 3. Intake conversation
    await supabase.from('orchestrator_messages').insert([
      { session_id: session.id, phase: 'intake', role: 'user', content: '我是XX农机，想投放非洲市场', message_index: 0 },
      { session_id: session.id, phase: 'intake', role: 'assistant', content: '好的，已记录信息', message_index: 1 },
    ]);

    // 4. Update brief
    const completeBrief = {
      company_name: 'XX农机',
      industry: '农业机械',
      products: [{ name: '拖拉机' }],
      target_countries: ['Kenya'],
      target_audience: { age_range: [25, 55], gender: 'male', interests: ['agriculture'] },
      budget_total: 5000,
      budget_currency: 'USD',
      campaign_duration_days: 30,
      objectives: ['lead_gen'],
      preferred_platforms: ['meta', 'google'],
    };

    await supabase
      .from('campaign_briefs')
      .update({ status: 'completed', brief: completeBrief, completion: { filled: Object.keys(completeBrief), missing: [], completion_pct: 100 } })
      .eq('id', brief.id);

    // 5. Verify
    const { data: finalBrief } = await supabase
      .from('campaign_briefs')
      .select('*')
      .eq('id', brief.id)
      .single();

    assert.equal(finalBrief.status, 'completed');
    assert.equal(finalBrief.brief.company_name, 'XX农机');
    assert.equal(finalBrief.completion.completion_pct, 100);

    const { data: allMsgs } = await supabase
      .from('orchestrator_messages')
      .select('*')
      .eq('session_id', session.id)
      .eq('phase', 'intake')
      .order('message_index');

    assert.equal(allMsgs.length, 2);
  });
});
