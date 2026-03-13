/**
 * Car Catalog Context - Builds car recommendation context for AI conversations
 * Matches user messages against car model keywords and detects region by phone prefix.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dirname, '..', 'skills', 'car-catalog', 'data', 'car-models.json');

let catalog = null;

function loadCatalog() {
  if (!catalog) {
    catalog = JSON.parse(readFileSync(dataPath, 'utf-8'));
  }
  return catalog;
}

/**
 * Match car models by keywords in user message.
 * Returns deduplicated list of matched models.
 */
function matchByKeywords(userMessage) {
  const { models } = loadCatalog();
  const lowerMessage = userMessage.toLowerCase();
  const matched = new Set();
  const results = [];

  for (const model of models) {
    for (const keyword of model.keywords) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        const key = `${model.brand}:${model.series}:${model.config_zh}`;
        if (!matched.has(key)) {
          matched.add(key);
          results.push(model);
        }
        break;
      }
    }
  }

  return results;
}

/**
 * Detect region from wa_id phone prefix and return hot-selling models for that region.
 */
function matchByRegion(waId) {
  if (!waId) return null;

  const { models, region_phone_prefixes } = loadCatalog();
  const prefixStr = String(waId);

  // Check longest prefix first (994 before 77)
  const sortedPrefixes = Object.keys(region_phone_prefixes).sort((a, b) => b.length - a.length);

  for (const prefix of sortedPrefixes) {
    if (prefixStr.startsWith(prefix)) {
      const region = region_phone_prefixes[prefix];
      const hotModels = models.filter((m) => m.hot_markets.includes(region.code));
      return { region, hotModels };
    }
  }

  return null;
}

/**
 * Build car catalog context string for injection into AI prompt.
 *
 * @param {string} userMessage - The user's message text
 * @param {string} waId - The user's WhatsApp ID (phone number)
 * @param {object} [logger] - Optional trace logger (createTraceLogger instance)
 * @returns {string} Context string to inject, or empty string if no match
 */
export function buildCarCatalogContext(userMessage, waId, logger) {
  const parts = [];

  // Keyword-based matching
  const keywordMatches = matchByKeywords(userMessage || '');
  if (keywordMatches.length > 0) {
    const matchedSeries = keywordMatches.map((m) => m.series_zh);
    const lines = keywordMatches.map(
      (m) => `  • ${m.brand} ${m.series} — ${m.config_en} (${m.powertrain})`
    );
    parts.push(
      `IMPORTANT: When CAR CATALOG MATCH is present, you MUST recommend the specific configs listed below instead of generic product lists.\nCAR CATALOG MATCH: User mentioned "${matchedSeries.join(', ')}". Available configs:\n${lines.join('\n')}`
    );

    logger?.info('car_catalog.keyword_match', {
      matched_series: matchedSeries,
      matched_count: keywordMatches.length,
      message_preview: (userMessage || '').slice(0, 120),
    });
  }

  // Region-based matching
  const regionMatch = matchByRegion(waId);
  if (regionMatch) {
    const { region, hotModels } = regionMatch;
    const modelList = hotModels.map((m) => `${m.brand} ${m.series}`).join(', ');
    parts.push(
      `REGION RECOMMENDATION: User is from ${region.country_en} (${region.country_zh}).\n  Hot-selling models in this market: ${modelList}`
    );

    logger?.info('car_catalog.region_match', {
      region_code: region.code,
      country: region.country_en,
      hot_models_count: hotModels.length,
    });
  }

  if (parts.length === 0) {
    logger?.info('car_catalog.no_match');
  }

  return parts.join('\n');
}
