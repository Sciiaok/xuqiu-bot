/**
 * Knowledge Base Search Service
 *
 * Provides vector search, structured query, and hybrid search over the kb_* tables.
 * Used by the Agent tool-use loop and the knowledge management API.
 */
import { openrouter, MODELS } from './llm-client.js';
import supabase from '../lib/supabase.js';

// ── Embedding ────────────────────────────────────────────────────────

async function generateEmbedding(text) {
  const response = await openrouter.embeddings.create({
    model: MODELS.EMBEDDING,
    input: text,
  });
  return response.data[0].embedding;
}

// ── Language Detection ───────────────────────────────────────────────

/**
 * Simple heuristic: if text has >30% CJK characters, it's Chinese.
 * For other languages (French, Arabic, etc.), fall back to 'other'.
 */
function detectLanguage(text) {
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  const cjkMatches = text.match(cjkRegex) || [];
  const ratio = cjkMatches.length / text.length;
  if (ratio > 0.15) return 'zh';

  // Simple English check: mostly ASCII letters
  const asciiLetters = text.match(/[a-zA-Z]/g) || [];
  if (asciiLetters.length / text.length > 0.5) return 'en';

  return 'other';
}

// ── Query Rewrite (multi-turn context) ───────────────────────────────

/**
 * Rewrites a query using conversation context so it can be searched independently.
 * Only called when conversation_context is provided and non-empty.
 */
