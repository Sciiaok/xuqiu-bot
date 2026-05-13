/**
 * KB Tools Service — 6 typed functions that medici calls via tool_use.
 *
 * Design rule: every function returns a typed result with explicit success /
 * failure shapes. medici makes deterministic if-else decisions based on the
 * shape — never "evaluates" a similarity score.
 *
 * Tools:
 *   1. lookupProduct
 *   2. quotePrice
 *   3. lookupShipping
 *   4. lookupPolicy   (also folds in QA snippet search)
 *   5. findAsset
 *   6. checkConstraint
 */
import { generateEmbedding, translateToEnglish, detectLanguage } from './kb-search.service.js';
import supabase from '../lib/supabase.js';

// ── Helpers ──────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

function notExpiredFilter(query) {
  return query.or(`expiry_date.is.null,expiry_date.gt.${todayIso()}`);
}

function highConfidenceFilter(query) {
  return query.in('confidence', ['verified', 'extracted_high']);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── 1. lookupProduct ─────────────────────────────────────────────────

// Tokenize a search value so that:
//   - whitespace is normalized (folds "捷达 VA3" → ["捷达", "VA3"])
//   - mixed CJK/Latin runs are also split ("捷达VA3" → ["捷达", "VA3", "捷达VA3"])
// Each token feeds an OR-over-4-fields filter; the AND across tokens means
// "every token must match SOMEWHERE on the row", which beats the old single
// ILIKE that died on whitespace ('捷达 VA3' ILIKE '%捷达VA3...%' → no hit).
function tokenizeSearch(input) {
  if (!input) return [];
  const trimmed = String(input).trim().replace(/\s+/g, ' ');
  if (!trimmed) return [];
  const tokens = new Set();
  for (const part of trimmed.split(' ')) {
    if (!part) continue;
    tokens.add(part);
    // Sub-split on CJK ↔ Latin transitions so "捷达VA3" yields "捷达" + "VA3".
    const subs = part.split(/(?<=[一-鿿])(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])(?=[一-鿿])/);
    if (subs.length > 1) for (const s of subs) if (s) tokens.add(s);
  }
  return [...tokens];
}

// PostgREST .or() builder for one token. Sanitize comma/paren/% so the
// filter parser stays well-formed even if a user pastes "(VA3)" or similar.
function ilikeOrClauseForToken(token) {
  const safe = String(token).replace(/[%_,()\\]/g, ' ').trim();
  if (!safe) return null;
  return `sku.ilike.%${safe}%,model.ilike.%${safe}%,product_name.ilike.%${safe}%,product_name_en.ilike.%${safe}%`;
}

/**
 * Find products by SKU, model name, or structured attrs.
 *
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} input.productLineId
 * @param {string} [input.sku]      Exact match priority
 * @param {string} [input.model]    Keyword on product name / model
 * @param {Object} [input.attrs]    JSONB filters, e.g. { horsepower_lte: 50, fuel_type: 'diesel' }
 * @returns {Promise<{found:true,products:Object[]} | {found:false,suggestions?:string[],missing_fields?:string[]}>}
 */
