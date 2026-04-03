import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';

/**
 * GET /api/knowledge/glossary?agent_id=xxx
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');

    if (!agentId) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('kb_glossary')
      .select('*')
      .eq('agent_id', agentId)
      .order('term_zh');

    if (error) throw error;
    return NextResponse.json({ glossary: data || [] });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/knowledge/glossary
 * Body: { agent_id, term_zh, term_en, context }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { agent_id, term_zh, term_en, context } = body;

    if (!agent_id || !term_zh || !term_en) {
      return NextResponse.json({ error: 'agent_id, term_zh, and term_en are required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('kb_glossary')
      .insert({ agent_id, term_zh, term_en, context: context || null })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PUT /api/knowledge/glossary
 * Body: { id, term_zh, term_en, context }
 */
export async function PUT(request) {
  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('kb_glossary')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/knowledge/glossary
 * Body: { id }
 */
export async function DELETE(request) {
  try {
    const { id } = await request.json();
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const { error } = await supabase.from('kb_glossary').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
