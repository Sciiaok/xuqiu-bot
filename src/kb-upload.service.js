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
  logistics: 'Logistics & Shipping',
  compliance: 'Compliance & Certification',
  sales: 'Sales Playbook',
  competitive: 'Competitive Intelligence',
};

// ── Main Upload Flow ─────────────────────────────────────────────────

/**
 * Process an uploaded file: parse → extract knowledge → translate → embed.
 *
 * @param {string} agentId
 * @param {string} docId - kb_documents.id (already created by the API route)
 * @param {string} fileContent - Text content of the file (already extracted by API route)
 * @param {string} layer
 * @param {Object} options
 * @param {string} options.filename
 * @param {string} options.fileType - csv / xlsx_text / pdf_text / markdown / txt
 */
export async function processDocument(agentId, docId, fileContent, layer, options = {}) {
  const { filename = '', fileType = 'txt' } = options;

  try {
    await updateDocStatus(docId, 'processing');

    // Step 1: Extract knowledge points using LLM
    const extracted = await extractKnowledgePoints(fileContent, layer, fileType);

    // Step 2: For product/logistics layers, also extract structured data
    if (layer === 'product') {
      await extractStructuredProducts(agentId, docId, fileContent, fileType);
    }
    if (layer === 'logistics') {
      await extractStructuredShipping(agentId, docId, fileContent, fileType);
    }

    // Step 3: Process each knowledge point (translate + embed + store)
    let storedCount = 0;
    const conflicts = [];
    for (const point of extracted.knowledge_points) {
      const pointId = await processKnowledgePoint(agentId, docId, layer, point);
      storedCount++;

      // Step 3b: Conflict detection — check if this point conflicts with existing knowledge
      const conflict = await detectConflict(agentId, docId, layer, point, pointId);
      if (conflict) conflicts.push(conflict);
    }

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

async function extractKnowledgePoints(content, layer, fileType) {
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
  });

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
 * Extract JSON from an LLM response. Tolerates markdown code fences,
 * including truncated responses where the closing ``` is missing.
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
  } catch (err) {
    // Fallback: repair common LLM JSON issues (unescaped quotes/newlines, trailing commas, truncation)
    return JSON.parse(jsonrepair(payload));
  }
}

// ── Process Single Knowledge Point ───────────────────────────────────

async function processKnowledgePoint(agentId, docId, layer, point) {
  const originalContent = point.content;
  const sourceLang = detectLanguage(originalContent);

  // Translate to English if not already English
  let englishContent = originalContent;
  if (sourceLang !== 'en') {
    englishContent = await translateToEnglish(originalContent, agentId);
  }

  // Generate embeddings for both versions
  const [embeddingOriginal, embeddingEn] = await Promise.all([
    generateEmbedding(originalContent),
    sourceLang !== 'en' ? generateEmbedding(englishContent) : generateEmbedding(originalContent),
  ]);

  // Store
  const { data, error } = await supabase.from('kb_knowledge_points').insert({
    doc_id: docId,
    agent_id: agentId,
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

async function extractStructuredProducts(agentId, docId, content, fileType) {
  const systemPrompt = `Extract structured product data from this document. Output as JSON array.
Each product should have:
{
  "sku": "string or null",
  "product_name": "string",
  "product_name_en": "English name",
  "model": "string or null",
  "category": "string (e.g. tractor, harvester, parts)",
  "specs": { "key": "value" pairs for technical specifications },
  "fob_price_usd": number or null,
  "moq": number or null,
  "lead_time_days": "string or null",
  "source_row": number or null
}

Output: { "products": [...] }
If no product data found, output: { "products": [] }`;

  const response = await openrouter.messages.create({
    models: [MODELS.SONNET],
    max_tokens: 16000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `File type: ${fileType}\n\nContent:\n${truncate(content, 15000)}` },
    ],
  });

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
    doc_id: docId,
    agent_id: agentId,
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

async function extractStructuredShipping(agentId, docId, content, fileType) {
  const systemPrompt = `Extract structured shipping route data from this document. Output as JSON array.
Each route should have:
{
  "origin_port": "string",
  "destination_port": "string",
  "destination_country": "string",
  "shipping_method": "sea_bulk | sea_container | rail | air",
  "cost_per_unit_usd": number or null,
  "transit_days": "string (e.g. '25-30')",
  "notes": "string or null"
}

Output: { "routes": [...] }
If no shipping data found, output: { "routes": [] }`;

  const response = await openrouter.messages.create({
    models: [MODELS.SONNET],
    max_tokens: 4000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `File type: ${fileType}\n\nContent:\n${truncate(content, 10000)}` },
    ],
  });

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
    doc_id: docId,
    agent_id: agentId,
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
async function detectConflict(agentId, newDocId, layer, point, newPointId) {
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
      .eq('agent_id', agentId)
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
