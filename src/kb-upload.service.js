/**
 * Knowledge Base Upload & Parse Service
 *
 * Pipeline (entry: processDocument):
 *   1. 把入参规整成 chunks 数组（非 Excel = 1 chunk；Excel 在 route 层已切片）
 *   2. 对每个 chunk 并发跑「KP 抽取 + 结构化抽取」两条 LLM 通道
 *   3. 汇总所有 chunk 的 KP，按并发 8 路逐条 translate + embed + insert，跑冲突检测
 *   4. 结构化结果按层批量写 kb_products / kb_shipping_routes
 *   5. 任一 chunk 报告 input/output 截断 → 文档落 status='partial' + partial_reason
 *
 * 写表时同时填 agent_id（旧 NOT NULL）和 product_line_id（新查询路径）。
 */
import { jsonrepair } from 'jsonrepair';
import { openrouter, MODELS } from './llm-client.js';
import { generateEmbedding, translateToEnglish, detectLanguage } from './kb-search.service.js';
import supabase from '../lib/supabase.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { createTraceLogger } from '../lib/core-trace.js';

const logger = createTraceLogger({ service: 'kb-upload' });

// ── Constants ────────────────────────────────────────────────────────

// 单次 LLM 调用的输入字符上限。Sonnet 4.6 上下文是 1M tokens（GA），
// 600K 字符 ~150K~200K tokens（中文密集时更大），给 system prompt + 输出 +
// 路由波动留充分余量。Excel 走 chunked 路径，不会触发这个 cap。
const LLM_INPUT_HARD_CAP_CHARS = 600_000;

// 输出 token 预算。每行 JSON ~150-250 tokens（中英+specs）。
// 32K → 单次调用最多产 ~150 条结构化行 / KP。chunked 模式下每片 80 行远远够；
// 非 Excel 单次模式可能撞顶 → 通过 finish_reason='length' 检测并标 partial。
const KP_MAX_TOKENS       = 32_000;
const PRODUCTS_MAX_TOKENS = 32_000;
const SHIPPING_MAX_TOKENS = 32_000;

const KP_CONCURRENCY = 8;           // 单 KP translate+embed 的并发
const PASS_CONCURRENCY = 3;         // 多 chunk 时并行抽取的并发上限

const LAYER_LABELS = {
  company: 'Company Foundation',
  product: 'Products & Pricing',
  logistics: 'Logistics & Delivery',
  sales: 'Sales Playbook',
};

// ── Input normalization & truncation ────────────────────────────────

/**
 * 把 processDocument 接收的 content 入参规整成 chunks 数组。
 *   - string  → [{ label:'full', content }]
 *   - array   → [{ label, content }] (label 缺省时补 chunk-N)
 * 每个 chunk 的 content 还要再过 capInputForLlm 兜底。
 */
function normalizeToChunks(input) {
  if (typeof input === 'string') {
    return [{ label: 'full', content: input }];
  }
  if (Array.isArray(input) && input.length > 0) {
    return input.map((c, i) => ({
      label: c.label || `chunk-${i + 1}`,
      content: c.content || '',
    }));
  }
  throw new Error('processDocument: content must be a non-empty string or array of {label, content}');
}

/**
 * 防御性 truncate。返回 { content, truncated, original_chars }。
 *   - 触发上限说明文件过大（>600K 字符，比单文件 50MB 阈值更早触发）
 *   - 真触发时落 warn 日志 + 让上层把 doc 标 partial
 * 不再静默截断 ── 这是这次修复的根因。
 */
function capInputForLlm(content, { docId, callSite }) {
  if (content.length <= LLM_INPUT_HARD_CAP_CHARS) {
    return { content, truncated: false, original_chars: content.length };
  }
  logger.warn('kb.upload.input_truncated', {
    docId,
    call_site: callSite,
    original_chars: content.length,
    cap_chars: LLM_INPUT_HARD_CAP_CHARS,
  });
  return {
    content: content.slice(0, LLM_INPUT_HARD_CAP_CHARS) + '\n\n[... content truncated by input cap ...]',
    truncated: true,
    original_chars: content.length,
  };
}

