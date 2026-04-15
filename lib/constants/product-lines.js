/**
 * Product line metadata shared between agent list, detail, and any UI
 * rendering agent badges. Keep in sync with DB values in `agents.product_line`.
 *
 * See `supabase/migrations/013_agents_table.sql` — `product_line TEXT NOT NULL UNIQUE`.
 */

export const PRODUCT_META = {
  agri_machinery: {
    key: 'agri_machinery',
    label: '农业机械',
    emoji: '🌾',
    iconBg: 'var(--green-dim)',
    description: '处理农业机械询盘，自动识别拖拉机、收割机、播种机等产品需求，完成 B2B 资格预审并输出结构化 PROOF 线索。',
    tags: ['WhatsApp', '多语言', '自动报价'],
  },
  vehicle: {
    key: 'vehicle',
    label: '整车',
    emoji: '🚗',
    iconBg: 'var(--accent-dim)',
    description: '处理汽车整车询盘，覆盖 BYD、长安等主流车型，自动完成车型匹配、数量确认及目的港询价流程。',
    tags: ['WhatsApp', '多语言', '车型匹配'],
  },
  auto_parts: {
    key: 'auto_parts',
    label: '汽车零配件',
    emoji: '⚙️',
    iconBg: 'var(--amber-dim)',
    description: '处理汽车零配件询盘，支持日系 OEM/OES 配件查询，自动识别零件编号、品牌及批量采购需求。',
    tags: ['WhatsApp', '多语言', '配件查询'],
  },
};

export const DEFAULT_PRODUCT_META = {
  key: 'unknown',
  label: '未分类',
  emoji: '🤖',
  iconBg: 'var(--accent-dim)',
  description: '处理产品询盘，完成资格预审并输出结构化 PROOF 线索。',
  tags: ['WhatsApp', '多语言'],
};

export function getProductMeta(productLine) {
  return PRODUCT_META[productLine] || DEFAULT_PRODUCT_META;
}

/**
 * Resolve the human-readable Chinese label for an agent.
 *
 * Source of truth is `agent.display_label` (DB-managed via /agents UI).
 * Fallback chain:
 *   1. agent.display_label (user-set)
 *   2. PRODUCT_META[product_line].label (legacy three lines)
 *   3. product_line slug itself
 *   4. '未分类'
 *
 * @param {Object|null} agent - agent row with at least { product_line, display_label }
 * @returns {string}
 */
export function getDisplayLabel(agent) {
  if (!agent) return '未分类';
  if (agent.display_label) return agent.display_label;
  const meta = PRODUCT_META[agent.product_line];
  if (meta?.label) return meta.label;
  return agent.product_line || '未分类';
}

/** Ordered options (only used if a legacy UI wants a dropdown; the create
 *  form now accepts any slug). */
export const PRODUCT_LINE_OPTIONS = Object.values(PRODUCT_META).map(m => ({
  value: m.key,
  label: `${m.label} (${m.key})`,
}));

/** DB convention: lowercase letters, digits, underscore. 1-40 chars. */
const PRODUCT_LINE_SLUG_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Validate a product_line slug. Returns error message string if invalid,
 * empty string if valid.
 */
export function validateProductLineSlug(slug) {
  if (!slug) return '产品线不能为空';
  if (!PRODUCT_LINE_SLUG_RE.test(slug)) {
    return '仅小写字母、数字和下划线；必须字母开头；不超过 40 字符';
  }
  return '';
}
