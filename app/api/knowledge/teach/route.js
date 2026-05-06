import { NextResponse } from 'next/server';
import { openrouter, MODELS } from '../../../../src/llm-client.js';
import { generateEmbedding, translateToEnglish, detectLanguage } from '../../../../src/kb-search.service.js';
import supabase from '../../../../lib/supabase.js';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';

/**
 * POST /api/knowledge/teach
 *
 * "Conversational knowledge input" — user types business info in natural
 * language, the LLM extracts discrete knowledge points, and we insert them
 * directly as `status='active'` so `search_knowledge` picks them up on the
 * next Medici turn.
 *
 * Body:  { agent_id, message }
 * Reply: { reply, inserted_count, extracted_knowledge }
 */
export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { agent_id, message } = body;

    if (!agent_id || !message) {
      return NextResponse.json({ error: 'agent_id and message are required' }, { status: 400 });
    }
    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId: agent_id });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // 1. Ask the LLM to extract discrete knowledge points from the user's text.
    const response = await openrouter.messages.create({
      models: [MODELS.SONNET],
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: `You are a knowledge extraction assistant for a B2B export company. The user is telling you business information in natural language. Extract discrete knowledge points and classify them.

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
        },
        { role: 'user', content: message },
      ],
    }, { tenantId: ctx.tenantId, callSite: 'knowledge.teach.extract' });

    const text = response.choices[0].message.content || '{}';
    let parsed;
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      return NextResponse.json({
        reply: 'Sorry, I could not parse your input. Please try rephrasing.',
        extracted_knowledge: [],
        inserted_count: 0,
      });
    }

    const extracted = Array.isArray(parsed.extracted_knowledge) ? parsed.extracted_knowledge : [];

    // 2. Persist as active knowledge points — no draft/confirm step.
    //    Each point gets embeddings in both English and its source language so
    //    the bilingual search RPCs can hit it from either side.
    let insertedCount = 0;
    for (const kp of extracted) {
      const sourceLang = detectLanguage(kp.content);
      const contentEn = kp.content_en || (sourceLang !== 'en'
        ? await translateToEnglish(kp.content, ctx.tenantId)
        : kp.content);

      const embeddingEn = await generateEmbedding(contentEn);
      const embeddingOrig = sourceLang !== 'en' ? await generateEmbedding(kp.content) : embeddingEn;

      const { error } = await supabase
        .from('kb_knowledge_points')
        .insert({
          tenant_id: ctx.tenantId,
          agent_id,
          product_line_id: agent.product_line,
          layer: kp.layer || 'company',
          content_original: kp.content,
          content_en: contentEn,
          source_lang: sourceLang,
          metadata_json: kp.metadata || {},
          source_location: 'conversational input',
          authority_level: 3,
          effective_date: new Date().toISOString().split('T')[0],
          status: 'active',
          embedding_en: embeddingEn,
          embedding_original: embeddingOrig,
        });

      if (!error) insertedCount++;
    }

    return NextResponse.json({
      reply: parsed.reply || 'Knowledge extracted successfully.',
      extracted_knowledge: extracted,
      inserted_count: insertedCount,
    });
  } catch (error) {
    console.error('[knowledge/teach] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
