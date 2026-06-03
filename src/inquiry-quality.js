/**
 * Inquiry Quality Standards
 * Field requirements are agent-config driven via qualification_config.
 */

const GLOBAL_MAX_TURNS = 30;

export const FIELD_ALIASES = {
  brand: ['brand', 'car_brand'],
  car_brand: ['car_brand', 'brand'],
  car_model: ['car_model', 'model'],
  company_name: ['company_name'],
  color_quantity: ['color_quantity'],
  destination_country: ['destination_country', 'country'],
  destination_port: ['destination_port'],
  incoterm: ['incoterm', 'international_commercial_term'],
  international_commercial_term: ['international_commercial_term', 'incoterm'],
  loading_port: ['loading_port'],
  machinery_type: ['machinery_type', 'product_name'],
  model: ['model', 'car_model'],
  oem_code: ['oem_code'],
  part_name: ['part_name', 'product_name'],
  product_name: ['product_name', 'part_name', 'machinery_type'],
  product_type: ['product_type', 'product_name'],
  quantity: ['quantity', 'qty_bucket'],
  qty_bucket: ['qty_bucket', 'quantity'],
  sku_description: ['sku_description', 'specifications'],
  specifications: ['specifications', 'sku_description'],
  timeline: ['timeline'],
  year_range: ['year_range'],
  buyer_type: ['buyer_type', 'company_type'],
  company_type: ['company_type', 'buyer_type'],
  business_scale: ['business_scale'],
  china_procurement_history: ['china_procurement_history'],
  country: ['country', 'destination_country'],
  current_fleet: ['current_fleet'],
};

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return value !== null && value !== undefined && value !== false;
}

function collectFlatFields(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectFlatFields(target, value);
      continue;
    }

    if (!hasValue(target[key]) && hasValue(value)) {
      target[key] = value;
    }
  }
}

function buildFieldState(leadData = {}, lead = null) {
  const fieldState = {};

  collectFlatFields(fieldState, leadData);
  collectFlatFields(fieldState, lead?.details || {});

  return fieldState;
}

function getConfiguredRequirements(qualificationConfig, inquiryQuality) {
  const requirements = qualificationConfig?.inquiry_quality_requirements;
  if (!requirements || !requirements[inquiryQuality]) {
    return null;
  }
  return requirements[inquiryQuality];
}

function getFieldValue(fieldState, fieldName) {
  const aliases = FIELD_ALIASES[fieldName] || [fieldName];
  for (const alias of aliases) {
    if (hasValue(fieldState[alias])) {
      return fieldState[alias];
    }
  }
  return undefined;
}

// ─── Shared field resolution (used beyond quality grading) ───────────
// 产品线 lead_fields 字段名可配置（vehicle 用 car_model/qty_bucket，农机线用
// machinery_type/model/quantity，光伏线用 product_type…）。任何「从 lead.details
// 取某语义字段」的逻辑都应走这里的别名感知解析，不要再硬编码 vehicle 那套键名。
// 这是处理字段词汇差异的唯一真源——见 FIELD_ALIASES。

// 「这条线索是关于什么产品」的候选键，按优先级排列。
const PRODUCT_IDENTITY_KEYS = ['car_model', 'product_name', 'model', 'machinery_type', 'product_type'];

/** 别名感知地从 lead.details（含 customer_profile 等嵌套）解析单个语义字段。 */
export function resolveLeadValue(details, semanticKey) {
  const fieldState = {};
  collectFlatFields(fieldState, details || {});
  return getFieldValue(fieldState, semanticKey);
}

/** 跨产品线词汇解析「产品标识」（型号 / 品名 / 机型 / 产品类型）。 */
export function resolveProductIdentity(details) {
  const fieldState = {};
  collectFlatFields(fieldState, details || {});
  for (const key of PRODUCT_IDENTITY_KEYS) {
    const value = getFieldValue(fieldState, key);
    if (hasValue(value)) return value;
  }
  return undefined;
}

/** 跨产品线词汇解析数量（qty_bucket / quantity）。 */
export function resolveQuantity(details) {
  return resolveLeadValue(details, 'qty_bucket');
}

/**
 * Get missing fields for a given inquiry quality level.
 * @param {string} inquiryQuality - BAD | GOOD | QUALIFY | PROOF
 * @param {Object} leadData - Lead data object
 * @param {Object} [options]
 * @param {Object} [options.qualificationConfig] - Agent qualification config
 * @param {Object} [options.lead] - Raw lead object with details JSONB
 * @returns {string[]} - Array of missing field names
 */
export function getMissingFields(inquiryQuality, leadData, options = {}) {
  if (inquiryQuality === 'BAD') {
    return [];
  }

  const requirements = getConfiguredRequirements(options.qualificationConfig, inquiryQuality);
  if (!requirements) {
    return [];
  }

  const fieldState = buildFieldState(leadData, options.lead);
  const missingFields = [];

  for (const field of requirements.required_fields || []) {
    if (!hasValue(getFieldValue(fieldState, field))) {
      missingFields.push(field);
    }
  }

  for (const group of requirements.require_any_of || requirements.required_one_of || []) {
    if (!Array.isArray(group) || group.length === 0) {
      continue;
    }

    const groupSatisfied = group.some((field) => hasValue(getFieldValue(fieldState, field)));
    if (!groupSatisfied) {
      for (const field of group) {
        if (!missingFields.includes(field)) {
          missingFields.push(field);
        }
      }
    }
  }

  return missingFields;
}

