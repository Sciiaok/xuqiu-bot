/**
 * Inquiry Quality Standards
 * Defines field requirements for each quality level and global limits
 */

const GLOBAL_MAX_TURNS = 30;

const INQUIRY_QUALITY_STANDARD_CONFIG = {
  GOOD: {
    required_fields: ['brand', 'car_model', 'color'],
  },
  QUALIFY: {
    required_fields: ['color_quantity', 'destination_port'],
  },
  PROOF: {
    required_fields: ['company_name', 'international_commercial_term'],
  },
};

/**
 * Get missing fields for a given inquiry quality level
 * @param {string} inquiryQuality - BAD | GOOD | QUALIFY | PROOF
 * @param {Object} leadData - Lead data object
 * @returns {string[]} - Array of missing field names
 */
export function getMissingFields(inquiryQuality, leadData) {
  if (inquiryQuality === 'BAD' || !INQUIRY_QUALITY_STANDARD_CONFIG[inquiryQuality]) {
    return [];
  }

  const config = INQUIRY_QUALITY_STANDARD_CONFIG[inquiryQuality];
  return config.required_fields.filter(field => {
    const value = leadData[field];

    if (Array.isArray(value)) {
      return value.length === 0;
    }

    if (typeof value === 'string') {
      return value.trim() === '';
    }

    return !value;
  });
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
  INQUIRY_QUALITY_STANDARD_CONFIG,
  getMissingFields,
  hasReachedGlobalMaxTurns,
  getGlobalMaxTurns,
  mapInquiryQualityToStage,
};
