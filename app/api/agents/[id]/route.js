import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { createClient } from '../../../../lib/supabase-server.js';
import {
  findAgentByIdWithStats,
  updateAgent,
  deactivateAgent,
} from '../../../../lib/repositories/agent.repository.js';

/**
 * GET /api/agents/[id] - Get agent by ID
 */
export async function GET(request, { params }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const agent = await findAgentByIdWithStats(id);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json({ agent });
  } catch (error) {
    console.error('Error getting agent:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PUT /api/agents/[id] - Update agent
 */
export async function PUT(request, { params }) {
  const demoResponse = demoGuard({ agent: { id: 'demo' } });
  if (demoResponse) return demoResponse;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();

    const agent = await updateAgent(id, body);
    return NextResponse.json({ agent });
  } catch (error) {
    console.error('Error updating agent:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[id] - Deactivate agent (soft delete)
 */
export async function DELETE(request, { params }) {
  const demoResponse = demoGuard({ agent: { id: 'demo' } });
  if (demoResponse) return demoResponse;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const agent = await deactivateAgent(id);
    return NextResponse.json({ agent });
  } catch (error) {
    // Handle "last active agent" error
    if (error.message?.includes('last active agent')) {
      return NextResponse.json(
        { error: 'Cannot deactivate the last active agent' },
        { status: 409 }
      );
    }
    console.error('Error deactivating agent:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
