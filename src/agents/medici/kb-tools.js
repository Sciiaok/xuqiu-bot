/**
 * Knowledge Base Tools for Medici's tool-use loop.
 *
 * 6 typed tools — every tool returns either a determinate success shape or
 * an explicit failure shape. Medici makes if-else decisions on the shape,
 * never on similarity scores. See src/kb-tools.service.js for the contracts.
 *
 *   1. lookup_product
 *   2. quote_price
 *   3. lookup_freight
 *   4. lookup_policy        (also handles QA snippets via free_text)
 *   5. find_asset
 *   6. check_constraint
 *
 * Every tool call is wrapped with a gap recorder: if a tool returns
 * not_found / needs_human / unknown, we log to kb_knowledge_gaps so the
 * Learning panel can surface it.
 */
import {
  lookupProduct,
  quotePrice,
  lookupShipping,
  lookupPolicy,
  findAsset,
  checkConstraint,
} from '../../kb-tools.service.js';
import { recordGap } from '../../kb-gaps.service.js';
import supabase from '../../../lib/supabase.js';

// ── Capability detection ────────────────────────────────────────────

export async function hasKnowledgeBase({ tenantId, productLineId }) {
  const checks = await Promise.all([
    supabase.from('kb_knowledge_points').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('product_line_id', productLineId).eq('status', 'active').limit(1),
    supabase.from('kb_qa_snippets').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('product_line_id', productLineId).eq('is_active', true).limit(1),
    supabase.from('kb_products').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('product_line_id', productLineId).eq('is_active', true).limit(1),
  ]);
  return checks.some(c => (c.count || 0) > 0);
}

// ── Tool definitions ────────────────────────────────────────────────