// ── Main Upload Flow ─────────────────────────────────────────────────

/**
 * Process an uploaded file. See module header for the pipeline.
 *
 * @param {Object} ctx          { tenantId, agentId, productLineId }
 * @param {string} docId        kb_documents.id（已由 API route 创建）
 * @param {string|Array} fileContent
 *   - string: 整篇文本，单 chunk 模式（PDF / Word / MD / TXT / 小 Excel）
 *   - Array<{label, content}>: 预切片，chunked 模式（大 Excel 来自 extractExcelChunks）
 * @param {string} layer        'company' | 'product' | 'logistics' | 'sales'
 * @param {Object} options
 *   { filename, fileType, onProgress({stage, ...}), isReparse }
 *   stages: 'extracting' | 'embedding' | 'structured'
 *   isReparse=true 时：抽取阶段失败 → **保留旧数据**，把 doc 还原成之前的状态 +
 *     error_message 标注失败原因；抽取阶段成功后才删旧数据写新数据。
 *
 * @returns {Promise<{knowledge_points:number, conflicts:Object[], status:'ready'|'partial', partial_reason?:string}>}
 */
export async function processDocument(ctx, docId, fileContent, layer, options = {}) {
  const { tenantId, agentId, productLineId } = ctx || {};
  if (!tenantId || !agentId || !productLineId) {
    throw new Error('processDocument: tenantId, agentId, productLineId required');
  }
  const { filename = '', fileType = 'txt', onProgress = () => {}, isReparse = false } = options;

  // reparse 时记录抽取前的 doc 状态，抽取失败时回滚到这里。
  // 首次 upload 时这一步是 'processing'（route 已 INSERT），失败时直接走 'error' 即可。
  let prevSnapshot = null;
  if (isReparse) {
    const { data } = await supabase
      .from('kb_documents')
      .select('status, partial_reason, knowledge_points_count')
      .eq('id', docId)
      .maybeSingle();
    prevSnapshot = data || null;
  }

  // writePhaseStarted 是关键容灾标志：
  //   - false（仅 LLM 抽取阶段失败）：旧数据 *未* 被清，reparse 时回滚状态保留旧数据
  //   - true （已开始落库后失败）：旧数据已清 + 新数据可能半残，必须 cleanup 标 error
  let writePhaseStarted = false;

  try {
    await updateDocStatus(docId, 'processing');

    const chunks = normalizeToChunks(fileContent);
    onProgress({ stage: 'extracting', pass_done: 0, pass_total: chunks.length });

    // ── PHASE 1: 全部 chunk 的 LLM 抽取，**全程不写库** ──────────────────
    // 这是最慢/最易抖动的阶段（Sonnet API、OpenRouter 路由）。在这里失败
    // 不能动旧数据 —— 留着让 Medici 继续能用，用户重试 reparse 即可。
    let passDone = 0;
    const passResults = await mapWithConcurrency(chunks, async (chunk) => {
      const r = await runExtractionPass({
        ctx, docId, layer, fileType,
        content: chunk.content,
        chunkLabel: chunk.label,
      });
      passDone++;
      onProgress({ stage: 'extracting', pass_done: passDone, pass_total: chunks.length });
      return r;
    }, PASS_CONCURRENCY);

    // 聚合
    const allKnowledgePoints = passResults.flatMap(p => p.knowledge_points || []);
    const allStructuredRows = passResults.flatMap(p => p.structured_rows || []);
    const inputTruncated = passResults.some(p => p.input_truncated);
    const outputTruncated = passResults.some(p => p.output_truncated);
    const chunkParseFailed = passResults.some(p => p.parse_failed);

    // ── PHASE 2: 切换到写库阶段 ─ 从这里开始失败要走 cleanup + error ──
    writePhaseStarted = true;

    // reparse 场景：到这一步抽取已经成功，可以安全清旧数据 + 写新数据。
    // 首次 upload 场景：cleanupPartialDoc 是 no-op（这个 doc 还没任何子行）。
    await cleanupPartialDoc(docId);

    // ── 结构化批量写入 ───────────────────────────────────────────────
    if (layer === 'product' && allStructuredRows.length > 0) {
      await insertStructuredRows('kb_products', ctx, docId, allStructuredRows);
      onProgress({ stage: 'structured', kind: 'product', count: allStructuredRows.length });
    } else if (layer === 'logistics' && allStructuredRows.length > 0) {
      await insertStructuredRows('kb_shipping_routes', ctx, docId, allStructuredRows);
      onProgress({ stage: 'structured', kind: 'logistics', count: allStructuredRows.length });
    }

    // ── KP 处理（embed + translate + conflict）逐条并发 ────────────────
    onProgress({ stage: 'embedding', done: 0, total: allKnowledgePoints.length });
    let kpDone = 0;
    const kpResults = await mapWithConcurrency(allKnowledgePoints, async (point) => {
      const pointId = await processKnowledgePoint(ctx, docId, layer, point);
      const conflict = await detectConflict({ tenantId, productLineId }, docId, layer, point, pointId);
      kpDone++;
      if (kpDone % 5 === 0 || kpDone === allKnowledgePoints.length) {
        onProgress({ stage: 'embedding', done: kpDone, total: allKnowledgePoints.length });
      }
      return { ok: true, conflict };
    }, KP_CONCURRENCY).catch(err => {
      logger.error('kb.upload.kp_batch_failed', { docId, error: err.message });
      throw err;
    });

    const storedCount = kpResults.length;
    const conflicts = kpResults.map(r => r?.conflict).filter(Boolean);

    // ── 决定最终 doc 状态 ───────────────────────────────────────────
    const partialReason =
        inputTruncated     ? 'input_truncated'
      : outputTruncated    ? 'output_truncated'
      : chunkParseFailed   ? 'chunk_partial_fail'
      : null;
    const finalStatus = partialReason ? 'partial' : 'ready';

    await finalizeDocStatus(docId, finalStatus, storedCount, partialReason);

    logger.info('kb.upload.complete', {
      docId, agentId, layer, filename,
      points: storedCount, structured: allStructuredRows.length,
      conflicts: conflicts.length,
      passes: chunks.length, status: finalStatus,
      partial_reason: partialReason,
      is_reparse: isReparse,
    });
    return {
      knowledge_points: storedCount,
      conflicts,
      status: finalStatus,
      partial_reason: partialReason,
    };
  } catch (error) {
    logger.error('kb.upload.failed', {
      docId, error: error.message,
      write_phase_started: writePhaseStarted,
      is_reparse: isReparse,
    });

    if (writePhaseStarted) {
      // 已经开始改库了 ── 不管 reparse 还是 first upload，新数据可能半残，必须清掉。
      // reparse 场景里此时旧数据也已经被清，doc 进 error 状态，要求用户再次 reparse。
      // includeAssets=true 是因为这里是失败回滚 —— 把 image-extractor 已经写
      // 进来的 kb_assets 也一并清掉。注意：PHASE 2 入口的 cleanupPartialDoc
      // 不传这个标志（line 166），避免把并行抽取的资产误删。
      await cleanupPartialDoc(docId, { includeAssets: true }).catch(e =>
        logger.error('kb.upload.cleanup_failed', { docId, error: e.message })
      );
      await updateDocStatus(docId, 'error', error.message);
    } else if (isReparse) {
      // 抽取阶段失败 + reparse 模式 → 旧数据完好无损，回滚到之前的状态。
      // Medici 继续用旧数据；UI 看到 error_message 即可重试。
      await restoreDocAfterReparseFailure(docId, prevSnapshot, error.message);
    } else {
      // 抽取阶段失败 + 首次 upload → 没有旧数据可保，直接 error。
      // 子表 cleanup 是 no-op（首次 upload 此时还没任何子行）。
      await updateDocStatus(docId, 'error', error.message);
    }
    throw error;
  }
}