export async function lookupProduct({ tenantId, productLineId, sku, model, attrs }) {
  if (!tenantId || !productLineId) throw new Error('lookupProduct: tenantId+productLineId required');
  if (!sku && !model && (!attrs || !Object.keys(attrs).length)) {
    return { found: false, missing_fields: ['sku', 'model', 'attrs'] };
  }

  // sku 和 model 入参语义略不同，但用户问"星耀6"既可能填到 sku 也可能填到 model。
  // 实际数据里中文车型名常落在 product_name（"现代索纳塔"），版本号落在 model
  // （"2024款 1.5T Pro"），所以两个入参都覆盖 4 个字段，避免字段语义错配漏匹配。
  const tokens = [...new Set([...tokenizeSearch(sku), ...tokenizeSearch(model)])];

  async function runQuery(tokenList) {
    let q = supabase
      .from('kb_products')
      .select('id, sku, model, product_name, product_name_en, category, specs, fob_price_usd, moq, lead_time_days, effective_date, expiry_date, confidence, source_doc_id')
      .eq('tenant_id', tenantId)
      .eq('product_line_id', productLineId)
      .eq('is_active', true);
    q = highConfidenceFilter(q);
    q = notExpiredFilter(q);
    for (const t of tokenList) {
      const clause = ilikeOrClauseForToken(t);
      if (clause) q = q.or(clause);
    }
    if (attrs && Object.keys(attrs).length) {
      for (const [key, value] of Object.entries(attrs)) {
        // Convention: { fieldname_lte: x }, { fieldname_gte: x }, { fieldname: x }
        if (key.endsWith('_lte')) {
          q = q.lte(`specs->>${key.slice(0, -4)}`, String(value));
        } else if (key.endsWith('_gte')) {
          q = q.gte(`specs->>${key.slice(0, -4)}`, String(value));
        } else {
          q = q.eq(`specs->>${key}`, String(value));
        }
      }
    }
    return q.limit(10);
  }

  // Pass 1: AND-of-OR — every token must match somewhere on the row.
  const primary = await runQuery(tokens);
  if (primary.error) throw new Error(`lookupProduct failed: ${primary.error.message}`);
  if (primary.data && primary.data.length > 0) {
    return { found: true, products: primary.data };
  }

  // Pass 2 fallback: if there were multiple tokens, retry with only the
  // most discriminative (longest) one. Catches "Foton VA3" / "捷达 V100"
  // typos where one token has no hits in the catalog but the other does.
  if (tokens.length > 1) {
    const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
    const fb = await runQuery([longest]);
    if (fb.error) throw new Error(`lookupProduct failed: ${fb.error.message}`);
    if (fb.data && fb.data.length > 0) {
      return {
        found: true,
        products: fb.data,
        relaxed_match: { matched_token: longest, dropped_tokens: tokens.filter(t => t !== longest) },
      };
    }
  }

  // Still nothing — return suggestions that share at least one token with
  // the query. NEVER return random "first 5 rows": those used to look like
  // unrelated products and the LLM kept concluding "we don't have it".
  const suggestions = await buildLookupSuggestions({ tenantId, productLineId, tokens });
  return { found: false, suggestions };
}

