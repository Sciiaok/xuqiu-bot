/**
 * KB Asset Linker — match image captions to SKUs in kb_products.
 *
 * Why it exists: vision-caption alone produces generic descriptions like
 * "a blue 5-seat sedan", which the customer-service agent struggles to map to
 * "星耀6". This step runs after image extraction + product extraction both
 * finish for a document, takes the captions and the structured product list,
 * and writes back `kb_assets.linked_skus` so Medici can match by SKU directly.
 *
 * One LLM call per document (not per image) — Haiku, structured JSON out.
 * Failures are non-fatal: assets stay with empty linked_skus and Medici falls
 * back to caption matching.
 */
import supabase from '../lib/supabase.js';
import { openrouter, MODELS } from './llm-client.js';

const MAX_PRODUCTS_IN_PROMPT = 200;
const MAX_ASSETS_PER_CALL = 100;

/**
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.productLineId
 * @param {string} args.docId        Only link assets created by this document.
 * @param {object} [args.logger]
 * @returns {Promise<{linked:number, total_assets:number, total_products:number, errors:string[]}>}
 */
export async function linkAssetsToProducts({ tenantId, productLineId, docId, logger }) {
  if (!tenantId || !productLineId || !docId) {
    return { linked: 0, total_assets: 0, total_products: 0, errors: ['missing tenantId/productLineId/docId'] };
  }

  // Only consider product images that haven't already been linked. Certificates,
  // factory shots etc. don't get a SKU.
  const { data: rawAssets, error: assetsErr } = await supabase
    .from('kb_assets')
    .select('id, description, asset_type, linked_skus')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('source_doc_id', docId)
    .eq('asset_type', 'product_image');
  if (assetsErr) return { linked: 0, total_assets: 0, total_products: 0, errors: [assetsErr.message] };

  const assets = (rawAssets || []).filter(
    (a) => a.description && (!a.linked_skus || a.linked_skus.length === 0),
  );
  if (assets.length === 0) {
    return { linked: 0, total_assets: 0, total_products: 0, errors: [] };
  }

  const { data: products, error: prodErr } = await supabase
    .from('kb_products')
    .select('sku, product_name, model, category, specs')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('is_active', true)
    .limit(MAX_PRODUCTS_IN_PROMPT);
  if (prodErr) return { linked: 0, total_assets: assets.length, total_products: 0, errors: [prodErr.message] };
  if (!products || products.length === 0) {
    return { linked: 0, total_assets: assets.length, total_products: 0, errors: [] };
  }

  const chunks = [];
  for (let i = 0; i < assets.length; i += MAX_ASSETS_PER_CALL) {
    chunks.push(assets.slice(i, i + MAX_ASSETS_PER_CALL));
  }

  let totalLinked = 0;
  const errors = [];
  for (const chunk of chunks) {
    try {
      const mappings = await callMatcher({ tenantId, products, assets: chunk });
      const updates = mappings.filter((m) => m.asset_id && Array.isArray(m.skus) && m.skus.length > 0);
      await Promise.all(updates.map(async (m) => {
        const { error } = await supabase
          .from('kb_assets')
          .update({ linked_skus: m.skus })
          .eq('id', m.asset_id)
          .eq('tenant_id', tenantId);
        if (error) errors.push(`update ${m.asset_id}: ${error.message}`);
        else totalLinked++;
      }));
    } catch (e) {
      errors.push(`matcher chunk: ${e.message}`);
    }
  }

  logger?.info?.('kb_asset_linker.done', {
    doc_id: docId,
    linked: totalLinked,
    total_assets: assets.length,
    total_products: products.length,
    errors: errors.length,
  });

  return {
    linked: totalLinked,
    total_assets: assets.length,
    total_products: products.length,
    errors,
  };
}

async function callMatcher({ tenantId, products, assets }) {
  const productLines = products.map((p) => {
    const parts = [`SKU: ${p.sku || '(no-sku)'}`, `Name: ${p.product_name || ''}`];
    if (p.model) parts.push(`Model: ${p.model}`);
    if (p.category) parts.push(`Cat: ${p.category}`);
    // specs jsonb often has color, seats, body_type — flatten a few keys.
    if (p.specs && typeof p.specs === 'object') {
      const specBits = Object.entries(p.specs)
        .filter(([, v]) => v != null && v !== '')
        .slice(0, 5)
        .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`);
      if (specBits.length > 0) parts.push(`Specs: ${specBits.join(', ')}`);
    }
    return `- ${parts.join(' | ')}`;
  }).join('\n');

  const assetLines = assets.map((a) =>
    `- ID: ${a.id} | Caption: ${String(a.description).replace(/\s+/g, ' ').slice(0, 300)}`,
  ).join('\n');

  const prompt = `You are matching product images to SKUs in a catalog.

AVAILABLE PRODUCTS (${products.length}):
${productLines}

IMAGE CAPTIONS (${assets.length}):
${assetLines}

For each image ID, return the SKU(s) it most likely depicts based on the caption. If the caption is too vague or none of the SKUs fit, return an empty array for that ID. Most images map to exactly one SKU; rare cases (color swatch covering all variants) may map to several.

Respond with ONLY valid JSON in this exact shape:
{"mappings":[{"asset_id":"<id>","skus":["<sku>",...]},...]}`;

  const response = await openrouter.messages.create(
    {
      models: [MODELS.HAIKU],
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    },
    { tenantId, callSite: 'kb_asset_linker.match' },
  );

  const text = response.choices?.[0]?.message?.content?.trim() || '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  const parsed = JSON.parse(jsonMatch[0]);
  return Array.isArray(parsed.mappings) ? parsed.mappings : [];
}