/**
 * Check if global max turns has been reached
 * @param {number} messageCount - Total message count in conversation
 * @returns {boolean} - True if limit reached
 */
export function hasReachedGlobalMaxTurns(messageCount) {
  return Math.floor(messageCount / 2) >= GLOBAL_MAX_TURNS;
}

/**
 * Get global max turns constant
 * @returns {number}
 */
export function getGlobalMaxTurns() {
  return GLOBAL_MAX_TURNS;
}

// ─── On-duty forced handoff policy ───────────────────────────────────
// 人工"上班/下班"开关(取代原固定的北京时间 10–20 窗口):产品线处于"上班"
// (reception_on=true)时,对话超过 ONDUTY_HANDOFF_MIN_ROUNDS 轮、模型本轮判
// CONTINUE、且本轮抽到有效线索 → 强制转人工。"下班"时本规则停用(Medici 仍
// 正常路由,模型自判的 HUMAN_NOW 不受影响)。
//
// 开关粒度 = 产品线,状态存 product_lines.reception_on,由
// src/agents/medici/config.js::assembleLineConfig 带进 agentConfig,
// queue-processor 读出后作为 onDuty 传入。消费点见 lib/queue-processor.js。

// 本轮落库前历史已满的轮数达到此值即强转。floor(history/2) >= 3 表示本轮是第 4
// 个客户消息起,落库后对话「超过三轮」。
export const ONDUTY_HANDOFF_MIN_ROUNDS = 3;

/**
 * "上班"状态下长对话强制转人工的判定(叠加在 Medici 路由之上)。四条件全真才转:
 *   - onDuty:该产品线处于"上班"状态(reception_on)。"下班"时整条规则停用
 *   - route === 'CONTINUE':仅覆盖 CONTINUE,尊重模型自判的 FAQ_END / HUMAN_NOW
 *   - priorRounds >= ONDUTY_HANDOFF_MIN_ROUNDS:落库前历史已满 3 轮,本轮落库后
 *     对话「超过三轮」
 *   - hasLead:本轮抽到有效线索(纯闲聊 / FAQ 不打扰销售)
 * 纯函数。hasLead / onDuty 由调用方算好传入(hasLead 走 lib/session.js::
 * hasValidLeads;onDuty 走 agentConfig.reception_on),避免循环依赖。
 * @param {Object} args
 * @param {string} args.route
 * @param {number} args.priorRounds
 * @param {boolean} args.hasLead
 * @param {boolean} args.onDuty
 * @returns {boolean}
 */
export function shouldForceOnDutyHandoff({ route, priorRounds, hasLead, onDuty }) {
  return (
    onDuty === true &&
    route === 'CONTINUE' &&
    priorRounds >= ONDUTY_HANDOFF_MIN_ROUNDS &&
    hasLead === true
  );
}

/**
 * 宿主在 Medici 路由判断之上叠加的两条硬规则的【单一真源】—— 生产入站链路
 * (lib/queue-processor.js) 与 medici 调试台 (app/api/medici-simulator) 共用,
 * 保证两环境最终 route 完全一致、不漂移。优先级:
 *   1. "上班"长对话强制转人工(最高):shouldForceOnDutyHandoff 命中 → HUMAN_NOW
 *   2. 满全局最大轮数 → FAQ_END
 * 规则 1 要求 modelRoute === 'CONTINUE',所以被规则 1 强转的不会再被规则 2 降级。
 * 注意:`modelRoute` 必须传 Medici 的【原始】route(不要传已被改写过的)。
 * 本函数只决策 route,不产生任何副作用(发飞书 / 起接管 / 发 FAQ 资源由调用方按需做)。
 * @param {Object} args
 * @param {string} args.modelRoute        Medici 原始 route
 * @param {number} args.priorRounds       落库前历史轮数 floor(history/2)
 * @param {number} args.postMessageCount  落库后消息总条数(喂给 hasReachedGlobalMaxTurns)
 * @param {boolean} args.hasLead
 * @param {boolean} args.onDuty
 * @returns {{ route: string, forcedHandoff: boolean, reason: 'onduty_handoff'|'global_max_turns'|null }}
 */
export function resolveHostRoute({ modelRoute, priorRounds, postMessageCount, hasLead, onDuty }) {
  if (shouldForceOnDutyHandoff({ route: modelRoute, priorRounds, hasLead, onDuty })) {
    return { route: 'HUMAN_NOW', forcedHandoff: true, reason: 'onduty_handoff' };
  }
  if (hasReachedGlobalMaxTurns(postMessageCount || 0)) {
    return { route: 'FAQ_END', forcedHandoff: false, reason: 'global_max_turns' };
  }
  return { route: modelRoute, forcedHandoff: false, reason: null };
}

export default {
  GLOBAL_MAX_TURNS,
  getMissingFields,
  hasReachedGlobalMaxTurns,
  getGlobalMaxTurns,
  ONDUTY_HANDOFF_MIN_ROUNDS,
  shouldForceOnDutyHandoff,
  resolveHostRoute,
};