const TOOL_DEFS = {
  lookup_product: {
    name: 'lookup_product',
    description:
      'Find products by SKU, model name, or attribute filters (e.g. horsepower, fuel type). Returns {found:true, products:[...]} with structured product data, or {found:false, suggestions?:[...], missing_fields?:[...]}. The tool tokenizes input automatically (whitespace, CJK/Latin transitions), so pass the keyword verbatim — do NOT insert or strip spaces yourself. **This is an internal signal — `found:false` does NOT mean you should tell the customer "we don\'t have X".** During `lead_collection`: record the customer\'s brand/SKU into `leads`, then keep collecting the configured qualify_fields. `suggestions` are NEVER proactively offered as cross-sell — only surface them when the customer explicitly asks for alternatives ("还有什么别的"/"recommend something else"). When `qualify_fields` are complete and the SKU is still not_found, route to HUMAN_NOW per handover-rules §1.4 (do not surface KB miss to the customer in next_message). **Price lock** — two flavors, both strip `fob_price_usd` from the response: (a) `_price_locked.reason="leads_incomplete"` → leads not QUALIFY-complete; (b) `_price_locked.reason="config_not_picked"` → the search returned >1 SKU and the customer hasn\'t narrowed to one config yet. In either case, do NOT quote any price (number, range, ballpark, "from $X to $Y"); list the configurations and ask which one. See skill-host-patch §10.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Exact or partial SKU/model identifier. Tokenized automatically.' },
        model: { type: 'string', description: 'Model keyword to search by name. Tokenized automatically — pass the user\'s phrase verbatim.' },
        attrs: {
          type: 'object',
          description: 'Structured attribute filters. Use _lte / _gte suffixes for range queries (e.g. {"horsepower_lte": 50, "fuel_type": "diesel"})',
          additionalProperties: true,
        },
      },
    },
  },

  quote_price: {
    name: 'quote_price',
    description:
      'Quote a price for a specific product. Returns {ok:true, unit_price, total_price, breakdown, validity, source} OR {ok:false, missing_fields|needs_human|not_found}. NEVER guess prices — always call this. CIF/DDP requires destination_port. **Price lock**: when leads are not QUALIFY-complete the host short-circuits this tool to {ok:false, missing_fields:[...], reason:"leads_incomplete", _price_locked:{...}} — do NOT quote any price (number, range, ballpark); ask for the missing leads instead. See skill-host-patch §10.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        quantity: { type: 'number', description: 'default 1' },
        trade_term: { type: 'string', enum: ['FOB', 'CIF', 'DDP'], description: 'default FOB' },
        destination_port: { type: 'string', description: 'required for CIF/DDP' },
        payment_term: { type: 'string', description: 'e.g. "TT 30/70" or "LC at sight" — non-standard terms trigger needs_human' },
      },
      required: ['sku'],
    },
  },

  // Tool surface name is `lookup_freight` (not `lookup_shipping`) — we look up
  // precomputed freight rate / transit data, not shipping capability. We can
  // ship to any destination the customer requests; `found:false` only means
  // "no rate data on file", NOT "cannot ship there". Underlying function and
  // table keep the `shipping` name for back-compat.
  lookup_freight: {
    name: 'lookup_freight',
    description:
      'Look up precomputed freight rate / transit time / origin port / shipping method for a destination. Returns {found:true, route:{unit_cost, transit_days, ...}} when we have prior data, or {found:false, alternatives:[...]} (same-country alternatives) when we don\'t. IMPORTANT: `found:false` means "no rate data on file", NOT "cannot ship there" — our default stance is we can ship to any destination the customer requests; ops will confirm specifics offline. **Price lock**: if `_price_locked` is present (leads not QUALIFY-complete), `unit_cost` is intentionally absent — do NOT quote shipping cost; see skill-host-patch §10.',
    input_schema: {
      type: 'object',
      properties: {
        destination_port: { type: 'string' },
        shipping_method: { type: 'string', enum: ['sea', 'air', 'land'] },
        origin_port: { type: 'string' },
      },
      required: ['destination_port'],
    },
  },

  lookup_policy: {
    name: 'lookup_policy',
    description:
      'Look up policy / company / sales info. Pass `topic` for known categories (payment_terms, warranty, after_sales, export_qualification, certification, company_background, competitive) and/or `free_text` for the customer\'s exact question (also searches sales-curated Q&A snippets first). Returns {found, answer_text, citations}.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Known topic category' },
        subtopic: { type: 'string' },
        free_text: { type: 'string', description: "Customer's question verbatim — triggers QA snippet search" },
        destination_country: { type: 'string', description: 'Filter for country-specific policies' },
      },
    },
  },

  find_asset: {
    name: 'find_asset',
    description:
      'Find an image/document asset. Tag-based filters (type/sku/view/color/scenario) match exactly; only matched_by="tag" results are safe to forward to customer without verification. natural_language fallback returns matched_by="semantic" + confidence.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['product_image', 'spec_sheet', 'quotation_template', 'certificate', 'brochure', 'other'] },
        sku: { type: 'string' },
        view: { type: 'string', description: 'e.g. front, side, engine, interior, color_swatch, detail' },
        color: { type: 'string' },
        scenario: { type: 'string', description: 'e.g. factory, warehouse, loading, in_use' },
        natural_language: { type: 'string', description: 'Free-text fallback for semantic search' },
      },
    },
  },

  check_constraint: {
    name: 'check_constraint',
    description:
      'Check whether an action is allowed by stored business rules. Returns {decision: "allowed"|"requires_approval"|"forbidden"|"unknown", reason}. Call BEFORE making concessions (give_discount, accept_payment_term, apply_shipping_markup, apply_special_offer). "unknown" means no rule defined — escalate to human if action is sensitive.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['give_discount', 'accept_payment_term', 'apply_shipping_markup', 'apply_special_offer'] },
        context: { type: 'object', additionalProperties: true },
      },
      required: ['action'],
    },
  },
};

/**
 * Build the tools list for Claude tool_use.
 * Empty array if no KB data exists for this product line.
 */
export async function buildKbTools({ tenantId, productLineId }) {
  if (!await hasKnowledgeBase({ tenantId, productLineId })) return [];

  // Always advertise all 6 tools when there's any KB content. Empty tables
  // are handled gracefully by each tool's "not_found" path.
  return Object.values(TOOL_DEFS);
}

