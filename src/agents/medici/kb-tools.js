/**
 * Knowledge Base Tools for Medici's tool-use loop.
 *
 * 6 typed tools — every tool returns either a determinate success shape or
 * an explicit failure shape. Medici makes if-else decisions on the shape,
 * never on similarity scores. See src/kb-tools.service.js for the contracts.
 *
 *   1. lookup_product
 *   2. quote_price
 *   3. lookup_shipping
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
      'Find products by SKU, model name, or attribute filters (e.g. horsepower, fuel type). Returns {found:true, products:[...]} with structured product data, or {found:false, suggestions?:[...], missing_fields?:[...]}. Use this BEFORE quoting any price.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Exact or partial SKU/model identifier' },
        model: { type: 'string', description: 'Model keyword to search by name' },
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
      'Quote a price for a specific product. Returns {ok:true, unit_price, total_price, breakdown, validity, source} OR {ok:false, missing_fields|needs_human|not_found}. NEVER guess prices — always call this. CIF/DDP requires destination_port.',
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

  lookup_shipping: {
    name: 'lookup_shipping',
    description:
      'Look up shipping route to a destination. Returns {found:true, route:{unit_cost, transit_days, ...}} or {found:false, alternatives:[...]} with same-country alternatives.',
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
  lookup_shipping: 'logistics',
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
    case 'lookup_shipping':
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
 * Execute a knowledge-base tool call from Claude.
 * @returns {Promise<string>} JSON-encoded result for tool_result content.
 */
export async function executeKbTool(toolName, input, ctx = {}) {
  try {
    let result;
    const base = { tenantId: ctx.tenantId, productLineId: ctx.productLineId };

    switch (toolName) {
      case 'lookup_product':
        result = await lookupProduct({ ...base, sku: input.sku, model: input.model, attrs: input.attrs });
        break;
      case 'quote_price':
        result = await quotePrice({
          ...base,
          sku: input.sku,
          quantity: input.quantity,
          tradeTerm: input.trade_term,
          destinationPort: input.destination_port,
          paymentTerm: input.payment_term,
        });
        break;
      case 'lookup_shipping':
        result = await lookupShipping({
          ...base,
          destinationPort: input.destination_port,
          shippingMethod: input.shipping_method,
          originPort: input.origin_port,
        });
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
