/**
 * Knowledge Base Upload & Parse Service
 *
 * Handles file upload, AI-powered parsing, bilingual translation,
 * embedding generation, and structured data extraction.
 */
import { jsonrepair } from 'jsonrepair';
import { openrouter, MODELS } from './llm-client.js';
import { generateEmbedding, translateToEnglish, detectLanguage } from './kb-search.service.js';
import supabase from '../lib/supabase.js';
import { createTraceLogger } from '../lib/core-trace.js';

const logger = createTraceLogger({ service: 'kb-upload' });

// ── Constants ────────────────────────────────────────────────────────

const CHUNK_SIZE = 800; // tokens approx (characters / 1.5 for Chinese)
const CHUNK_OVERLAP = 100;

const LAYER_LABELS = {
  company: 'Company Foundation',
  product: 'Products & Pricing',
  logistics: 'Logistics & Delivery',
  sales: 'Sales Playbook',
};

// ── Main Upload Flow ─────────────────────────────────────────────────

/**
 * Process an uploaded file: parse → extract knowledge → translate → embed.
 *
 * 写入 kb_* 表时同时填 agent_id（NOT NULL，老 schema）和 product_line_id
 * （新 schema，新查询路径）。读路径已切到 product_line_id。
 *
 * @param {Object} ctx - { tenantId, agentId, productLineId }
 * @param {string} docId - kb_documents.id（already created by the API route）
 * @param {string} fileContent
 * @param {string} layer
 * @param {Object} options - { filename, fileType }
 */
export async function processDocument(ctx, docId, fileContent, layer, options = {}) {
  const { tenantId, agentId, productLineId } = ctx || {};
  if (!tenantId || !agentId || !productLineId) {
    throw new Error('processDocument: tenantId, agentId, productLineId required');
  }
  const { filename = '', fileType = 'txt' } = options;

  try {
    await updateDocStatus(docId, 'processing');

    // Step 1: Extract knowledge points using LLM
    const extracted = await extractKnowledgePoints(fileContent, layer, fileType, tenantId);

    // Step 2 + Step 3 跑成并行：
    //   - 结构化抽取（产品 / 物流层）一次 LLM 调用，独立写 kb_products / kb_shipping_routes
    //   - 知识点逐条 translate + embed + insert，并发 8 路（每条 1-2 个 LLM 调用）
    // 并发上限 8 来自 OpenRouter / OpenAI 的稳定性 vs 速度的平衡点。
    const KP_CONCURRENCY = 8;
    const points = extracted.knowledge_points || [];

    const structuredTask =
      layer === 'product' ? extractStructuredProducts(ctx, docId, fileContent, fileType) :
      layer === 'logistics' ? extractStructuredShipping(ctx, docId, fileContent, fileType) :
      Promise.resolve();

    const kpTask = mapWithConcurrency(points, async (point) => {
      const pointId = await processKnowledgePoint(ctx, docId, layer, point);
      const conflict = await detectConflict({ tenantId, productLineId }, docId, layer, point, pointId);
      return { ok: true, conflict };
    }, KP_CONCURRENCY).catch(err => {
      logger.error('kb.upload.kp_batch_failed', { docId, error: err.message });
      throw err;
    });

    const [, kpResults] = await Promise.all([structuredTask, kpTask]);
    const storedCount = kpResults.length;
    const conflicts = kpResults.map(r => r?.conflict).filter(Boolean);

    // Step 4: Update document status
    await supabase
      .from('kb_documents')
      .update({
        status: 'ready',
        knowledge_points_count: storedCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', docId);

    logger.info('kb.upload.complete', { docId, agentId, layer, points: storedCount, conflicts: conflicts.length, filename });
    return { knowledge_points: storedCount, conflicts };
  } catch (error) {
    logger.error('kb.upload.failed', { docId, error: error.message });
    await updateDocStatus(docId, 'error', error.message);
    throw error;
  }
}

// ── Knowledge Point Extraction ───────────────────────────────────────

async function extractKnowledgePoints(content, layer, fileType, tenantId) {
  const layerLabel = LAYER_LABELS[layer] || layer;

  const systemPrompt = `You are a knowledge extraction assistant for a B2B export trading company.
Extract discrete knowledge points from the document. Each knowledge point should be a self-contained piece of information that an AI sales agent could use to answer customer questions.

Knowledge layer: ${layerLabel}

Rules:
- Each knowledge point should be 1-3 sentences, complete and self-contained
- Include specific numbers (prices, quantities, dimensions, days) when available
- For product catalogs: one knowledge point per product/SKU
- For price tables: include SKU, product name, price, MOQ, and lead time in each point
- For shipping tables: include origin, destination, cost, and transit time
- For policies: one point per rule or condition
- Include the source location (row number, page, section) for each point
- Output in the same language as the source document

Output as JSON:
{
  "knowledge_points": [
    {
      "content": "the knowledge point text",
      "source_location": "Row 5" or "Page 2, Section 3",
      "metadata": {
        "sku": "optional",
        "product_name": "optional",
        "price_usd": null or number,
        "country": "optional",
        "topic": "brief topic keyword"
      }
    }
  ],
  "detected_type": "product_catalog | price_list | shipping_table | policy_document | faq | general"
}`;

  const response = await openrouter.messages.create({
    models: [MODELS.SONNET],
    max_tokens: 16000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `File type: ${fileType}\n\nDocument content:\n${truncate(content, 15000)}` },
    ],
  }, { tenantId, callSite: 'kb.upload.extract-points' });

  const text = response.choices[0].message.content || '{}';
  const finishReason = response.choices[0].finish_reason;
  try {
    return parseJsonFromLlm(text);
  } catch (err) {
    logger.warn('kb.extract.parse_failed', {
      text: text.slice(0, 500),
      finish_reason: finishReason,
      parse_error: err.message,
    });
    throw new Error(
      `LLM returned unparseable JSON (finish_reason=${finishReason}): ${err.message}`
    );
  }
}