/**
 * 跑一遍 KP + 结构化抽取（一个 chunk 一次 pass）。
 * 不写库 ── 只返回数据 + 截断/失败信号，由 processDocument 聚合后落库。
 */
async function runExtractionPass({ ctx, docId, layer, fileType, content, chunkLabel }) {
  const [kpRes, structRes] = await Promise.all([
    extractKnowledgePoints({
      ctx, docId, content, layer, fileType, chunkLabel,
    }),
    layer === 'product'
      ? extractStructuredProducts({ ctx, docId, content, fileType, chunkLabel })
      : layer === 'logistics'
        ? extractStructuredShipping({ ctx, docId, content, fileType, chunkLabel })
        : Promise.resolve({ rows: [], input_truncated: false, output_truncated: false, parse_failed: false }),
  ]);
  return {
    knowledge_points: kpRes.knowledge_points || [],
    structured_rows: structRes.rows || [],
    input_truncated: kpRes.input_truncated || structRes.input_truncated,
    output_truncated: kpRes.output_truncated || structRes.output_truncated,
    parse_failed: kpRes.parse_failed || structRes.parse_failed,
  };
}

/**
 * Delete partial text-extracted rows for a doc. Called both at PHASE 2 entry
 * (clean slate before new write pass) and on the failure rollback path.
 *
 * Critical: does NOT touch kb_assets. The image extractor runs in PARALLEL
 * with text extraction; image rows can land while PHASE 1 (text LLM passes)
 * is still in flight. Wiping kb_assets here would silently delete the
 * extractor's just-written rows.
 *
 * Asset cleanup is handled by:
 *   - `clearPriorAutoAssets` at the top of `extractAndStoreImages` (covers
 *     reparse and re-upload-of-same-doc cases).
 *   - `cleanupExtractedAssets` exported below, called explicitly from the
 *     failure rollback path so a half-successful upload doesn't leave
 *     orphan asset rows.
 */
