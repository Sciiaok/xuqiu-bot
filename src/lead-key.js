/**
 * Lead Key Utility
 * Generates unique identifiers for leads within a conversation
 * based on car_model and destination_country
 */

/**
 * Generate lead key from extracted fields
 * @param {Object} fields - Extracted fields from Claude (car_model, destination_country, etc.)
 * @returns {string|null} - Lead key or null if insufficient data
 */
export function generateLeadKey(fields) {
  if (!fields) return null;

  const parts = [];

  // Core distinguishing fields (in priority order)
  if (fields.car_model) {
    parts.push(`model:${fields.car_model.toLowerCase().trim()}`);
  }
  if (fields.destination_country) {
    parts.push(`dest:${fields.destination_country.toLowerCase().trim()}`);
  }

  // Return null if no core fields (will use default lead)
  if (parts.length === 0) return null;

  return parts.join('|');
}

/**
 * Parse lead key back to fields
 * @param {string} leadKey - Lead key string
 * @returns {Object} - Parsed fields {carModel, destinationCountry}
 */
export function parseLeadKey(leadKey) {
  if (!leadKey || leadKey === 'default') {
    return { carModel: null, destinationCountry: null };
  }

  const result = { carModel: null, destinationCountry: null };
  const parts = leadKey.split('|');

  for (const part of parts) {
    const [key, value] = part.split(':');
    if (key === 'model') {
      result.carModel = value;
    } else if (key === 'dest') {
      result.destinationCountry = value;
    }
  }

  return result;
}

export default { generateLeadKey, parseLeadKey };
