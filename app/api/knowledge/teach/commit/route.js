import { NextResponse } from 'next/server';
import { generateEmbedding, translateToEnglish, detectLanguage } from '../../../../../src/kb-search.service.js';
import supabase from '../../../../../lib/supabase.js';
import { getTenantContext, findAgentInTenant } from '../../../../../lib/tenant-context.js';

const VALID_LAYERS = new Set(['company', 'product', 'logistics', 'sales']);

/**
 * POST /api/knowledge/teach/commit
 *
 * Persist user-confirmed knowledge points (after they reviewed the LLM's
 * extraction from /api/knowledge/teach). Generates embeddings and inserts
 * into kb_knowledge_points.
 *
 * Body:  { agent_id, items: [{ content, content_en?, layer, metadata? }] }
 * Reply: { inserted_count }
 */
export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { agent_id, items } = body;

    if (!agent_id || !Array.isArray(items)) {
      return NextResponse.json({ error: 'agent_id and items[] are required' }, { status: 400 });
    }
    if (items.length === 0) {
      return NextResponse.json({ inserted_count: 0 });
    }

    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId: agent_id });
    if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    let insertedCount = 0;
    const errors = [];
    for (const kp of items) {
      const content = String(kp.content || '').trim();
      if (!content) { errors.push('empty content'); continue; }
      const layer = VALID_LAYERS.has(kp.layer) ? kp.layer : 'company';

      const sourceLang = detectLanguage(content);
      const contentEn = (kp.content_en && String(kp.content_en).trim())
        || (sourceLang !== 'en' ? await translateToEnglish(content, ctx.tenantId) : content);

      const embeddingEn = await generateEmbedding(contentEn);
      const embeddingOrig = sourceLang !== 'en' ? await generateEmbedding(content) : embeddingEn;

      const { error } = await supabase
        .from('kb_knowledge_points')
        .insert({
          tenant_id: ctx.tenantId,
          agent_id,
          product_line_id: agent.product_line,
          layer,
          content_original: content,
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

      if (error) errors.push(error.message);
      else insertedCount++;
    }

    return NextResponse.json({ inserted_count: insertedCount, errors });
  } catch (error) {
    console.error('[knowledge/teach/commit] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