/**
 * Extract JSON from an LLM response. Tolerates markdown code fences (including
 * truncated responses where the closing ``` is missing), pre/post chatter,
 * Python-style single quotes, and trailing commas.
 */
function parseJsonFromLlm(text) {
  let payload = text.trim();
  // Strip opening fence (```json or ```)
  const fenceMatch = payload.match(/^```(?:json)?\s*\n?/);
  if (fenceMatch) payload = payload.slice(fenceMatch[0].length);
  // Strip closing fence if present
  const closingFence = payload.lastIndexOf('```');
  if (closingFence !== -1) payload = payload.slice(0, closingFence);
  payload = payload.trim();
  try {
    return JSON.parse(payload);
  } catch (_) {
    /* fall through */
  }
  try {
    return JSON.parse(jsonrepair(payload));
  } catch (_) {
    /* fall through */
  }
  // Last-ditch: extract the first balanced {...} or [...] block and try repair.
  const sliced = sliceFirstJsonBlock(payload);
  if (sliced) {
    try {
      return JSON.parse(jsonrepair(sliced));
    } catch (err) {
      throw err;
    }
  }
  throw new Error('parseJsonFromLlm: no JSON block found');
}

function sliceFirstJsonBlock(s) {
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = s.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"' || ch === "'") { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ── Process Single Knowledge Point ───────────────────────────────────

async function processKnowledgePoint(ctx, docId, layer, point) {
  const { tenantId, agentId, productLineId } = ctx;
  const originalContent = point.content;
  const sourceLang = detectLanguage(originalContent);

  // Translate to English if not already English
  let englishContent = originalContent;
  if (sourceLang !== 'en') {
    englishContent = await translateToEnglish(originalContent, tenantId);
  }

  // Generate embeddings for both versions
  const [embeddingOriginal, embeddingEn] = await Promise.all([
    generateEmbedding(originalContent),
    sourceLang !== 'en' ? generateEmbedding(englishContent) : generateEmbedding(originalContent),
  ]);

  // Store —— 同时写 agent_id (旧 NOT NULL 列) 和 product_line_id (新查询路径)
  const { data, error } = await supabase.from('kb_knowledge_points').insert({
    tenant_id: tenantId,
    doc_id: docId,
    agent_id: agentId,
    product_line_id: productLineId,
    layer,
    content_original: originalContent,
    content_en: englishContent,
    source_lang: sourceLang,
    metadata_json: point.metadata || {},
    source_location: point.source_location || null,
    authority_level: 3,
    effective_date: new Date().toISOString().split('T')[0],
    status: 'active',
    embedding_original: embeddingOriginal,
    embedding_en: embeddingEn,
  }).select('id').single();

  if (error) throw new Error(`Failed to store knowledge point: ${error.message}`);
  return data.id;
}

// ── Structured Product Extraction ────────────────────────────────────

async function extractStructuredProducts(ctx, docId, content, fileType) {
  const { tenantId, agentId, productLineId } = ctx;
  const systemPrompt = `Extract structured product data from this document. Be permissive: the
source can be an Excel sheet with arbitrary columns, a price-list PDF, a Word
catalog, a markdown table, or even free-form text describing models. Column /
field names may be Chinese, English, or mixed. There is NO required field.

For each product/model/SKU you can identify, output one row. If a field is not
present, use null — do not fabricate. Put any other useful attribute (color,
horsepower, dimensions, fuel type, drive layout, certifications, warranty,
discount tiers, etc.) into "specs" as key→value.

Schema (every field optional except produce a row only when you actually see
something product-shaped):
{
  "sku": "string or null",
  "product_name": "string or null",
  "product_name_en": "English name or null",
  "model": "string or null",
  "category": "string or null (e.g. tractor, harvester, parts, sedan, EV truck)",
  "specs": { "key": "value" pairs — anything that isn't a top-level column },
  "fob_price_usd": number or null (convert other currencies to USD if rate is in the doc; otherwise leave null and put the original price/currency in specs.original_price),
  "moq": number or null,
  "lead_time_days": "string or null (free text OK, e.g. '45 days' / '4-6 weeks')",
  "source_row": number or null
}

Rules:
- Never reject a row just because SKU or price is missing — store what you have.
- If the document describes multiple variants of the same model, emit one row per variant.
- If the document is not about products at all, return { "products": [] }.

Output STRICT JSON only — double quotes around all keys and string values, no
single quotes, no trailing commas, no comments, no Python-style dicts. Wrap
the whole thing in a single object: { "products": [...] }`;

  // 放宽 schema 后 LLM 倾向输出更多结构化行（每个变体一行 + 任意 specs），
  // 16k tokens 在长价目表上会被截断 → 提到 32k 兜底；jsonrepair 还会处理零星语法问题。
  const response = await openrouter.messages.create({
    models: [MODELS.SONNET],
    max_tokens: 32000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `File type: ${fileType}\n\nContent:\n${truncate(content, 15000)}` },
    ],
  }, { tenantId, callSite: 'kb.upload.extract-products' });

  const text = response.choices[0].message.content || '{}';
  const finishReason = response.choices[0].finish_reason;
  let parsed;
  try {
    parsed = parseJsonFromLlm(text);
  } catch (err) {
    logger.warn('kb.products.parse_failed', {
      docId,
      finish_reason: finishReason,
      parse_error: err.message,
    });
    return;
  }

  if (!parsed.products?.length) return;

  const rows = parsed.products.map(p => ({
    tenant_id: tenantId,
    doc_id: docId,
    agent_id: agentId,
    product_line_id: productLineId,
    sku: p.sku || null,
    product_name: p.product_name || null,
    product_name_en: p.product_name_en || null,
    model: p.model || null,
    category: p.category || null,
    specs: p.specs || {},
    fob_price_usd: p.fob_price_usd || null,
    moq: p.moq || null,
    lead_time_days: p.lead_time_days || null,
    source_row: p.source_row || null,
  }));

  const { error } = await supabase.from('kb_products').insert(rows);
  if (error) logger.error('kb.products.insert_failed', { error: error.message });
  else logger.info('kb.products.extracted', { count: rows.length, docId });
}

