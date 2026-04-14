import { NextResponse } from 'next/server';
import { demoGuard } from '../../../lib/demo-mode.js';
import { createClient } from '../../../lib/supabase-server.js';
import { getAllAgentsWithStats, createAgent } from '../../../lib/repositories/agent.repository.js';

/**
 * GET /api/agents - List all agents
 */
export async function GET(request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get('active') === 'true';
    const agents = await getAllAgentsWithStats(activeOnly);

    return NextResponse.json({ agents });
  } catch (error) {
    console.error('Error listing agents:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/agents - Create a new agent
 */
export async function POST(request) {
  const demoResponse = demoGuard({ agent: { id: 'demo', name: 'Demo Agent' } }, 201);
  if (demoResponse) return demoResponse;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      name,
      productLine,
      systemPrompt,
      outputSchema,
      qualificationConfig,
      adContextMap,
    } = body;

    if (!name || !productLine || !systemPrompt) {
      return NextResponse.json(
        { error: 'name, productLine, and systemPrompt are required' },
        { status: 400 }
      );
    }

    const agent = await createAgent({
      name,
      productLine,
      systemPrompt,
      outputSchema: outputSchema || {},
      qualificationConfig: qualificationConfig || {},
      adContextMap: adContextMap || {},
    });

    return NextResponse.json({ agent }, { status: 201 });
  } catch (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'An agent with this product_line already exists' },
        { status: 409 }
      );
    }
    console.error('Error creating agent:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
