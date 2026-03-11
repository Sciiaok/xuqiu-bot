/**
 * Inquiry Quality Standards
 * Field requirements are agent-config driven via qualification_config.
 */

const GLOBAL_MAX_TURNS = 30;

const FIELD_ALIASES = {
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

  const scalarLeadFields = {
    brand: lead?.brand,
    buyer_type: lead?.buyer_type,
    car_model: lead?.car_model,
    color_quantity: lead?.color_quantity,
    company_name: lead?.company_name,
    destination_country: lead?.destination_country,
    destination_port: lead?.destination_port,
    incoterm: lead?.incoterm,
    international_commercial_term: lead?.incoterm,
    loading_port: lead?.loading_port,
    product_name: lead?.product_name,
    qty_bucket: lead?.qty_bucket,
    sku_description: lead?.sku_description,
    timeline: lead?.timeline,
  };

  for (const [key, value] of Object.entries(scalarLeadFields)) {
    if (!hasValue(fieldState[key]) && hasValue(value)) {
      fieldState[key] = value;
    }
  }

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

/**
 * Map inquiry_quality to legacy stage for backward compatibility
 * @param {string} inquiryQuality - BAD | GOOD | QUALIFY | PROOF
 * @returns {string} - GREET | QUALIFY | PROOF
 */
export function mapInquiryQualityToStage(inquiryQuality) {
  const mapping = {
    BAD: 'GREET',
    GOOD: 'GREET',
    QUALIFY: 'QUALIFY',
    PROOF: 'PROOF',
  };
  return mapping[inquiryQuality] || 'GREET';
}

export default {
  GLOBAL_MAX_TURNS,
  getMissingFields,
  hasReachedGlobalMaxTurns,
  getGlobalMaxTurns,
  mapInquiryQualityToStage,
};
