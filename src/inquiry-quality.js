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

export default {
  GLOBAL_MAX_TURNS,
  getMissingFields,
  hasReachedGlobalMaxTurns,
  getGlobalMaxTurns,
};
