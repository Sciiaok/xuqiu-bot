import supabase from '../supabase.js';

// ── Brief field validation ─────────────────────────────────────────────

/**
 * Check if a value is a valid http/https URL.
 */
function isValidUrl(v) {
  if (typeof v !== 'string') return false;
  try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; }
}

/**
 * Sanitize LLM-provided brief fields before persisting.
 * - Normalises image URL variants (reference_images, reference_image_url) into product_images
 * - Strips non-URL strings from URL-typed fields
 * - Removes descriptive text mistakenly placed in asset fields
 *
 * @param {Object} fields - Fields being patched/updated
 * @param {Object} [existingBrief] - Current brief from DB (used to merge product_images)
 */
export function sanitizeBriefFields(fields, existingBrief) {
  const out = { ...fields };

  // Start from existing product_images if the patch doesn't already include them
  if (!out.product_images && existingBrief?.product_images) {
    out.product_images = [...existingBrief.product_images];
  }

  // Normalise product_images: string[] → {url, filename}[]
  if (Array.isArray(out.product_images)) {
    out.product_images = out.product_images.map(img => {
      if (typeof img === 'string') return { url: img, filename: 'product' };
      return img;
    });
  }

  // Normalise reference_image_url (string) → product_images entry
  if (out.reference_image_url) {
    if (isValidUrl(out.reference_image_url)) {
      const existing = Array.isArray(out.product_images) ? out.product_images : [];
      if (!existing.some(img => img.url === out.reference_image_url)) {
        out.product_images = [...existing, { url: out.reference_image_url, filename: 'reference' }];
      }
    }
    delete out.reference_image_url;
  }

  // Normalise reference_images (string[] | {url}[]) → product_images entries
  if (Array.isArray(out.reference_images)) {
    const existing = Array.isArray(out.product_images) ? [...out.product_images] : [];
    const seen = new Set(existing.map(img => img.url));
    for (const img of out.reference_images) {
      const url = typeof img === 'string' ? img : img?.url;
      if (isValidUrl(url) && !seen.has(url)) {
        existing.push({ url, filename: typeof img === 'string' ? 'reference' : (img?.filename || 'reference') });
        seen.add(url);
      }
    }
    out.product_images = existing;
    delete out.reference_images;
  }

  // Strip non-URL strings from URL-typed fields
  for (const urlField of ['website', 'landing_page_url']) {
    if (out[urlField] && typeof out[urlField] === 'string' && !isValidUrl(out[urlField])) {
      if (/^[\w.-]+\.\w{2,}/.test(out[urlField])) {
        out[urlField] = `https://${out[urlField]}`;
      } else {
        delete out[urlField];
      }
    }
  }

  // Remove creative_asset if it's descriptive text, not a URL
  if (out.creative_asset && typeof out.creative_asset === 'string' && !isValidUrl(out.creative_asset)) {
    delete out.creative_asset;
  }

  return out;
}

// ── Brief CRUD ──────────────────────────────────────────────────────────

/**
 * Create a new campaign brief
 * @param {string|null} id - Optional custom UUID
 * @returns {Promise<Object>} - Created brief
 */
export async function createBrief(id = null) {
  const row = {};
  if (id) row.id = id;

  const { data, error } = await supabase
    .from('campaign_briefs')
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get a campaign brief by ID
 * @param {string} briefId - Brief UUID
 * @returns {Promise<Object|null>} - Brief object or null
 */
export async function getBrief(briefId) {
  const { data, error } = await supabase
    .from('campaign_briefs')
    .select('*')
    .eq('id', briefId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Update a campaign brief (top-level columns)
 * @param {string} briefId - Brief UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated brief
 */
export async function updateBrief(briefId, { status, brief, completion, expires_at }) {
  const updateData = {};
  if (status !== undefined) updateData.status = status;
  if (brief !== undefined) updateData.brief = brief;
  if (completion !== undefined) updateData.completion = completion;
  if (expires_at !== undefined) updateData.expires_at = expires_at;

  const { data, error } = await supabase
    .from('campaign_briefs')
    .update(updateData)
    .eq('id', briefId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Merge fields into the existing brief JSONB column
 * @param {string} briefId - Brief UUID
 * @param {Object} fields - Key/value pairs to merge into brief
 * @returns {Promise<Object>} - Updated brief
 */
export async function updateBriefFields(briefId, fields) {
  const existing = await getBrief(briefId);
  if (!existing) throw new Error(`Brief ${briefId} not found`);

  const merged = { ...existing.brief, ...fields };

  const { data, error } = await supabase
    .from('campaign_briefs')
    .update({ brief: merged })
    .eq('id', briefId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update the completion JSONB column
 * @param {string} briefId - Brief UUID
 * @param {Object} completion - Completion object
 * @returns {Promise<Object>} - Updated brief
 */
export async function updateCompletion(briefId, completion) {
  const { data, error } = await supabase
    .from('campaign_briefs')
    .update({ completion })
    .eq('id', briefId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