async function rewriteQuery(query, conversationContext) {
  if (!conversationContext || conversationContext.length === 0) return query;

  const contextStr = conversationContext
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  const response = await openrouter.messages.create({
    models: [MODELS.HAIKU],
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You are a query rewrite assistant. Based on the conversation history, rewrite the user's latest message into a complete, self-contained search query. Requirements:
- Fill in omitted subjects/product models from context
- Keep specific place names, model numbers, quantities
- Output in English (for knowledge base search)
- Output ONLY the rewritten query, nothing else`,
      },
      {
        role: 'user',
        content: `Conversation history:\n${contextStr}\n\nLatest message to rewrite: ${query}`,
      },
    ],
  });

  return response.choices[0].message.content?.trim() || query;
}

// ── Vector Search ────────────────────────────────────────────────────

async function vectorSearch({ tenantId, productLineId, query, layers = null, topK = 5, lang = null }) {
  if (!tenantId || !productLineId) {
    throw new Error('vectorSearch: tenantId and productLineId required');
  }
  const queryLang = lang || detectLanguage(query);

  // For non-English queries, translate to English for search
  let searchQuery = query;
  if (queryLang !== 'en') {
    searchQuery = await translateToEnglish(query);
  }

  const embedding = await generateEmbedding(searchQuery);

  // 新 overload: (p_tenant_id, p_product_line_id, p_embedding, p_layers, p_top_k)
  const { data, error } = await supabase.rpc('search_kb_knowledge_en', {
    p_tenant_id: tenantId,
    p_product_line_id: productLineId,
    p_embedding: embedding,
    p_layers: layers,
    p_top_k: topK,
  });

  if (error) throw new Error(`KB vector search failed: ${error.message}`);
  return data || [];
}

// ── Structured Search ────────────────────────────────────────────────

/**
 * Query kb_products with structured filters.
 * Filters format: { "specs.horsepower": { "$lte": 50 }, "category": "tractor" }
 */
async function structuredProductSearch({ tenantId, productLineId, filters = {}, sortBy, sortOrder = 'asc', limit = 10 }) {
  let query = supabase
    .from('kb_products')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('is_active', true);

  for (const [key, value] of Object.entries(filters)) {
    if (key.startsWith('specs.')) {
      // JSONB field filter
      const specKey = key.replace('specs.', '');
      if (typeof value === 'object' && value !== null) {
        for (const [op, val] of Object.entries(value)) {
          if (op === '$lte') query = query.lte(`specs->>${specKey}`, val);
          else if (op === '$gte') query = query.gte(`specs->>${specKey}`, val);
          else if (op === '$lt') query = query.lt(`specs->>${specKey}`, val);
          else if (op === '$gt') query = query.gt(`specs->>${specKey}`, val);
          else if (op === '$eq') query = query.eq(`specs->>${specKey}`, val);
        }
      } else {
        query = query.eq(`specs->>${specKey}`, value);
      }
    } else {
      // Direct column filter
      if (typeof value === 'object' && value !== null) {
        for (const [op, val] of Object.entries(value)) {
          if (op === '$lte') query = query.lte(key, val);
          else if (op === '$gte') query = query.gte(key, val);
          else if (op === '$lt') query = query.lt(key, val);
          else if (op === '$gt') query = query.gt(key, val);
          else if (op === '$eq') query = query.eq(key, val);
        }
      } else {
        query = query.eq(key, value);
      }
    }
  }

  if (sortBy) {
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });
  }

  query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw new Error(`KB structured search failed: ${error.message}`);
  return data || [];
}

// ── Translation ──────────────────────────────────────────────────────

/**
 * Translate arbitrary text to English via Haiku. Preserves product names,
 * model numbers, and technical terms.
 */
async function translateToEnglish(text) {
  const response = await openrouter.messages.create({
    models: [MODELS.HAIKU],
    max_tokens: 4000,
    messages: [
      { role: 'system', content: 'Translate the following text to English. Keep product names, model numbers, and technical terms accurate. Output ONLY the translation.' },
      { role: 'user', content: text },
    ],
  });
  return response.choices[0].message.content?.trim() || text;
}

// ── Priority Scoring ─────────────────────────────────────────────────

/**
 * Re-rank search results by combining relevance, authority, and freshness.
 */
function applyPriorityScoring(results) {
  const now = new Date();

  return results.map(r => {
    const relevance = r.similarity || 0;
    const authorityWeight = (r.authority_level || 3) / 5; // normalize 1-5 to 0.2-1.0
    const daysSince = r.effective_date
      ? (now - new Date(r.effective_date)) / (1000 * 60 * 60 * 24)
      : 0;
    // Freshness decays over 180 days
    const freshnessWeight = Math.max(0, 1 - daysSince / 180);

    const finalScore = relevance * 0.4 + authorityWeight * 0.35 + freshnessWeight * 0.25;

    return { ...r, final_score: finalScore };
  }).sort((a, b) => b.final_score - a.final_score);
}

// ── Intent Routing (auto-detect search mode) ────────────────────────

/**
 * Use LLM to analyze query and determine optimal search strategy.
 * Extracts structured filters from natural language when applicable.
 */
async function analyzeQueryIntent({ tenantId, productLineId, query }) {
  // Get available spec fields for this product line
  const { data: sampleProduct } = await supabase
    .from('kb_products')
    .select('specs, category')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  const specFields = sampleProduct?.specs ? Object.keys(sampleProduct.specs) : [];
  const specFieldsHint = specFields.length > 0
    ? `Available product spec fields: ${specFields.join(', ')}`
    : 'No structured product data available';

  const response = await openrouter.messages.create({
    models: [MODELS.HAIKU],
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content: `You analyze customer queries to determine the best search strategy for a B2B knowledge base.

${specFieldsHint}
Also available: fob_price_usd, moq, category, model, sku in the products table.
Shipping routes table has: destination_country, destination_port, shipping_method.

Respond ONLY with a JSON object:
{
  "search_mode": "vector" | "structured" | "hybrid",
  "filters": { ... } or null,
  "sort_by": "field_name" or null,
  "sort_order": "asc" or "desc",
  "layers": ["layer1"] or null,
  "reasoning": "brief explanation"
}

Rules:
- "vector": general questions, descriptions, recommendations → semantic search
- "structured": specific numeric comparisons (price < X, power > Y) → SQL filters
- "hybrid": combination (e.g. "cheapest tractor under 100HP") → SQL filter + vector rank
- For filters, use: {"field": {"$lte": value}} or {"field": "exact_value"} or {"specs.field_name": {"$gte": value}}
- Infer layers from topic: price/specs → product, shipping → logistics, certification → compliance, etc.`,
      },
      { role: 'user', content: query },
    ],
  });

  const text = response.choices[0].message.content?.trim() || '{}';
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    return JSON.parse(jsonMatch[1].trim());
  } catch {
    return { search_mode: 'vector', filters: null, sort_by: null, layers: null };
  }
}

// ── Unified Search (main entry point) ────────────────────────────────

/**
 * Main search function called by Agent tools.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.productLineId
 * @param {string} opts.query
 * @param {string[]} [opts.layers]
 * @param {number} [opts.topK=5]
 * @param {Array} [opts.conversationContext]
 * @param {Object} [opts.filters]
 * @param {string} [opts.sortBy]
 * @param {string} [opts.sortOrder='asc']
 */
export async function searchKnowledge({
  tenantId,
  productLineId,
  query,
  layers: explicitLayers = null,
  topK = 5,
  conversationContext = null,
  filters: explicitFilters = null,
  sortBy: explicitSortBy = null,
  sortOrder: explicitSortOrder = 'asc',
}) {
  if (!tenantId || !productLineId) {
    throw new Error('searchKnowledge: tenantId and productLineId required');
  }

  // Step 1: Query rewrite if conversation context provided
  let effectiveQuery = query;
  if (conversationContext && conversationContext.length > 0) {
    effectiveQuery = await rewriteQuery(query, conversationContext);
  }

  // Step 2: Intent routing — auto-detect search mode and extract filters
  let searchMode = 'vector';
  let filters = explicitFilters;
  let sortBy = explicitSortBy;
  let sortOrder = explicitSortOrder;
  let layers = explicitLayers;
  let intentAnalysis = null;

  // Only run intent analysis if no explicit filters were provided
  if (!explicitFilters) {
    try {
      intentAnalysis = await analyzeQueryIntent({ tenantId, productLineId, query: effectiveQuery });
      searchMode = intentAnalysis.search_mode || 'vector';
      if (intentAnalysis.filters) filters = intentAnalysis.filters;
      if (intentAnalysis.sort_by) sortBy = intentAnalysis.sort_by;
      if (intentAnalysis.sort_order) sortOrder = intentAnalysis.sort_order;
      if (!explicitLayers && intentAnalysis.layers) layers = intentAnalysis.layers;
    } catch {
      // Fallback to vector search if intent analysis fails
      searchMode = 'vector';
    }
  } else {
    searchMode = 'hybrid'; // Explicit filters → at least hybrid mode
  }

  const hasFilters = filters && Object.keys(filters).length > 0;

  let vectorResults = [];
  let structuredResults = [];

  // Step 3: Execute search based on determined mode
  if (searchMode === 'structured' && hasFilters) {
    structuredResults = await structuredProductSearch({ tenantId, productLineId, filters, sortBy, sortOrder, limit: topK });
  } else if (searchMode === 'hybrid' && hasFilters) {
    [vectorResults, structuredResults] = await Promise.all([
      vectorSearch({ tenantId, productLineId, query: effectiveQuery, layers, topK }),
      structuredProductSearch({ tenantId, productLineId, filters, sortBy, sortOrder, limit: topK }),
    ]);
  } else {
    vectorResults = await vectorSearch({ tenantId, productLineId, query: effectiveQuery, layers, topK });
  }

  // Step 4: Apply priority scoring to vector results
  const rankedResults = applyPriorityScoring(vectorResults);

  // Step 4: Fetch associated assets for top results
  const resultIds = rankedResults.map(r => r.id);
  let assets = [];
  if (resultIds.length > 0) {
    // Find assets linked to the same SKUs mentioned in results
    const skus = rankedResults
      .map(r => r.metadata_json?.sku)
      .filter(Boolean);

    if (skus.length > 0) {
      const { data } = await supabase
        .from('kb_assets')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('product_line_id', productLineId)
        .overlaps('linked_skus', skus);
      assets = data || [];
    }
  }

  // Step 5: Attach assets to results
  const resultsWithAssets = rankedResults.map(r => {
    const sku = r.metadata_json?.sku;
    const relatedAssets = sku
      ? assets.filter(a => a.linked_skus?.includes(sku))
      : [];
    return {
      ...r,
      assets: relatedAssets.map(a => ({
        asset_id: a.id,
        type: a.asset_type,
        filename: a.filename,
        storage_path: a.storage_path,
        is_sendable: a.is_sendable,
      })),
    };
  });

  // Step 6: Get document filenames for source attribution
  const docIds = [...new Set(rankedResults.map(r => r.doc_id).filter(Boolean))];
  let docMap = {};
  if (docIds.length > 0) {
    const { data } = await supabase
      .from('kb_documents')
      .select('id, filename')
      .in('id', docIds);
    if (data) {
      docMap = Object.fromEntries(data.map(d => [d.id, d.filename]));
    }
  }

  return {
    results: resultsWithAssets.map(r => ({
      content: r.content_en || r.content_original,
      content_original: r.content_original,
      layer: r.layer,
      source: r.doc_id ? `${docMap[r.doc_id] || 'unknown'} (${r.source_location || ''})` : null,
      relevance_score: r.similarity,
      final_score: r.final_score,
      metadata: r.metadata_json,
      assets: r.assets,
    })),
    structured_results: structuredResults,
    rewritten_query: effectiveQuery !== query ? effectiveQuery : undefined,
    search_mode: searchMode,
    intent_analysis: intentAnalysis?.reasoning || undefined,
  };
}

// ── Price Calculation ────────────────────────────────────────────────

/**
 * Calculate price from `kb_products` (base FOB) + optional `kb_shipping_routes`
 * for CIF/DDP. Insurance flat 0.3%.
 *
 * @param {Object} opts { tenantId, productLineId, sku, quantity?, destinationPort?, tradeTerm? }
 */
export async function calculatePrice({ tenantId, productLineId, sku, quantity = 1, destinationPort, tradeTerm = 'FOB' }) {
  if (!tenantId || !productLineId) {
    throw new Error('calculatePrice: tenantId and productLineId required');
  }
  // 1. Base FOB from kb_products.
  const { data: products } = await supabase
    .from('kb_products')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('is_active', true)
    .or(`sku.ilike.%${sku}%,model.ilike.%${sku}%`)
    .limit(1);

  const product = products?.[0];
  if (!product || !product.fob_price_usd) {
    return { error: 'product_not_found', message: `No pricing data found for ${sku}` };
  }

  const unitPrice = parseFloat(product.fob_price_usd);
  const breakdown = {
    unit_fob_price: unitPrice,
    quantity,
    discounted_unit_price: round2(unitPrice),
  };
  const appliedRules = [];

  // 2. CIF/DDP adds shipping (kb_shipping_routes) + flat 0.3% insurance.
  if (tradeTerm !== 'FOB' && destinationPort) {
    const { data: routes } = await supabase
      .from('kb_shipping_routes')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('product_line_id', productLineId)
      .ilike('destination_port', `%${destinationPort}%`)
      .limit(1);

    const route = routes?.[0];
    if (route?.cost_per_unit_usd) {
      const shippingCost = parseFloat(route.cost_per_unit_usd);
      const insuranceRate = 0.003;
      const insuranceCost = round2(unitPrice * insuranceRate);

      breakdown.shipping_per_unit = shippingCost;
      breakdown.transit_days = route.transit_days;
      breakdown.insurance_per_unit = insuranceCost;
      breakdown.unit_cif_price = round2(unitPrice + shippingCost + insuranceCost);
      appliedRules.push({
        rule: 'CIF calculation',
        detail: `FOB + shipping $${shippingCost} + insurance ${insuranceRate * 100}%`,
      });
    } else {
      breakdown.shipping_note = `No shipping data for ${destinationPort}`;
      breakdown.unit_cif_price = null;
    }
  }

  const finalUnitPrice = breakdown.unit_cif_price || breakdown.discounted_unit_price;
  breakdown.total_price = round2(finalUnitPrice * quantity);
  breakdown.trade_term = tradeTerm;

  return {
    product: {
      sku: product.sku,
      model: product.model,
      product_name: product.product_name_en || product.product_name,
    },
    breakdown,
    rules_applied: appliedRules,
    needs_approval: false,
    confidence: breakdown.unit_cif_price !== null || tradeTerm === 'FOB' ? 'exact' : 'partial',
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Exports for Agent tool integration ───────────────────────────────

export {
  generateEmbedding,
  detectLanguage,
  translateToEnglish,
  vectorSearch,
  structuredProductSearch,
};
