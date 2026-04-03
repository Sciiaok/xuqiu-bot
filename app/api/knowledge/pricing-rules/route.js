import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';

/**
 * GET /api/knowledge/pricing-rules?agent_id=xxx
 * List all pricing rules for an agent.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');

    if (!agentId) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('kb_pricing_rules')
      .select('*')
      .eq('agent_id', agentId)
      .order('priority', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ rules: data || [] });
  } catch (error) {
    console.error('[knowledge/pricing-rules] GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/knowledge/pricing-rules
 * Create a new pricing rule.
 *
 * Body: {
 *   agent_id, rule_name, rule_type, priority, conditions, calculation,
 *   requires_approval, effective_from, effective_until
 * }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { agent_id, rule_name, rule_type, priority, conditions, calculation, requires_approval, effective_from, effective_until } = body;

    if (!agent_id || !rule_name || !rule_type || !calculation) {
      return NextResponse.json(
        { error: 'agent_id, rule_name, rule_type, and calculation are required' },
        { status: 400 }
      );
    }

    const validTypes = ['quantity_discount', 'shipping_markup', 'payment_term', 'special_offer'];
    if (!validTypes.includes(rule_type)) {
      return NextResponse.json(
        { error: `rule_type must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('kb_pricing_rules')
      .insert({
        agent_id,
        rule_name,
        rule_type,
        priority: priority || 0,
        conditions: conditions || {},
        calculation,
        requires_approval: requires_approval || false,
        effective_from: effective_from || null,
        effective_until: effective_until || null,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('[knowledge/pricing-rules] POST error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PUT /api/knowledge/pricing-rules
 * Update an existing pricing rule.
 * Body: { id, ...fields_to_update }
 */
export async function PUT(request) {
  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('kb_pricing_rules')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data);
  } catch (error) {
    console.error('[knowledge/pricing-rules] PUT error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/knowledge/pricing-rules
 * Delete a pricing rule.
 * Body: { id }
 */
export async function DELETE(request) {
  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('kb_pricing_rules')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[knowledge/pricing-rules] DELETE error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