// ── Structured Shipping Extraction ───────────────────────────────────

async function extractStructuredShipping(ctx, docId, content, fileType) {
  const { tenantId, agentId, productLineId } = ctx;
  const systemPrompt = `Extract structured shipping / logistics / delivery route data from this
document. Be permissive: the source can be an Excel rate card, a freight
forwarder quote PDF, a Word document, an Incoterms guide, or free-form text
describing routes. Column / field names may be Chinese, English, or mixed.

For each route or rate you can identify, output one row. There is NO required
field — if the document only gives a destination country (no port), still emit a
row with destination_country set. If it gives a flat rate without a destination,
put the rate's scope in "notes". Never reject a row for missing fields.

Schema (every field optional):
{
  "origin_port": "string or null",
  "destination_port": "string or null",
  "destination_country": "string or null",
  "shipping_method": "string or null (free text OK: sea_bulk, sea_container, RoRo, rail, air, multimodal, ...)",
  "cost_per_unit_usd": number or null (convert other currencies to USD if rate is in the doc; otherwise leave null and put the original cost/currency in notes),
  "transit_days": "string or null (free text OK, e.g. '25-30 days')",
  "notes": "string or null (anything else: validity window, surcharges, vessel constraints, customs caveats)"
}

Rules:
- If a row is per-container or per-CBM rather than per-unit, set cost_per_unit_usd to null and describe in notes.
- If the document is purely commercial terms (Incoterms / payment / trade rules) and not actually a shipping rate sheet, return { "routes": [] } — those will be captured by the knowledge-points pipeline instead.

Output STRICT JSON only — double quotes, no single quotes, no trailing commas,
no comments, no Python-style dicts. Wrap as { "routes": [...] }`;

  const response = await openrouter.messages.create({
    models: [MODELS.SONNET],
    max_tokens: 16000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `File type: ${fileType}\n\nContent:\n${truncate(content, 15000)}` },
    ],
  }, { tenantId, callSite: 'kb.upload.extract-shipping' });

  const text = response.choices[0].message.content || '{}';
  const finishReason = response.choices[0].finish_reason;
  let parsed;
  try {
    parsed = parseJsonFromLlm(text);
  } catch (err) {
    logger.warn('kb.shipping.parse_failed', {
      docId,
      finish_reason: finishReason,
      parse_error: err.message,
    });
    return;
  }

  if (!parsed.routes?.length) return;

  const rows = parsed.routes.map(r => ({
    tenant_id: tenantId,
    doc_id: docId,
    agent_id: agentId,
    product_line_id: productLineId,
    origin_port: r.origin_port || null,
    destination_port: r.destination_port || null,
    destination_country: r.destination_country || null,
    shipping_method: r.shipping_method || null,
    cost_per_unit_usd: r.cost_per_unit_usd || null,
    transit_days: r.transit_days || null,
    notes: r.notes || null,
  }));

  const { error } = await supabase.from('kb_shipping_routes').insert(rows);
  if (error) logger.error('kb.shipping.insert_failed', { error: error.message });
  else logger.info('kb.shipping.extracted', { count: rows.length, docId });
}