async function buildLookupSuggestions({ tenantId, productLineId, tokens }) {
  if (!tokens.length) return [];
  const orClauses = tokens.map(ilikeOrClauseForToken).filter(Boolean).join(',');
  if (!orClauses) return [];
  let q = supabase
    .from('kb_products')
    .select('product_name, product_name_en, model, sku')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('is_active', true)
    .or(orClauses)
    .limit(5);
  const { data, error } = await q;
  if (error || !data) return [];
  const seen = new Set();
  const out = [];
  for (const p of data) {
    // product_name 已经是 "捷达VA3 手动挡" 这种全名，不再死拼 model（重复 token）。
    const name = p.product_name || p.product_name_en || p.sku || p.model;
    if (!name) continue;
    const key = name.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ── 2. quotePrice ────────────────────────────────────────────────────

/**
 * Quote a price. Combines product fact lookup, shipping lookup (for CIF/DDP),
 * and constraint checks (non-standard payment terms → needs_human).
 *
 * @returns {Promise<
 *   | {ok:true, unit_price:number, total_price:number, currency:string,
 *      breakdown:Object, validity:Object, source:Object, confidence:string}
 *   | {ok:false, missing_fields:string[]}
 *   | {ok:false, needs_human:true, reason:string}
 *   | {ok:false, not_found:true}
 * >}
 */
export async function quotePrice({
  tenantId, productLineId,
  sku, quantity = 1, tradeTerm = 'FOB', destinationPort, paymentTerm,
}) {
  if (!tenantId || !productLineId) throw new Error('quotePrice: tenantId+productLineId required');
  if (!sku) return { ok: false, missing_fields: ['sku'] };

  // 1. Find product (high-confidence + non-expired only)
  const productLookup = await lookupProduct({ tenantId, productLineId, sku });
  if (!productLookup.found) return { ok: false, not_found: true };
  if (productLookup.products.length > 1) {
    return {
      ok: false,
      missing_fields: ['sku'],
      reason: `multiple matches: ${productLookup.products.map(p => p.sku || p.model).join(', ')}`,
    };
  }

  const product = productLookup.products[0];
  if (!product.fob_price_usd) {
    return { ok: false, needs_human: true, reason: 'no_fob_price_recorded' };
  }
  const unitFob = parseFloat(product.fob_price_usd);

  // 2. CIF/DDP requires destination_port
  if (tradeTerm !== 'FOB' && !destinationPort) {
    return { ok: false, missing_fields: ['destination_port'] };
  }

  // 3. Payment term check (non-standard requires approval)
  if (paymentTerm) {
    const constraint = await checkConstraint({
      tenantId, productLineId,
      action: 'accept_payment_term',
      context: { payment_term: paymentTerm },
    });
    if (constraint.decision === 'forbidden') {
      return { ok: false, needs_human: true, reason: `payment_term_forbidden: ${constraint.reason}` };
    }
    if (constraint.decision === 'requires_approval') {
      return { ok: false, needs_human: true, reason: `payment_term_needs_approval: ${constraint.reason}` };
    }
  }

  // 4. Build breakdown
  const breakdown = {
    unit_fob_price: unitFob,
    quantity,
    trade_term: tradeTerm,
  };

  if (tradeTerm !== 'FOB') {
    const shipping = await lookupShipping({ tenantId, productLineId, destinationPort });
    if (!shipping.found) {
      return {
        ok: false, missing_fields: ['shipping_route'],
        reason: `no shipping route to ${destinationPort}`,
      };
    }
    const shippingCost = parseFloat(shipping.route.unit_cost);
    const insurance = round2(unitFob * 0.003);
    breakdown.shipping_per_unit = shippingCost;
    breakdown.transit_days = shipping.route.transit_days;
    breakdown.insurance_per_unit = insurance;
    breakdown.unit_cif_price = round2(unitFob + shippingCost + insurance);
  }

  const unitPrice = breakdown.unit_cif_price ?? breakdown.unit_fob_price;
  const totalPrice = round2(unitPrice * quantity);

  return {
    ok: true,
    unit_price: round2(unitPrice),
    total_price: totalPrice,
    currency: 'USD',
    breakdown,
    validity: {
      effective_from: product.effective_date,
      expires_on: product.expiry_date,
    },
    source: {
      doc_id: product.source_doc_id,
      product_id: product.id,
    },
    confidence: product.confidence,
  };
}

// ── 3. lookupShipping ────────────────────────────────────────────────

export async function lookupShipping({
  tenantId, productLineId,
  destinationPort, shippingMethod, originPort,
}) {
  if (!tenantId || !productLineId) throw new Error('lookupShipping: tenantId+productLineId required');
  if (!destinationPort) return { found: false, missing_fields: ['destination_port'] };

  let q = supabase
    .from('kb_shipping_routes')
    .select('id, origin_port, destination_port, destination_country, shipping_method, cost_per_unit_usd, transit_days, notes, effective_date, expiry_date, confidence, source_doc_id')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .ilike('destination_port', `%${destinationPort}%`);
  q = highConfidenceFilter(q);
  q = notExpiredFilter(q);
  if (shippingMethod) q = q.eq('shipping_method', shippingMethod);
  if (originPort) q = q.ilike('origin_port', `%${originPort}%`);

  const { data, error } = await q.limit(1);
  if (error) throw new Error(`lookupShipping failed: ${error.message}`);

  if (!data || data.length === 0) {
    // Suggest alternatives in the same country
    const { data: alts } = await supabase
      .from('kb_shipping_routes')
      .select('destination_port, transit_days')
      .eq('tenant_id', tenantId)
      .eq('product_line_id', productLineId)
      .ilike('destination_country', `%${destinationPort}%`)
      .limit(3);
    return {
      found: false,
      alternatives: (alts || []).map(a => ({
        destination_port: a.destination_port,
        transit_days: a.transit_days,
      })),
    };
  }

  const r = data[0];
  return {
    found: true,
    route: {
      origin_port: r.origin_port,
      destination_port: r.destination_port,
      destination_country: r.destination_country,
      shipping_method: r.shipping_method,
      unit_cost: r.cost_per_unit_usd,
      currency: 'USD',
      transit_days: r.transit_days,
      validity: { effective_from: r.effective_date, expires_on: r.expiry_date },
      source: { doc_id: r.source_doc_id, route_id: r.id },
      confidence: r.confidence,
    },
  };
}

// ── 4. lookupPolicy (also folds in QA snippet search) ────────────────

// Topic → layer hint for vector search. After the four-layer consolidation,
// 资质 / 认证 类话题归入 company（公司基础信息），竞品话题归入 sales（话术）。
const TOPIC_TO_LAYERS = {
  payment_terms: ['product', 'sales'],
  warranty: ['company', 'sales'],
  after_sales: ['company', 'sales'],
  export_qualification: ['company'],
  certification: ['company'],
  company_background: ['company'],
  competitive: ['sales'],
};

/**
 * @param {Object} input
 * @param {string} [input.topic]
 * @param {string} [input.subtopic]
 * @param {string} [input.freeText]            Free-text customer question (triggers QA snippet search)
 * @param {string} [input.destinationCountry]  Filter by country if applicable
 */
export async function lookupPolicy({
  tenantId, productLineId,
  topic, subtopic, freeText, destinationCountry,
}) {
  if (!tenantId || !productLineId) throw new Error('lookupPolicy: tenantId+productLineId required');

  const searchQuery = [topic, subtopic, freeText].filter(Boolean).join(' — ');
  if (!searchQuery) {
    return { found: false, answer_text: '', citations: [] };
  }

  // 1. QA snippets first (sales-curated > extracted narratives)
  const qaSnippet = await searchQaSnippet({ tenantId, productLineId, query: searchQuery, destinationCountry });
  if (qaSnippet) {
    return {
      found: true,
      answer_text: qaSnippet.answer,
      citations: [{ kind: 'qa_snippet', id: qaSnippet.id, last_updated: qaSnippet.updated_at, confidence: 'verified' }],
      caveats: qaSnippet.applicable_when?.caveats || undefined,
    };
  }

  // 2. Knowledge points vector search restricted to relevant layers
  const layers = topic && TOPIC_TO_LAYERS[topic] ? TOPIC_TO_LAYERS[topic] : null;
  const queryLang = detectLanguage(searchQuery);
  const englishQuery = queryLang === 'en' ? searchQuery : await translateToEnglish(searchQuery, tenantId);
  const embedding = await generateEmbedding(englishQuery);

  const { data, error } = await supabase.rpc('search_kb_knowledge_en', {
    p_tenant_id: tenantId,
    p_product_line_id: productLineId,
    p_embedding: embedding,
    p_layers: layers,
    p_top_k: 3,
  });
  if (error) throw new Error(`lookupPolicy KP search failed: ${error.message}`);

  if (!data || data.length === 0) {
    return { found: false, answer_text: '', citations: [] };
  }

  // Synthesize: take top result's content as the answer, add citations from all
  const top = data[0];
  const docIds = [...new Set(data.map(r => r.doc_id).filter(Boolean))];
  const { data: docs } = await supabase
    .from('kb_documents')
    .select('id, filename, updated_at')
    .in('id', docIds);
  const docMap = Object.fromEntries((docs || []).map(d => [d.id, d]));

  return {
    found: true,
    answer_text: top.content_en || top.content_original,
    citations: data.map(r => ({
      kind: 'knowledge_point',
      id: r.id,
      doc_id: r.doc_id,
      filename: docMap[r.doc_id]?.filename,
      source_location: r.source_location,
      last_updated: docMap[r.doc_id]?.updated_at,
      similarity: r.similarity,
    })),
  };
}

async function searchQaSnippet({ tenantId, productLineId, query, destinationCountry }) {
  const queryLang = detectLanguage(query);
  const englishQuery = queryLang === 'en' ? query : await translateToEnglish(query, tenantId);
  const embedding = await generateEmbedding(englishQuery);

  const { data, error } = await supabase.rpc('search_kb_qa_snippets', {
    p_tenant_id: tenantId,
    p_product_line_id: productLineId,
    p_embedding: embedding,
    p_top_k: 3,
  });
  if (error || !data || data.length === 0) return null;

  // Filter by applicable_when.destination_country if present.
  // QA snippets are sales-curated, so we trust mid-range similarity (>=0.5).
  // Real-world example: "do you take LC?" vs "Do you accept LC payment?"
  // scores ~0.54 even though they're functionally identical.
  for (const candidate of data) {
    if (candidate.similarity < 0.5) continue;
    const applicable = candidate.applicable_when || {};
    if (applicable.destination_country && destinationCountry &&
        applicable.destination_country !== destinationCountry) {
      continue;
    }
    // Need updated_at — fetch it
    const { data: full } = await supabase
      .from('kb_qa_snippets')
      .select('id, answer, applicable_when, updated_at')
      .eq('id', candidate.id)
      .single();
    return full;
  }
  return null;
}

// ── 5. findAsset ─────────────────────────────────────────────────────

/**
 * @param {Object} input
 * @param {string} [input.type]
 * @param {string} [input.sku]
 * @param {string} [input.view]
 * @param {string} [input.color]
 * @param {string} [input.scenario]
 * @param {string} [input.naturalLanguage]  Free-text fallback for semantic search
 * @returns {Promise<{assets: Object[]}>}
 */
export async function findAsset({
  tenantId, productLineId,
  type, sku, view, color, scenario, naturalLanguage,
}) {
  if (!tenantId || !productLineId) throw new Error('findAsset: tenantId+productLineId required');

  // 1. Tag-based (preferred)
  let q = supabase
    .from('kb_assets')
    .select('id, asset_type, filename, storage_path, mime_type, description, description_en, view, color, scenario, language, linked_skus, is_sendable, expiry_date')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId);
  q = q.or(`expiry_date.is.null,expiry_date.gt.${todayIso()}`);

  if (type) q = q.eq('asset_type', type);
  if (sku) q = q.contains('linked_skus', [sku]);
  if (view) q = q.eq('view', view);
  if (color) q = q.eq('color', color);
  if (scenario) q = q.eq('scenario', scenario);

  const hasTagFilter = type || sku || view || color || scenario;
  const { data: tagMatches, error } = await q.limit(10);
  if (error) throw new Error(`findAsset tag query failed: ${error.message}`);

  if (hasTagFilter && tagMatches && tagMatches.length > 0) {
    return {
      assets: tagMatches.map(a => formatAsset(a, 'tag')),
    };
  }

  // 2. Semantic fallback (only if naturalLanguage given AND no tag match)
  if (naturalLanguage) {
    const queryLang = detectLanguage(naturalLanguage);
    const englishQuery = queryLang === 'en' ? naturalLanguage : await translateToEnglish(naturalLanguage, tenantId);
    const embedding = await generateEmbedding(englishQuery);

    // Manual nearest-neighbor (no RPC for this — small table, OK for now)
    const { data: candidates } = await supabase
      .from('kb_assets')
      .select('id, asset_type, filename, storage_path, mime_type, description, description_en, view, color, scenario, language, linked_skus, is_sendable, caption_embedding, expiry_date')
      .eq('tenant_id', tenantId)
      .eq('product_line_id', productLineId)
      .not('caption_embedding', 'is', null);

    const scored = (candidates || [])
      .map(a => ({
        ...a,
        similarity: cosineSimilarity(embedding, a.caption_embedding),
      }))
      .filter(a => a.similarity > 0.7)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    return {
      assets: scored.map(a => formatAsset(a, 'semantic', a.similarity)),
    };
  }

  return { assets: [] };
}

function formatAsset(a, matchedBy, similarity) {
  return {
    asset_id: a.id,
    type: a.asset_type,
    filename: a.filename,
    storage_path: a.storage_path,
    mime_type: a.mime_type,
    view: a.view,
    color: a.color,
    scenario: a.scenario,
    language: a.language,
    linked_skus: a.linked_skus,
    is_sendable_to_customer: a.is_sendable,
    caption: a.description_en || a.description,
    matched_by: matchedBy,
    ...(similarity != null ? { confidence: round2(similarity) } : {}),
  };
}

function cosineSimilarity(a, b) {
  // pgvector returns string like "[0.1,0.2,...]" when selected as raw column
  const vb = typeof b === 'string' ? JSON.parse(b) : b;
  if (!Array.isArray(vb) || vb.length !== a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * vb[i];
    na += a[i] * a[i];
    nb += vb[i] * vb[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── 6. checkConstraint ───────────────────────────────────────────────

// medici 的 action 词汇 → kb_pricing_rules.rule_type 映射
// （旧表的 rule_type 只有 4 个枚举值，跨不出去的 action 直接返 unknown）
const ACTION_TO_RULE_TYPE = {
  give_discount: 'quantity_discount',
  accept_payment_term: 'payment_term',
  apply_shipping_markup: 'shipping_markup',
  apply_special_offer: 'special_offer',
};

/**
 * Check whether an action is allowed by stored business rules.
 *
 * @param {Object} input
 * @param {string} input.action   e.g. 'give_discount' | 'accept_payment_term'
 * @param {Object} input.context  free-form, depends on action
 */
export async function checkConstraint({ tenantId, productLineId, action, context = {} }) {
  if (!tenantId || !productLineId) throw new Error('checkConstraint: tenantId+productLineId required');

  const ruleType = ACTION_TO_RULE_TYPE[action];
  if (!ruleType) {
    return { decision: 'unknown', reason: `no rule_type mapped for action '${action}'` };
  }

  const { data, error } = await supabase
    .from('kb_pricing_rules')
    .select('id, rule_name, rule_type, conditions, calculation, requires_approval, effective_from, effective_until, priority')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('is_active', true)
    .eq('rule_type', ruleType)
    .order('priority', { ascending: false });
  if (error) throw new Error(`checkConstraint failed: ${error.message}`);

  if (!data || data.length === 0) {
    return { decision: 'unknown', reason: `no rule defined for action '${action}'` };
  }

  const today = todayIso();
  for (const rule of data) {
    if (rule.effective_from && rule.effective_from > today) continue;
    if (rule.effective_until && rule.effective_until < today) continue;

    // Match conditions: every condition key in rule must equal context value
    const conds = rule.conditions || {};
    let matches = true;
    for (const [k, v] of Object.entries(conds)) {
      if (context[k] !== v) { matches = false; break; }
    }
    if (!matches) continue;

    return {
      decision: rule.requires_approval ? 'requires_approval' : 'allowed',
      reason: rule.rule_name,
      rule_source: { rule_id: rule.id, rule_name: rule.rule_name },
      calculation: rule.calculation,
    };
  }

  return { decision: 'unknown', reason: `no rule matched context for action '${action}'` };
}
