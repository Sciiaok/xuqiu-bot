import { NextResponse } from 'next/server';
import { anthropic, MODELS } from '../../../../src/llm-client.js';
import { generateEmbedding, translateWithGlossary, detectLanguage } from '../../../../src/kb-search.service.js';
import supabase from '../../../../lib/supabase.js';

/**
 * POST /api/knowledge/teach
 * Conversational knowledge input — user tells AI business info in natural language,
 * AI extracts structured knowledge and stores it after confirmation.
 *
 * Body: { agent_id, message, session_id }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { agent_id, message, session_id } = body;

    if (!agent_id || !message) {
      return NextResponse.json({ error: 'agent_id and message are required' }, { status: 400 });
    }

    // Step 1: Use LLM to extract knowledge from the message
    const response = await anthropic.messages.create({
      model: MODELS.SONNET,
      max_tokens: 2000,
      system: `You are a knowledge extraction assistant for a B2B export company. The user is telling you business information in natural language. Extract discrete knowledge points and classify them.

Output as JSON:
{
  "reply": "A friendly confirmation message in the same language as the user, listing what you extracted and how the AI agent will use it",
  "extracted_knowledge": [
    {
      "content": "the knowledge point in original language",
      "content_en": "English translation of the knowledge point",
      "layer": "company | product | logistics | compliance | sales | competitive",
      "metadata": {
        "topic": "brief keyword",
        "sku": "if applicable",
        "price_usd": null or number,
        "country": "if applicable"
      },
      "confidence": 0.0-1.0
    }
  ]
}`,
      messages: [{ role: 'user', content: message }],
    });

    const text = response.content[0]?.text || '{}';
    let parsed;
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      return NextResponse.json({
        reply: 'Sorry, I could not parse your input. Please try rephrasing.',
        extracted_knowledge: [],
        needs_confirmation: false,
      });
    }

    // Step 2: Store as drafts (status='draft') pending confirmation
    const draftIds = [];
    for (const kp of (parsed.extracted_knowledge || [])) {
      const sourceLang = detectLanguage(kp.content);
      let contentEn = kp.content_en || kp.content;
      if (sourceLang !== 'en' && !kp.content_en) {
        contentEn = await translateWithGlossary(kp.content, agent_id);
      }

      const embedding = await generateEmbedding(contentEn);

      const { data, error } = await supabase
        .from('kb_knowledge_points')
        .insert({
          agent_id,
          layer: kp.layer || 'company',
          content_original: kp.content,
          content_en: contentEn,
          source_lang: sourceLang,
          metadata_json: kp.metadata || {},
          source_location: 'conversational input',
          authority_level: 3,
          effective_date: new Date().toISOString().split('T')[0],
          status: 'draft',
          embedding_en: embedding,
          embedding_original: sourceLang !== 'en' ? await generateEmbedding(kp.content) : embedding,
        })
        .select('id')
        .single();

      if (!error && data) draftIds.push(data.id);
    }

    return NextResponse.json({
      reply: parsed.reply || 'Knowledge extracted successfully.',
      extracted_knowledge: parsed.extracted_knowledge || [],
      draft_ids: draftIds,
      needs_confirmation: draftIds.length > 0,
    });
  } catch (error) {
    console.error('[knowledge/teach] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PUT /api/knowledge/teach
 * Confirm or reject draft knowledge points.
 * Body: { draft_ids: ["uuid", ...], confirmed: true/false }
 */
export async function PUT(request) {
  try {
    const body = await request.json();
    const { draft_ids, confirmed } = body;

    if (!draft_ids || !Array.isArray(draft_ids) || draft_ids.length === 0) {
      return NextResponse.json({ error: 'draft_ids array is required' }, { status: 400 });
    }

    if (confirmed) {
      // Activate the drafts
      const { error } = await supabase
        .from('kb_knowledge_points')
        .update({ status: 'active' })
        .in('id', draft_ids)
        .eq('status', 'draft');

      if (error) throw error;
      return NextResponse.json({ success: true, activated: draft_ids.length });
    } else {
      // Delete rejected drafts
      const { error } = await supabase
        .from('kb_knowledge_points')
        .delete()
        .in('id', draft_ids)
        .eq('status', 'draft');

      if (error) throw error;
      return NextResponse.json({ success: true, deleted: draft_ids.length });
    }
  } catch (error) {
    console.error('[knowledge/teach] PUT error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