// ── Conflict Detection ───────────────────────────────────────────────

/**
 * Detect if a newly stored knowledge point conflicts with existing ones.
 * Checks for high-similarity points in the same layer from different documents.
 * Returns conflict info or null if no conflict.
 */
async function detectConflict({ tenantId, productLineId }, newDocId, layer, point, newPointId) {
  // Only detect conflicts for points that have specific factual data
  const hasPriceData = point.metadata?.price_usd != null;
  const hasSku = !!point.metadata?.sku;
  if (!hasPriceData && !hasSku) return null;

  // Search for existing knowledge points with same SKU or high similarity
  let existingPoints = [];

  if (hasSku) {
    // SKU-based conflict: find existing points with same SKU in different docs
    const { data } = await supabase
      .from('kb_knowledge_points')
      .select('id, content_original, content_en, metadata_json, doc_id, source_location, authority_level')
      .eq('tenant_id', tenantId)
      .eq('product_line_id', productLineId)
      .eq('layer', layer)
      .eq('status', 'active')
      .neq('doc_id', newDocId)
      .limit(5);

    // Filter to those with matching SKU
    existingPoints = (data || []).filter(p =>
      p.metadata_json?.sku && p.metadata_json.sku === point.metadata.sku
    );
  }

  if (existingPoints.length === 0) return null;

  // Check for actual value conflicts (e.g., different prices for same SKU)
  const newPrice = point.metadata?.price_usd;
  for (const existing of existingPoints) {
    const oldPrice = existing.metadata_json?.price_usd;

    if (newPrice != null && oldPrice != null && newPrice !== oldPrice) {
      // Get document filenames for the conflict report
      const docIds = [newDocId, existing.doc_id].filter(Boolean);
      const { data: docs } = await supabase
        .from('kb_documents')
        .select('id, filename')
        .in('id', docIds);
      const docMap = Object.fromEntries((docs || []).map(d => [d.id, d.filename]));

      return {
        type: 'price_conflict',
        sku: point.metadata.sku,
        field: 'price_usd',
        new_value: newPrice,
        new_source: `${docMap[newDocId] || 'new document'} (${point.source_location || ''})`,
        new_point_id: newPointId,
        old_value: oldPrice,
        old_source: `${docMap[existing.doc_id] || 'existing document'} (${existing.source_location || ''})`,
        old_point_id: existing.id,
      };
    }
  }

  return null;
}