export async function cleanupPartialDoc(docId, options = {}) {
  const { includeAssets = false } = options;
  for (const table of ['kb_knowledge_points', 'kb_products', 'kb_shipping_routes']) {
    const { error } = await supabase.from(table).delete().eq('doc_id', docId);
    if (error) throw new Error(`cleanup ${table}: ${error.message}`);
  }
  if (includeAssets) {
    await cleanupExtractedAssets(docId);
  }
}

/**
 * Delete auto-extracted kb_assets (rows + storage objects under
 * `<agent>/extracted/`) for one doc. Idempotent. Safe to call multiple times.
 */
export async function cleanupExtractedAssets(docId) {
  const { data: assets, error: selErr } = await supabase
    .from('kb_assets')
    .select('id, storage_path')
    .eq('source_doc_id', docId)
    .like('storage_path', '%/extracted/%');
  if (selErr) {
    console.warn(`[kb-upload] cleanupExtractedAssets select failed: ${selErr.message}`);
    return;
  }
  if (!assets || assets.length === 0) return;

  const paths = assets.map((a) => a.storage_path).filter(Boolean);
  if (paths.length > 0) {
    try {
      const admin = getSupabaseAdmin();
      await admin.storage.from('kb-assets').remove(paths);
    } catch (e) {
      console.warn(`[kb-upload] cleanupExtractedAssets storage remove failed: ${e?.message}`);
    }
  }
  const { error: delErr } = await supabase
    .from('kb_assets')
    .delete()
    .in('id', assets.map((a) => a.id));
  if (delErr) {
    console.warn(`[kb-upload] cleanupExtractedAssets rows delete failed: ${delErr.message}`);
  }
}

// ── Knowledge Point Extraction ───────────────────────────────────────

