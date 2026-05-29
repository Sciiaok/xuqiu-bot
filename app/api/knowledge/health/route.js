import { NextResponse } from 'next/server';
import { getTenantContext, findProductLineInTenant } from '../../../../lib/tenant-context.js';
import { getHealthSummary } from '../../../../lib/repositories/knowledge-base.repository.js';

/**
 * GET /api/knowledge/health?product_line_id=xxx
 *
 * Returns the per-layer coverage + recommendations shown on the OverviewTab.
 */
export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const productLineId = searchParams.get('product_line_id');

    if (!productLineId) {
      return NextResponse.json({ error: 'product_line_id is required' }, { status: 400 });
    }
    const line = await findProductLineInTenant({ tenantId: ctx.tenantId, productLineId });
    if (!line) {
      return NextResponse.json({ error: 'Product line not found' }, { status: 404 });
    }

    const summary = await getHealthSummary({
      tenantId: ctx.tenantId,
      productLineId,
    });
    const recommendations = generateRecommendations(summary.layers, summary.outdated_docs);

    return NextResponse.json({ ...summary, ai_recommendations: recommendations });
  } catch (error) {
    console.error('[knowledge/health] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Actionable recommendations based on per-layer status + outdated docs.
 */
function generateRecommendations(layers, outdatedDocs) {
  const recs = [];

  // Empty layers — highest priority.
  for (const [layer, data] of Object.entries(layers)) {
    if (data.status === 'error') {
      const actions = {
        company: '上传公司简介、资质证书、付款条款、售后政策文档',
        product: '上传产品目录或价格表（任意格式：Excel / PDF / Word / 自然语言均可）',
        logistics: '上传运费表 / 路线表 / 贸易规则等物流交付资料',
        sales: '上传销售 SOP、异议处理话术、折扣规则、贸易规则',
      };
      recs.push({
        priority: 'high',
        layer,
        action: actions[layer] || `补充${data.label}知识`,
        impact: `「${data.label}」为空，Agent 无法回答相关问题，将转人工处理`,
      });
    }
  }

  // Weak layers.
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

  // Outdated documents.
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

  return recs;
}