// ── Executor with gap-capture wrapper ───────────────────────────────

const TOOL_TO_GAP_LAYER = {
  lookup_product: 'product',
  quote_price: 'product',
  lookup_freight: 'logistics',
  lookup_policy: null,
  find_asset: null,
  check_constraint: 'sales',
};

/**
 * Inspect a tool's typed result and return a gap_type if the result indicates
 * a knowledge gap. Returns null if the result is a success.
 */
function gapTypeFromResult(toolName, result) {
  if (!result || typeof result !== 'object') return null;

  switch (toolName) {
    case 'lookup_product':
    case 'lookup_freight':
      return result.found === false ? 'no_result' : null;
    case 'quote_price':
      if (result.ok === true) return null;
      if (result.not_found) return 'no_result';
      if (result.needs_human) return 'low_confidence';
      return null;
    case 'lookup_policy':
      return result.found === false ? 'no_result' : null;
    case 'find_asset':
      return (!result.assets || result.assets.length === 0) ? 'no_result' : null;
    case 'check_constraint':
      return result.decision === 'unknown' ? 'no_result' : null;
    default:
      return null;
  }
}

/**
 * Best-effort summary of the customer question for gap recording.
 * Falls back to JSON of input.
 */
function questionFromToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return toolName;
  return (
    input.free_text ||
    input.natural_language ||
    input.sku ||
    input.model ||
    input.destination_port ||
    input.topic ||
    input.action ||
    JSON.stringify(input)
  );
}

/**
 * Strip price-bearing fields from a tool result when the conversation hasn't
 * collected enough leads yet. The host (queue-processor / medici-simulator)
 * computes ctx.qualifyMissingFields = getMissingFields('QUALIFY', ...). When
 * non-empty we hide every price-like field from the model's view and stamp
 * `_price_locked` so the agent knows it's intentional, not an empty DB.
 *
 * Rule lives at skills/ai-reception-deal/SKILL.md §3.2 and
 * src/agents/medici/skill-host-patch.md §10.
 */

// kb_products.specs is free-form JSONB (users can name price fields anything),
// so we use a heuristic: strip keys mentioning price/cost/quote/floor/etc, OR
// ending with a common currency suffix. Conservative — non-price specs like
// weight_kg, wheelbase_mm pass through.
const PRICE_KEY_RE = /(?:price|cost|quote|floor|ceiling|msrp|retail|wholesale|guide)/i;
const CURRENCY_SUFFIX_RE = /_(?:usd|cny|eur|gbp|jpy|aed|inr|myr|hkd|sgd|brl|mxn|try|krw|thb|vnd|idr|php)$/i;

function isPriceKey(key) {
  return PRICE_KEY_RE.test(key) || CURRENCY_SUFFIX_RE.test(key);
}

function stripPriceKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isPriceKey(k)) continue;
    out[k] = v;
  }
  return out;
}

function stripProductPrices(products) {
  return products.map((p) => {
    const stripped = stripPriceKeys(p);
    if (p.specs && typeof p.specs === 'object') {
      stripped.specs = stripPriceKeys(p.specs);
    }
    return stripped;
  });
}

function applyPriceLock(toolName, result, missingLeads) {
  if (!Array.isArray(missingLeads) || missingLeads.length === 0) return result;
  if (!result || typeof result !== 'object') return result;
  const lock = { reason: 'leads_incomplete', missing: missingLeads };

  if (toolName === 'lookup_product') {
    if (!result.found || !Array.isArray(result.products)) return result;
    return {
      ...result,
      products: stripProductPrices(result.products),
      _price_locked: lock,
    };
  }
  if (toolName === 'lookup_freight') {
    if (!result.found || !result.route) return result;
    return { ...result, route: stripPriceKeys(result.route), _price_locked: lock };
  }
  return result;
}

