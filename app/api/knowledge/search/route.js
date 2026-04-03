import { NextResponse } from 'next/server';
import { searchKnowledge } from '../../../../src/kb-search.service.js';

export async function POST(request) {
  try {
    const body = await request.json();
    const { agent_id, query, layers, top_k, conversation_context, filters, sort_by, sort_order } = body;

    if (!agent_id || !query) {
      return NextResponse.json(
        { error: 'agent_id and query are required' },
        { status: 400 }
      );
    }

    const results = await searchKnowledge(agent_id, query, {
      layers: layers || null,
      topK: top_k || 5,
      conversationContext: conversation_context || null,
      filters: filters || null,
      sortBy: sort_by || null,
      sortOrder: sort_order || 'asc',
    });

    return NextResponse.json(results);
  } catch (error) {
    console.error('[knowledge/search] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
