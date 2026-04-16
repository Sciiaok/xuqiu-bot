import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { searchKnowledge } from '../../../../src/kb-search.service.js';
import { openrouter, MODELS } from '../../../../src/llm-client.js';

export const maxDuration = 60;

/**
 * POST /api/knowledge/test-chat
 * Send a message in a test chat session. Creates a new session if session_id is not provided.
 * Body: { agent_id, session_id?, message }
 */
export async function POST(request) {
  try {
    const { agent_id, session_id, message } = await request.json();

    if (!agent_id || !message) {
      return NextResponse.json({ error: 'agent_id and message are required' }, { status: 400 });
    }

    // Get or create session
    let sessionId = session_id;
    if (!sessionId) {
      const title = message.slice(0, 50) + (message.length > 50 ? '…' : '');
      const { data: session, error } = await supabase
        .from('kb_test_sessions')
        .insert({ agent_id, title })
        .select('id')
        .single();
      if (error) throw new Error(`Failed to create session: ${error.message}`);
      sessionId = session.id;
    }

    // Save user message
    await supabase.from('kb_test_messages').insert({
      session_id: sessionId,
      role: 'user',
      content: message,
    });

    // Get conversation history for context
    const { data: history } = await supabase
      .from('kb_test_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(20);

    // Search knowledge base
    const conversationHistory = (history || []).slice(0, -1).map(m => ({
      role: m.role,
      content: m.content,
    }));

    const searchResult = await searchKnowledge(agent_id, message, {
      conversationHistory,
      limit: 5,
    });

    // Build context from search results
    const kbContext = (searchResult.results || [])
      .map((r, i) => `[${i + 1}] (${r.layer}${r.score ? `, score: ${r.score.toFixed(2)}` : ''}) ${r.content_en || r.content_original}`)
      .join('\n');

    // Generate response using LLM
    const systemPrompt = `You are a knowledge base testing assistant. Answer the user's question based ONLY on the provided knowledge base context. If the context doesn't contain enough information, clearly state what's missing.

Knowledge Base Context:
${kbContext || '(No relevant knowledge found)'}

Rules:
- Answer in the same language as the user's question
- Cite sources using [1], [2] etc.
- If no relevant knowledge is found, say so explicitly and suggest what knowledge should be added
- Be concise and accurate`;

    const messages = [
      ...conversationHistory.slice(-6),
      { role: 'user', content: message },
    ];

    const llmResponse = await openrouter.messages.create({
      models: [MODELS.SONNET],
      max_tokens: 2000,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    });

    const assistantContent = llmResponse.choices[0].message.content || 'No response generated.';

    // Detect knowledge gap if no results found
    if (!searchResult.results?.length || searchResult.results.every(r => (r.score || 0) < 0.5)) {
      // Record knowledge gap
      const { data: existingGap } = await supabase
        .from('kb_knowledge_gaps')
        .select('id, occurrence_count')
        .eq('agent_id', agent_id)
        .eq('query', message)
        .eq('status', 'open')
        .single();

      if (existingGap) {
        await supabase.from('kb_knowledge_gaps')
          .update({
            occurrence_count: existingGap.occurrence_count + 1,
            last_occurred_at: new Date().toISOString(),
          })
          .eq('id', existingGap.id);
      } else {
        await supabase.from('kb_knowledge_gaps').insert({
          agent_id,
          query: message,
          layer: searchResult.intent?.layer || null,
          gap_type: searchResult.results?.length ? 'low_confidence' : 'no_result',
        });
      }
    }

    // Save assistant message
    const sources = (searchResult.results || []).map(r => ({
      layer: r.layer,
      content: (r.content_original || r.content_en || '').slice(0, 200),
      score: r.score,
      doc_id: r.doc_id,
    }));

    await supabase.from('kb_test_messages').insert({
      session_id: sessionId,
      role: 'assistant',
      content: assistantContent,
      sources: sources.length ? sources : null,
      search_meta: {
        intent: searchResult.intent || null,
        rewritten_query: searchResult.rewritten_query || null,
        result_count: searchResult.results?.length || 0,
      },
    });

    // Update session
    await supabase.from('kb_test_sessions')
      .update({
        message_count: (history?.length || 0) + 2,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId);

    return NextResponse.json({
      session_id: sessionId,
      reply: assistantContent,
      sources,
      search_meta: {
        intent: searchResult.intent || null,
        rewritten_query: searchResult.rewritten_query || null,
        result_count: searchResult.results?.length || 0,
      },
    });
  } catch (error) {
    console.error('[knowledge/test-chat] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
