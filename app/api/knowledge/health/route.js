import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';

const LAYERS = ['company', 'product', 'logistics', 'compliance', 'sales', 'competitive'];

const LAYER_LABELS = {
  company: '公司基础信息',
  product: '产品与价格',
  logistics: '物流与交付',
  compliance: '合规与认证',
  sales: '销售话术与流程',
  competitive: '竞品情报',
};

/**
 * GET /api/knowledge/health?agent_id=xxx
 * Returns knowledge base health assessment per layer with AI recommendations.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agent_id');

    if (!agentId) {
      return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    }

    // Get document counts per layer
    const { data: docs } = await supabase
      .from('kb_documents')
      .select('layer, status')
      .eq('agent_id', agentId);

    // Get knowledge point counts per layer
    const { data: points } = await supabase
      .from('kb_knowledge_points')
      .select('layer')
      .eq('agent_id', agentId)
      .eq('status', 'active');

    // Get draft count (pending review from auto-learn or teach)
    const { count: draftCount } = await supabase
      .from('kb_knowledge_points')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .eq('status', 'draft');

    // Get product count
    const { count: productCount } = await supabase
      .from('kb_products')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .eq('is_active', true);

    // Get pricing rules count
    const { count: pricingRulesCount } = await supabase
      .from('kb_pricing_rules')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .eq('is_active', true);

    // Get glossary count
    const { count: glossaryCount } = await supabase
      .from('kb_glossary')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId);

    // Get outdated documents
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: outdatedDocs } = await supabase
      .from('kb_documents')
      .select('id, filename, layer, updated_at')
      .eq('agent_id', agentId)
      .eq('status', 'ready')
      .lt('updated_at', thirtyDaysAgo);

    // Build per-layer health
    const layers = {};
    let totalPoints = 0;
    let coveredLayers = 0;

    for (const layer of LAYERS) {
      const layerDocs = (docs || []).filter(d => d.layer === layer && d.status === 'ready');
      const layerPoints = (points || []).filter(p => p.layer === layer);
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

    // Generate AI recommendations based on health data
    const recommendations = generateRecommendations(layers, outdatedDocs, productCount, pricingRulesCount, glossaryCount);

    return NextResponse.json({
      overall_coverage: overallCoverage,
      total_documents: (docs || []).filter(d => d.status === 'ready').length,
      total_knowledge_points: totalPoints,
      total_products: productCount || 0,
      total_pricing_rules: pricingRulesCount || 0,
      total_glossary_terms: glossaryCount || 0,
      pending_drafts: draftCount || 0,
      layers,
      outdated_docs: (outdatedDocs || []).map(d => ({
        doc_id: d.id,
        filename: d.filename,
        layer: d.layer,
        days_since_update: Math.floor((Date.now() - new Date(d.updated_at)) / (1000 * 60 * 60 * 24)),
      })),
      ai_recommendations: recommendations,
    });
  } catch (error) {
    console.error('[knowledge/health] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Generate actionable recommendations based on knowledge base health.
 */
function generateRecommendations(layers, outdatedDocs, productCount, pricingRulesCount, glossaryCount) {
  const recs = [];

  // Empty layers — highest priority
  for (const [layer, data] of Object.entries(layers)) {
    if (data.status === 'error') {
      const actions = {
        company: '上传公司简介、付款条款、售后政策文档',
        product: '上传产品目录 Excel（含 SKU、型号、价格、MOQ）',
        logistics: '上传运费表（各港口运费 + 交期）',
        compliance: '上传各国进口认证要求、关税税率表',
        sales: '上传销售 SOP、异议处理话术、折扣规则',
        competitive: '上传竞品价格对比表、差异化话术',
      };
      recs.push({
        priority: 'high',
        layer,
        action: actions[layer] || `补充${data.label}知识`,
        impact: `「${data.label}」为空，Agent 无法回答相关问题，将转人工处理`,
      });
    }
  }

  // Weak layers
  for (const [layer, data] of Object.entries(layers)) {
    if (data.status === 'warn') {
      recs.push({
        priority: 'medium',
        layer,
        action: `补充更多${data.label}文档（当前仅 ${data.docs} 个文档, ${data.points} 个知识点）`,
        impact: `覆盖率 ${data.coverage}%，部分客户问题可能无法准确回答`,
      });
    }
  }

  // No pricing rules but has products
  if ((productCount || 0) > 0 && (pricingRulesCount || 0) === 0) {
    recs.push({
      priority: 'high',
      layer: 'product',
      action: '配置报价规则（数量折扣、CIF 计算、保险费率）',
      impact: 'Agent 无法精确报价，只能提供 FOB 参考价',
    });
  }

  // Outdated documents
  if (outdatedDocs?.length > 0) {
    for (const doc of outdatedDocs.slice(0, 3)) {
      const days = Math.floor((Date.now() - new Date(doc.updated_at)) / (1000 * 60 * 60 * 24));
      recs.push({
        priority: days > 90 ? 'high' : 'medium',
        layer: doc.layer,
        action: `更新「${doc.filename}」（已 ${days} 天未更新）`,
        impact: '数据可能过时，Agent 报价或回答可能不准确',
      });
    }
  }

  // No glossary
  if ((glossaryCount || 0) === 0) {
    recs.push({
      priority: 'low',
      action: '添加中英术语对照表',
      impact: '提升知识翻译准确度，特别是行业专业术语',
    });
  }

  return recs;
}
