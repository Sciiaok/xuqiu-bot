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
 */
import {
  lookupProduct,
  quotePrice,
  lookupShipping,
  lookupPolicy,
  findAsset,
  checkConstraint,
  computeApproxRange,
} from '../../kb-tools.service.js';
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
      'Find products by SKU, model name, or attribute filters (e.g. horsepower, fuel type). Returns {found:true, products:[...]} with structured product data, or {found:false, suggestions?:[...], missing_fields?:[...]}. The tool tokenizes input automatically (whitespace, CJK/Latin transitions), so pass the keyword verbatim — do NOT insert or strip spaces yourself. **This is an internal signal — `found:false` does NOT mean you should tell the customer "we don\'t have X".** During `lead_collection`: record the customer\'s brand/SKU into `leads`, then keep collecting the configured qualify_fields. `suggestions` are NEVER proactively offered as cross-sell — only surface them when the customer explicitly asks for alternatives ("还有什么别的"/"recommend something else"). When `qualify_fields` are complete and the SKU is still not_found, route to HUMAN_NOW per handover-rules §1.4 (do not surface KB miss to the customer in next_message). **This tool never returns prices — it is identification only.** For ANY price question, call `quote_price` (it returns a server-computed indicative range). When the search returns >1 SKU, list the configurations and ask the customer which one BEFORE quoting — `quote_price` needs the query to resolve to a single SKU. See skill-host-patch §10.',
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
      'Get an INDICATIVE PRICE RANGE for ONE specific product. Call this for any specific-product price question — no need to collect leads first. Returns {ok:true, approximate:true, price_low, price_high, currency:"USD", trade_term:"FOB", basis:"per_unit"} when the sku/model resolves to a single priced product. The range is computed server-side — relay price_low–price_high verbatim as an approximate FOB unit range; NEVER reveal or imply an exact/base price, NEVER invent numbers, NEVER explain how the range is derived. Other shapes: {ok:false, not_found:true} (no such product — do NOT tell the customer "we don\'t have it"; per §5 keep probing or hand off); {ok:false, missing_fields:["sku"]} (matched >1 configuration — list them, ask which one, then call again); {ok:false, needs_human:true} (product exists but no price on file — hand off, never fabricate). The range is FOB unit price; CIF/DDP freight is extra and confirmed offline.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'SKU or model identifier of ONE specific product. Tokenized automatically.' },
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

// ── Executor ────────────────────────────────────────────────────────

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

// freight 运费仍按 leads 完整度做闸：未齐时从 route 里抽掉 unit_cost。
// （产品报价已改为对外只给 quote_price 的区间，不再依赖这里；本函数仅服务
// lookup_freight。）
function applyFreightPriceLock(result, missingLeads) {
  if (!Array.isArray(missingLeads) || missingLeads.length === 0) return result;
  if (!result || typeof result !== 'object') return result;
  if (!result.found || !result.route) return result;
  return {
    ...result,
    route: stripPriceKeys(result.route),
    _price_locked: { reason: 'leads_incomplete', missing: missingLeads },
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

    switch (toolName) {
      case 'lookup_product':
        result = await lookupProduct({ ...base, sku: input.sku, model: input.model, attrs: input.attrs });
        // 原价数字一律不进模型视野 —— 价格只走 quote_price 的区间通道（见
        // skill-host-patch §10）。lookup_product 永远只做识别，不返回任何价格字段。
        if (result.found && Array.isArray(result.products)) {
          result = { ...result, products: stripProductPrices(result.products) };
        }
        break;
      case 'quote_price': {
        // 对外只给 ballpark 区间：永不报精确数，也不要求 leads 收齐。复用
        // quotePrice 的产品解析（强制 FOB），拿到 fob 原价后服务端算成区间。
        //   单一产品 + 有价 → {ok:true, approximate, price_low, price_high}
        //   多匹配         → quotePrice 返回 missing_fields:['sku']（让客户收敛配置）
        //   未命中         → not_found
        //   无 fob 价      → needs_human
        const exact = await quotePrice({ ...base, sku: input.sku, tradeTerm: 'FOB' });
        if (!exact.ok) { result = exact; break; }
        const range = computeApproxRange(exact.breakdown?.unit_fob_price);
        if (!range) { result = { ok: false, needs_human: true, reason: 'no_fob_price_recorded' }; break; }
        result = {
          ok: true,
          approximate: true,
          price_low: range.price_low,
          price_high: range.price_high,
          currency: 'USD',
          trade_term: 'FOB',
          basis: 'per_unit',
          note: 'Indicative FOB range only; final price confirmed by sales. CIF/DDP adds freight on top.',
          validity: exact.validity,
          source: exact.source,
        };
        break;
      }
      case 'lookup_freight':
        result = await lookupShipping({
          ...base,
          destinationPort: input.destination_port,
          shippingMethod: input.shipping_method,
          originPort: input.origin_port,
        });
        result = applyFreightPriceLock(result, missingLeads);
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

    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
}