async function extractKnowledgePoints({ ctx, docId, content, layer, fileType, chunkLabel }) {
  const { tenantId, productLineId } = ctx;
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

  const callSite = `kb.upload.extract-points${chunkLabel ? `(${chunkLabel})` : ''}`;
  const capped = capInputForLlm(content, { docId, callSite });

  const response = await openrouter.messages.create({
    models: [MODELS.SONNET],
    max_tokens: KP_MAX_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `File type: ${fileType}\n${chunkLabel ? `Chunk: ${chunkLabel}\n` : ''}\nDocument content:\n${capped.content}` },
    ],
  }, { tenantId, callSite, productLine: productLineId });

  const text = response.choices[0].message.content || '{}';
  const finishReason = response.choices[0].finish_reason;
  const outputTruncated = finishReason === 'length';

  let parsed;
  try {
    parsed = parseJsonFromLlm(text);
  } catch (err) {
    logger.warn('kb.extract.parse_failed', {
      docId, call_site: callSite, finish_reason: finishReason,
      text_head: text.slice(0, 500),
      parse_error: err.message,
    });
    return {
      knowledge_points: [],
      input_truncated: capped.truncated,
      output_truncated: outputTruncated,
      parse_failed: true,
    };
  }

  return {
    knowledge_points: parsed.knowledge_points || [],
    input_truncated: capped.truncated,
    output_truncated: outputTruncated,
    parse_failed: false,
  };
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
    englishContent = await translateToEnglish(originalContent, tenantId, productLineId);
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

async function extractStructuredProducts({ ctx, docId, content, fileType, chunkLabel }) {
  const { tenantId, productLineId } = ctx;
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

  const callSite = `kb.upload.extract-products${chunkLabel ? `(${chunkLabel})` : ''}`;
  const capped = capInputForLlm(content, { docId, callSite });

  const response = await openrouter.messages.create({
    models: [MODELS.SONNET],
    max_tokens: PRODUCTS_MAX_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `File type: ${fileType}\n${chunkLabel ? `Chunk: ${chunkLabel}\n` : ''}\nContent:\n${capped.content}` },
    ],
  }, { tenantId, callSite, productLine: productLineId });

  const text = response.choices[0].message.content || '{}';
  const finishReason = response.choices[0].finish_reason;
  const outputTruncated = finishReason === 'length';

  let parsed;
  try {
    parsed = parseJsonFromLlm(text);
  } catch (err) {
    logger.warn('kb.products.parse_failed', {
      docId, call_site: callSite, finish_reason: finishReason,
      parse_error: err.message,
    });
    return { rows: [], input_truncated: capped.truncated, output_truncated: outputTruncated, parse_failed: true };
  }

  const rows = (parsed.products || []).map(p => ({
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
  return { rows, input_truncated: capped.truncated, output_truncated: outputTruncated, parse_failed: false };
}

// ── Structured Shipping Extraction ───────────────────────────────────

async function extractStructuredShipping({ ctx, docId, content, fileType, chunkLabel }) {
  const { tenantId, productLineId } = ctx;
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

  const callSite = `kb.upload.extract-shipping${chunkLabel ? `(${chunkLabel})` : ''}`;
  const capped = capInputForLlm(content, { docId, callSite });

  const response = await openrouter.messages.create({
    models: [MODELS.SONNET],
    max_tokens: SHIPPING_MAX_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `File type: ${fileType}\n${chunkLabel ? `Chunk: ${chunkLabel}\n` : ''}\nContent:\n${capped.content}` },
    ],
  }, { tenantId, callSite, productLine: productLineId });

  const text = response.choices[0].message.content || '{}';
  const finishReason = response.choices[0].finish_reason;
  const outputTruncated = finishReason === 'length';

  let parsed;
  try {
    parsed = parseJsonFromLlm(text);
  } catch (err) {
    logger.warn('kb.shipping.parse_failed', {
      docId, call_site: callSite, finish_reason: finishReason,
      parse_error: err.message,
    });
    return { rows: [], input_truncated: capped.truncated, output_truncated: outputTruncated, parse_failed: true };
  }

  const rows = (parsed.routes || []).map(r => ({
    origin_port: r.origin_port || null,
    destination_port: r.destination_port || null,
    destination_country: r.destination_country || null,
    shipping_method: r.shipping_method || null,
    cost_per_unit_usd: r.cost_per_unit_usd || null,
    transit_days: r.transit_days || null,
    notes: r.notes || null,
  }));
  return { rows, input_truncated: capped.truncated, output_truncated: outputTruncated, parse_failed: false };
}

