import { NextResponse } from 'next/server';
import { getHealthSummary } from '../../../../lib/repositories/knowledge-base.repository.js';

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

    const summary = await getHealthSummary(agentId);
    const recommendations = generateRecommendations(
      summary.layers,
      summary.outdated_docs,
      summary.total_products,
      summary.total_pricing_rules,
      summary.total_glossary_terms,
    );

    return NextResponse.json({ ...summary, ai_recommendations: recommendations });
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
      const days = doc.days_since_update;
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
