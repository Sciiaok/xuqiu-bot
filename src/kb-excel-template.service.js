/**
 * Excel structured-template upload.
 *
 * Unlike the LLM-extraction upload pipeline (kb-upload.service.js), this
 * service writes structured rows DIRECTLY to kb_products / kb_shipping_routes
 * with strict schema validation. No LLM call, no extraction, no extracted_low —
 * everything inserted here is `confidence='verified'`.
 *
 * Templates supported:
 *   - "products": columns sku, model, product_name, category, fob_price_usd,
 *                 moq, lead_time_days, effective_date, expiry_date, [specs.*]
 *   - "shipping_routes": columns origin_port, destination_port,
 *                        destination_country, shipping_method,
 *                        cost_per_unit_usd, transit_days, effective_date,
 *                        expiry_date, notes
 *
 * Empty cells are allowed; unknown columns become specs.* on products and are
 * ignored on routes. Each row that fails validation is reported back to the
 * caller — the rest are inserted in a single batch.
 */
import { read, utils } from 'xlsx';
import supabase from '../lib/supabase.js';

const PRODUCT_REQUIRED = ['sku', 'fob_price_usd'];
const SHIPPING_REQUIRED = ['destination_port', 'cost_per_unit_usd'];

const PRODUCT_KNOWN = new Set([
  'sku', 'model', 'product_name', 'product_name_en', 'category',
  'fob_price_usd', 'moq', 'lead_time_days',
  'effective_date', 'expiry_date',
]);

const SHIPPING_KNOWN = new Set([
  'origin_port', 'destination_port', 'destination_country', 'shipping_method',
  'cost_per_unit_usd', 'transit_days', 'notes',
  'effective_date', 'expiry_date',
]);

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  // Excel often serializes dates as numbers — xlsx already converts when raw:false
  const s = String(v).trim();
  if (!s) return null;
  // Accept YYYY-MM-DD or YYYY/MM/DD
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function parseNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an Excel buffer into rows (first sheet only).
 */
function readRows(buffer) {
  const wb = read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const json = utils.sheet_to_json(sheet, { defval: '', raw: false });
  return json;
}

// ── Products ─────────────────────────────────────────────────────────

export async function importProductsFromExcel(ctx, buffer, { sourceDocId } = {}) {
  const { tenantId, agentId, productLineId } = ctx;
  if (!tenantId || !productLineId) throw new Error('importProductsFromExcel: tenantId+productLineId required');

  const rows = readRows(buffer);
  const valid = [];
  const errors = [];

  rows.forEach((rawRow, idx) => {
    const row = {};
    const specs = {};
    for (const [k, v] of Object.entries(rawRow)) {
      const key = normalizeHeader(k);
      if (key.startsWith('specs.')) specs[key.slice(6)] = v;
      else if (PRODUCT_KNOWN.has(key)) row[key] = v;
      else specs[key] = v; // unknown → specs.*
    }

    for (const req of PRODUCT_REQUIRED) {
      if (!row[req] || String(row[req]).trim() === '') {
        errors.push({ row: idx + 2, error: `missing required field: ${req}` });
        return;
      }
    }

    const fob = parseNumber(row.fob_price_usd);
    if (fob == null) {
      errors.push({ row: idx + 2, error: `invalid fob_price_usd: ${row.fob_price_usd}` });
      return;
    }

    valid.push({
      tenant_id: tenantId,
      product_line_id: productLineId,
      agent_id: agentId,                       // old NOT NULL
      doc_id: sourceDocId || null,
      source_doc_id: sourceDocId || null,
      sku: String(row.sku).trim(),
      model: row.model ? String(row.model).trim() : null,
      product_name: row.product_name ? String(row.product_name).trim() : null,
      product_name_en: row.product_name_en ? String(row.product_name_en).trim() : null,
      category: row.category ? String(row.category).trim() : null,
      specs,
      fob_price_usd: fob,
      moq: parseNumber(row.moq),
      lead_time_days: row.lead_time_days ? String(row.lead_time_days).trim() : null,
      effective_date: parseDate(row.effective_date) || new Date().toISOString().split('T')[0],
      expiry_date: parseDate(row.expiry_date),
      confidence: 'verified',
      is_active: true,
    });
  });

  if (valid.length === 0) {
    return { inserted: 0, errors, total_rows: rows.length };
  }

  const { error } = await supabase.from('kb_products').insert(valid);
  if (error) {
    return { inserted: 0, errors: [...errors, { row: null, error: `db insert failed: ${error.message}` }], total_rows: rows.length };
  }

  return { inserted: valid.length, errors, total_rows: rows.length };
}

// ── Shipping Routes ──────────────────────────────────────────────────

export async function importShippingRoutesFromExcel(ctx, buffer, { sourceDocId } = {}) {
  const { tenantId, agentId, productLineId } = ctx;
  if (!tenantId || !productLineId) throw new Error('importShippingRoutesFromExcel: tenantId+productLineId required');

  const rows = readRows(buffer);
  const valid = [];
  const errors = [];

  rows.forEach((rawRow, idx) => {
    const row = {};
    for (const [k, v] of Object.entries(rawRow)) {
      const key = normalizeHeader(k);
      if (SHIPPING_KNOWN.has(key)) row[key] = v;
    }

    for (const req of SHIPPING_REQUIRED) {
      if (!row[req] || String(row[req]).trim() === '') {
        errors.push({ row: idx + 2, error: `missing required field: ${req}` });
        return;
      }
    }

    const cost = parseNumber(row.cost_per_unit_usd);
    if (cost == null) {
      errors.push({ row: idx + 2, error: `invalid cost_per_unit_usd: ${row.cost_per_unit_usd}` });
      return;
    }

    valid.push({
      tenant_id: tenantId,
      product_line_id: productLineId,
      agent_id: agentId,
      doc_id: sourceDocId || null,
      source_doc_id: sourceDocId || null,
      origin_port: row.origin_port ? String(row.origin_port).trim() : null,
      destination_port: String(row.destination_port).trim(),
      destination_country: row.destination_country ? String(row.destination_country).trim() : null,
      shipping_method: row.shipping_method ? String(row.shipping_method).trim() : null,
      cost_per_unit_usd: cost,
      transit_days: row.transit_days ? String(row.transit_days).trim() : null,
      notes: row.notes ? String(row.notes).trim() : null,
      effective_date: parseDate(row.effective_date) || new Date().toISOString().split('T')[0],
      expiry_date: parseDate(row.expiry_date),
      confidence: 'verified',
    });
  });

  if (valid.length === 0) {
    return { inserted: 0, errors, total_rows: rows.length };
  }

  const { error } = await supabase.from('kb_shipping_routes').insert(valid);
  if (error) {
    return { inserted: 0, errors: [...errors, { row: null, error: `db insert failed: ${error.message}` }], total_rows: rows.length };
  }

  return { inserted: valid.length, errors, total_rows: rows.length };
}

export async function importTemplate(ctx, buffer, templateKind, opts = {}) {
  if (templateKind === 'products') return importProductsFromExcel(ctx, buffer, opts);
  if (templateKind === 'shipping_routes') return importShippingRoutesFromExcel(ctx, buffer, opts);
  throw new Error(`Unknown template kind: ${templateKind}`);
}
