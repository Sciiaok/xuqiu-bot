/**
 * Shared KB tab constants. Backend source of truth lives in
 * lib/repositories/knowledge-base.repository.js — keep these aligned.
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