/**
 * Resolve a conflict between knowledge points.
 *
 * @param {string} resolution - 'use_new' | 'keep_old' | 'coexist'
 * @param {string} newPointId - The new knowledge point ID
 * @param {string} oldPointId - The existing knowledge point ID
 */
export async function resolveConflict(resolution, newPointId, oldPointId) {
  if (resolution === 'use_new') {
    // Supersede the old point
    await supabase
      .from('kb_knowledge_points')
      .update({ status: 'superseded', superseded_by: newPointId })
      .eq('id', oldPointId);

    // Also update structured product data if applicable
    const { data: oldPoint } = await supabase
      .from('kb_knowledge_points')
      .select('metadata_json, agent_id')
      .eq('id', oldPointId)
      .single();

    if (oldPoint?.metadata_json?.sku) {
      // Deactivate old product records from the old doc
      const { data: oldKp } = await supabase
        .from('kb_knowledge_points')
        .select('doc_id')
        .eq('id', oldPointId)
        .single();

      if (oldKp?.doc_id) {
        await supabase
          .from('kb_products')
          .update({ is_active: false })
          .eq('doc_id', oldKp.doc_id)
          .ilike('sku', `%${oldPoint.metadata_json.sku}%`);
      }
    }
  } else if (resolution === 'keep_old') {
    // Supersede the new point
    await supabase
      .from('kb_knowledge_points')
      .update({ status: 'superseded', superseded_by: oldPointId })
      .eq('id', newPointId);
  } else if (resolution === 'coexist') {
    // Both remain active — no action needed
    // Optionally, set effective_date ranges if provided
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function updateDocStatus(docId, status, errorMessage = null) {
  await supabase
    .from('kb_documents')
    .update({
      status,
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq('id', docId);
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[... content truncated ...]';
}

// Cap concurrency over an array — like Promise.all but with worker-pool throttling.
async function mapWithConcurrency(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