/**
 * 多 SKU 时再加一道闸：leads 已 QUALIFY-complete 但客户没把"配置"收敛到单
 * 一型号（lookup_product 返回 >1 行），仍然不让 LLM 看价格——否则它会把所有
 * fob_price_usd 合并成一个 "$8,800–$12,600" 区间报给客户。飞书验收标准把
 * "配置" 列为最低必填字段，所以这里把"未锁定单一 SKU" 当成一种"未齐"。
 *
 * 字段补齐（客户确认了具体型号、下一次 lookup 只命中 1 条）后，价格自动恢复。
 */
function applyMultiSkuPriceLock(result) {
  if (!result || typeof result !== 'object') return result;
  if (!result.found || !Array.isArray(result.products)) return result;
  if (result.products.length <= 1) return result;
  if (result._price_locked) return result;  // leads_incomplete 已经盖过章了
  return {
    ...result,
    products: stripProductPrices(result.products),
    _price_locked: {
      reason: 'config_not_picked',
      products: result.products.length,
    },
  };
}

/**
 * Execute a knowledge-base tool call from Claude.
 * @returns {Promise<string>} JSON-encoded result for tool_result content.
 */
export async function executeKbTool(toolName, input, ctx = {}) {
  try {
    let result;
    const base = { tenantId: ctx.tenantId, productLineId: ctx.productLineId };
    const missingLeads = Array.isArray(ctx.qualifyMissingFields) ? ctx.qualifyMissingFields : [];
    const leadsLocked = missingLeads.length > 0;

    switch (toolName) {
      case 'lookup_product':
        result = await lookupProduct({ ...base, sku: input.sku, model: input.model, attrs: input.attrs });
        result = applyPriceLock('lookup_product', result, missingLeads);
        result = applyMultiSkuPriceLock(result);
        break;
      case 'quote_price':
        if (leadsLocked) {
          result = {
            ok: false,
            missing_fields: missingLeads,
            reason: 'leads_incomplete',
            _price_locked: { reason: 'leads_incomplete', missing: missingLeads },
          };
          break;
        }
        result = await quotePrice({
          ...base,
          sku: input.sku,
          quantity: input.quantity,
          tradeTerm: input.trade_term,
          destinationPort: input.destination_port,
          paymentTerm: input.payment_term,
        });
        break;
      case 'lookup_freight':
        result = await lookupShipping({
          ...base,
          destinationPort: input.destination_port,
          shippingMethod: input.shipping_method,
          originPort: input.origin_port,
        });
        result = applyPriceLock('lookup_freight', result, missingLeads);
        if (result && result.found === false) {
          result.hint =
            'No freight rate data on file for this destination — does NOT mean we cannot ship there. Default reply: yes we can ship to this destination, ops will confirm rate and transit time. Do NOT invent specific route characteristics (cost, transit days, frequency, "stable route", "regular service").';
        }
        break;
      case 'lookup_policy':
        result = await lookupPolicy({
          ...base,
          topic: input.topic,
          subtopic: input.subtopic,
          freeText: input.free_text,
          destinationCountry: input.destination_country,
        });
        break;
      case 'find_asset':
        result = await findAsset({
          ...base,
          type: input.type,
          sku: input.sku,
          view: input.view,
          color: input.color,
          scenario: input.scenario,
          naturalLanguage: input.natural_language,
        });
        break;
      case 'check_constraint':
        result = await checkConstraint({ ...base, action: input.action, context: input.context || {} });
        break;
      default:
        return JSON.stringify({ error: `Unknown KB tool: ${toolName}` });
    }

    // Gap capture — awaited so concurrent calls dedup cleanly via SELECT-then-
    // UPDATE; the latency cost (~50ms) is negligible compared to the LLM turn.
    const gapType = gapTypeFromResult(toolName, result);
    if (gapType) {
      await recordGap(
        { tenantId: ctx.tenantId, productLineId: ctx.productLineId },
        {
          question: questionFromToolInput(toolName, input),
          toolName,
          gapType,
          layer: TOOL_TO_GAP_LAYER[toolName] || null,
        }
      ).catch(() => { /* swallow — already logged in recorder */ });
    }

    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
}