// ── Structured batch insert ─────────────────────────────────────────

async function insertStructuredRows(table, ctx, docId, rows) {
  if (!rows.length) return 0;
  const { tenantId, agentId, productLineId } = ctx;
  const stamped = rows.map(r => ({
    ...r,
    tenant_id: tenantId,
    doc_id: docId,
    // kb_tools.service.js 的 lookupProduct / lookupShipping 引用的是 source_doc_id
    // 作为 citation 的 doc 字段。写入端只填 doc_id 会让 source_doc_id 为 null，
    // 导致 quote_price 等返回的 source.doc_id 是 null。这里同步两个字段。
    source_doc_id: docId,
    agent_id: agentId,
    product_line_id: productLineId,
  }));
  const { error } = await supabase.from(table).insert(stamped);
  if (error) {
    logger.error(`kb.${table}.insert_failed`, { docId, error: error.message, count: stamped.length });
    return 0;
  }
  logger.info(`kb.${table}.extracted`, { count: stamped.length, docId });
  return stamped.length;
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

/**
 * reparse 抽取阶段失败时回滚：把 doc 还原成抽取前的状态，旧子表数据已经保留
 * （我们没在抽取阶段触发 cleanup）。error_message 标"旧数据保留"让用户知道
 * 这次 reparse 失败但数据可用，重试即可。
 */
async function restoreDocAfterReparseFailure(docId, prevSnapshot, errorMessage) {
  const prevStatus = prevSnapshot?.status || 'ready';
  const prevPartialReason = prevSnapshot?.partial_reason || null;
  const base = {
    status: prevStatus,
    error_message: `重新解析失败: ${errorMessage}（旧数据已保留，可重试）`,
    updated_at: new Date().toISOString(),
  };
  const withPartialReason = { ...base, partial_reason: prevPartialReason };
  let { error } = await supabase.from('kb_documents').update(withPartialReason).eq('id', docId);
  if (error && /partial_reason/.test(error.message || '')) {
    const fallback = await supabase.from('kb_documents').update(base).eq('id', docId);
    if (fallback.error) {
      logger.error('kb.upload.restore_failed', { docId, error: fallback.error.message });
    }
  } else if (error) {
    logger.error('kb.upload.restore_failed', { docId, error: error.message });
  }
}

/**
 * 完成态写入：knowledge_points_count + status + partial_reason 一次到位。
 * partial_reason 是 2026-05-12 迁移加的列，迁移没跑时这里会报错 ── 回退到
 * 不带该列的更新，保留向前兼容。
 */
async function finalizeDocStatus(docId, status, knowledgePointsCount, partialReason) {
  const base = {
    status,
    knowledge_points_count: knowledgePointsCount,
    error_message: null,            // 成功完成 → 清掉上一次失败留下的错误信息
    updated_at: new Date().toISOString(),
  };
  const withReason = { ...base, partial_reason: partialReason };
  let { error } = await supabase.from('kb_documents').update(withReason).eq('id', docId);
  if (error && /partial_reason/.test(error.message || '')) {
    // 迁移没跑：降级到不带 partial_reason 的更新，保留 partial 状态本身
    const fallback = await supabase.from('kb_documents').update(base).eq('id', docId);
    if (fallback.error) {
      logger.error('kb.upload.finalize_failed', { docId, error: fallback.error.message });
    } else {
      logger.warn('kb.upload.partial_reason_column_missing', { docId });
    }
  } else if (error) {
    logger.error('kb.upload.finalize_failed', { docId, error: error.message });
  }
}

// Cap concurrency over an array — like Promise.all but with worker-pool throttling.
async function mapWithConcurrency(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
