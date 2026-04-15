import supabase from '../supabase.js';

/**
 * Knowledge Base repository — mirrors the pattern of agent.repository.js.
 *
 * All KB data belongs to exactly one agent (every kb_* table has `agent_id` FK).
 * Keep all Supabase calls for kb_* tables in this file; route handlers should
 * delegate here rather than calling supabase.from('kb_*') directly.
 *
 * Six-layer taxonomy: company | product | logistics | compliance | sales | competitive.
 */

export const LAYERS = ['company', 'product', 'logistics', 'compliance', 'sales', 'competitive'];

export const LAYER_LABELS = {
  company: '公司基础信息',
  product: '产品与价格',
  logistics: '物流与交付',
  compliance: '合规与认证',
  sales: '销售话术与流程',
  competitive: '竞品情报',
};

/* ── Documents ────────────────────────────────────────── */

export async function getDocumentsByAgent(agentId) {
  const { data, error } = await supabase
    .from('kb_documents')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getDocumentById(docId) {
  const { data, error } = await supabase
    .from('kb_documents')
    .select('*')
    .eq('id', docId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function getReadyDocumentsByAgent(agentId) {
  const { data, error } = await supabase
    .from('kb_documents')
    .select('layer, status')
    .eq('agent_id', agentId);
  if (error) throw error;
  return data || [];
}

export async function getOutdatedDocuments(agentId, { olderThanDays = 30 } = {}) {
  const threshold = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('kb_documents')
    .select('id, filename, layer, updated_at')
    .eq('agent_id', agentId)
    .eq('status', 'ready')
    .lt('updated_at', threshold);
  if (error) throw error;
  return data || [];
}

export async function deleteDocumentById(docId) {
  // Caller is responsible for storage cleanup before/after.
  const { error } = await supabase
    .from('kb_documents')
    .delete()
    .eq('id', docId);
  if (error) throw error;
}

/* ── Knowledge Points ─────────────────────────────────── */

export async function getActiveKnowledgePointsByAgent(agentId) {
  const { data, error } = await supabase
    .from('kb_knowledge_points')
    .select('layer')
    .eq('agent_id', agentId)
    .eq('status', 'active');
  if (error) throw error;
  return data || [];
}

export async function countDraftKnowledgePoints(agentId) {
  const { count, error } = await supabase
    .from('kb_knowledge_points')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('status', 'draft');
  if (error) throw error;
  return count || 0;
}

/* ── Products / Pricing / Glossary ────────────────────── */

export async function countActiveProducts(agentId) {
  const { count, error } = await supabase
    .from('kb_products')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('is_active', true);
  if (error) throw error;
  return count || 0;
}

export async function countActivePricingRules(agentId) {
  const { count, error } = await supabase
    .from('kb_pricing_rules')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('is_active', true);
  if (error) throw error;
  return count || 0;
}

export async function countGlossaryTerms(agentId) {
  const { count, error } = await supabase
    .from('kb_glossary')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);
  if (error) throw error;
  return count || 0;
}

/* ── Gaps ─────────────────────────────────────────────── */

export async function getGapsByAgent(agentId, { status = 'open', limit = 100 } = {}) {
  const { data, error } = await supabase
    .from('kb_knowledge_gaps')
    .select('*')
    .eq('agent_id', agentId)
    .eq('status', status)
    .order('occurrence_count', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function updateGap(gapId, updates) {
  const { error } = await supabase
    .from('kb_knowledge_gaps')
    .update(updates)
    .eq('id', gapId);
  if (error) throw error;
}

/* ── Health Summary ───────────────────────────────────── */

/**
 * Aggregate KB health metrics for one agent: counts by layer, draft backlog,
 * outdated docs, totals. UI-facing shape matches the legacy /api/knowledge/health
 * response so no frontend change is needed.
 */
export async function getHealthSummary(agentId) {
  const [
    docs,
    points,
    draftCount,
    productCount,
    pricingRulesCount,
    glossaryCount,
    outdatedDocs,
  ] = await Promise.all([
    getReadyDocumentsByAgent(agentId),
    getActiveKnowledgePointsByAgent(agentId),
    countDraftKnowledgePoints(agentId),
    countActiveProducts(agentId),
    countActivePricingRules(agentId),
    countGlossaryTerms(agentId),
    getOutdatedDocuments(agentId),
  ]);

  // Per-layer health buckets
  const layers = {};
  let totalPoints = 0;
  let coveredLayers = 0;

  for (const layer of LAYERS) {
    const layerDocs = docs.filter(d => d.layer === layer && d.status === 'ready');
    const layerPoints = points.filter(p => p.layer === layer);
    const docCount = layerDocs.length;
    const pointCount = layerPoints.length;
    totalPoints += pointCount;

    let coverage = 0;
    if (pointCount > 50) coverage = 90;
    else if (pointCount > 20) coverage = 70;
    else if (pointCount > 5) coverage = 50;
    else if (pointCount > 0) coverage = 25;

    let status = 'error';
    if (coverage >= 70) status = 'good';
    else if (coverage > 0) status = 'warn';

    if (coverage > 0) coveredLayers++;

    layers[layer] = {
      label: LAYER_LABELS[layer],
      coverage,
      docs: docCount,
      points: pointCount,
      status,
    };
  }

  const overallCoverage = Math.round((coveredLayers / LAYERS.length) * 100);

  return {
    overall_coverage: overallCoverage,
    total_documents: docs.filter(d => d.status === 'ready').length,
    total_knowledge_points: totalPoints,
    total_products: productCount,
    total_pricing_rules: pricingRulesCount,
    total_glossary_terms: glossaryCount,
    pending_drafts: draftCount,
    layers,
    outdated_docs: outdatedDocs.map(d => ({
      doc_id: d.id,
      filename: d.filename,
      layer: d.layer,
      days_since_update: Math.floor((Date.now() - new Date(d.updated_at)) / (1000 * 60 * 60 * 24)),
    })),
  };
}
