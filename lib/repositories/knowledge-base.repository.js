import supabase from '../supabase.js';

/**
 * Knowledge Base repository.
 *
 * 所有 kb_* 表查询按 (tenant_id, product_line_id) 索引。老 agent_id 列还在但
 * 不读，落库时由 trigger 自动填 product_line_id（见 2026-04-28-kb-tables-add-
 * product-line-id.sql）。
 *
 * Four-layer taxonomy: company | product | logistics | sales.
 *
 * 旧的六层（含 compliance / competitive）已并入：compliance → company，
 * competitive → sales。CHECK 约束沿用旧六层值以兼容历史数据，应用层只放行四层。
 */

export const LAYERS = ['company', 'product', 'logistics', 'sales'];

export const LAYER_LABELS = {
  company: '公司基础信息',
  product: '产品与价格',
  logistics: '物流与交付',
  sales: '销售话术与流程',
};

/* ── Documents ────────────────────────────────────────── */

export async function getDocumentsByProductLine({ tenantId, productLineId }) {
  if (!tenantId || !productLineId) throw new Error('getDocumentsByProductLine: tenantId+productLineId required');
  const { data, error } = await supabase
    .from('kb_documents')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
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

export async function getReadyDocumentsByProductLine({ tenantId, productLineId }) {
  const { data, error } = await supabase
    .from('kb_documents')
    .select('layer, status')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId);
  if (error) throw error;
  return data || [];
}

export async function getOutdatedDocuments({ tenantId, productLineId, olderThanDays = 30 }) {
  const threshold = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('kb_documents')
    .select('id, filename, layer, updated_at')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
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

export async function getActiveKnowledgePointsByProductLine({ tenantId, productLineId }) {
  const { data, error } = await supabase
    .from('kb_knowledge_points')
    .select('layer')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('status', 'active');
  if (error) throw error;
  return data || [];
}

/* ── Products ─────────────────────────────────────────── */

export async function countActiveProducts({ tenantId, productLineId }) {
  const { count, error } = await supabase
    .from('kb_products')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('is_active', true);
  if (error) throw error;
  return count || 0;
}

/* ── Gaps ─────────────────────────────────────────────── */

export async function getGapsByProductLine({ tenantId, productLineId, status = 'open', limit = 100 }) {
  const { data, error } = await supabase
    .from('kb_knowledge_gaps')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
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
 * Aggregate KB health metrics for one product line: per-layer coverage, total
 * documents/points/products, outdated docs.
 */
export async function getHealthSummary({ tenantId, productLineId }) {
  const [docs, points, productCount, outdatedDocs] = await Promise.all([
    getReadyDocumentsByProductLine({ tenantId, productLineId }),
    getActiveKnowledgePointsByProductLine({ tenantId, productLineId }),
    countActiveProducts({ tenantId, productLineId }),
    getOutdatedDocuments({ tenantId, productLineId }),
  ]);

  const layers = {};
  let totalPoints = 0;
  let coveredLayers = 0;

  for (const layer of LAYERS) {
    const layerDocs = docs.filter((d) => d.layer === layer && d.status === 'ready');
    const layerPoints = points.filter((p) => p.layer === layer);
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
    total_documents: docs.filter((d) => d.status === 'ready').length,
    total_knowledge_points: totalPoints,
    total_products: productCount,
    layers,
    outdated_docs: outdatedDocs.map((d) => ({
      doc_id: d.id,
      filename: d.filename,
      layer: d.layer,
      days_since_update: Math.floor((Date.now() - new Date(d.updated_at)) / (1000 * 60 * 60 * 24)),
    })),
  };
}
