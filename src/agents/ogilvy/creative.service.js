/**
 * Ogilvy creative service — single-image ad creative generation.
 *
 * Self-contained: all OpenAI Images API + Supabase persistence lives here.
 *
 * Scope for MVP:
 *   - Square 1024×1024 image for Meta feed
 *   - Uses user-uploaded product images as reference (mandatory — Meta CTWA needs fidelity)
 *   - No best-of-N scoring, no language routing logic, no PDF parsing
 *   - Returns { url, storage_path, model } on success, { error } on failure
 */
import { config } from '../../config.js';
import supabase from '../../../lib/supabase.js';

const FETCH_TIMEOUT = 120_000;
const STORAGE_BUCKET = 'aigc-assets';

// Prefix every legitimate creative URL produced by saveAssetToStorage starts
// with. Used by the launch path to refuse plans whose image_url didn't come
// from our own generator (e.g. an attacker-controlled URL that slipped into
// plan_json via prompt injection through web_search / read_webpage). Anchored
// to the public URL Supabase returns from getPublicUrl(), so it stays correct
// even if STORAGE_BUCKET is renamed.
export const ALLOWED_CREATIVE_URL_PREFIX =
  `${config.supabase.url.replace(/\/$/, '')}/storage/v1/object/public/${STORAGE_BUCKET}/`;

export function isAllowedCreativeUrl(url) {
  return typeof url === 'string' && url.startsWith(ALLOWED_CREATIVE_URL_PREFIX);
}

const PRIMARY_MODEL = 'gpt-image-1';
const FALLBACK_MODEL = 'google/gemini-3.1-flash-image-preview';
const OPENAI_IMAGES_EDITS_URL = 'https://api.openai.com/v1/images/edits';

// OpenAI Images API only accepts png / jpg / webp for reference uploads.
// Stricter set wins (the fallback path could take .gif via OpenRouter, but
// we keep one filter to avoid asymmetric refs between primary and fallback).
const SUPPORTED_REF_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// ── Prompt builder ──────────────────────────────────────────────────────

function buildCreativePrompt({ productName, productDescription, headline, targetCountries, language }) {
  const lang = language || 'English';
  const sceneBrief = (productDescription || '').trim();
  return `Generate a professional advertising image (1024x1024 square, exactly 1024 pixels wide and 1024 pixels tall) for a B2B WhatsApp-conversion ad.

## Scene & composition (FOLLOW EXACTLY — this is the creative brief)
${sceneBrief || '(no scene brief provided — fall back to a clean studio shot of the product)'}

The text above is the authoritative visual brief for this ad. Render the scene, setting, lighting, framing, and localization elements exactly as described. Do not substitute a generic studio shot if a specific environment (city, landscape, dealership, etc.) is specified. Do not omit named localization elements (license plates, signage, architecture style, people).

## Product
- Name: ${productName || 'Product'}
- Target markets: ${(targetCountries || []).join(', ') || 'global'}

## Product fidelity (critical)
The reference image(s) show the EXACT product. Preserve:
- Product shape, proportions, silhouette
- Exact colors, materials, finish
- Brand logos, badges, nameplate positions
- Design details (grille patterns, wheel design, light signatures, etc.)
Do NOT invent product features not shown in the reference.

## Headline overlay (render this text on the image, verbatim)
"${headline || 'Chat with us on WhatsApp'}"
- Language: ${lang}; render in ${lang} script only — do NOT translate or paraphrase
- Clearly legible, large enough to read on a phone screen
- Place where it doesn't cover the product's key features

## General composition rules (apply within the brief above)
- Product remains the focal subject — typically 50-70% of frame, but defer to the scene brief if it specifies otherwise
- Commercial-photography quality, studio-grade lighting, photorealistic

## Text overlay rules
- A WhatsApp-style CTA button or icon at bottom right (green, recognizable)
- No Chinese/CJK characters unless language is Chinese
- No phone numbers, no email addresses, no URLs in the image
- No emojis in text overlay
- The ONLY text on the image is the headline above + the WhatsApp CTA — do not add taglines, sub-headers, or feature callouts unless the scene brief explicitly asks for them`;
}

// ── Primary: OpenAI Images API ──────────────────────────────────────────

async function callOpenAIImages(model, prompt, refUrls) {
  // Fetch reference images as Blobs for multipart upload.
  const refBlobs = await Promise.all(
    refUrls.map(async (url, i) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!r.ok) throw new Error(`Failed to fetch reference image ${url}: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const ext = new URL(url, 'http://x').pathname.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'png';
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      return { blob: new Blob([buf], { type: mime }), filename: `ref_${i}.${ext}` };
    }),
  );

  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', '1024x1024');
  form.append('quality', 'high');
  for (const { blob, filename } of refBlobs) {
    form.append('image', blob, filename);
  }

  const res = await fetch(OPENAI_IMAGES_EDITS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.openai.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Image generation failed');

  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image returned by model');

  return { imageBuffer: Buffer.from(b64, 'base64'), model };
}

// ── Fallback: Gemini via OpenRouter chat/completions ────────────────────

async function callOpenRouterFallback(model, prompt, refUrls) {
  const url = `${config.openrouter.baseURL.replace(/\/$/, '')}/chat/completions`;
  const promptContent = [
    ...refUrls.map(u => ({ type: 'image_url', image_url: { url: u } })),
    { type: 'text', text: prompt },
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: promptContent }],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Image generation failed');

  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('No message in response');

  // Gemini via OpenRouter returns the image on message.images[] (not
  // message.content[]) — content is null on image responses. Each item is
  // { type: 'image_url', image_url: { url: 'data:image/...;base64,...' } }.
  let b64 = null;
  for (const part of Array.isArray(message.images) ? message.images : []) {
    if (part?.type === 'image_url') {
      const u = part.image_url?.url;
      b64 = u?.includes(',') ? u.split(',')[1] : u;
      if (b64) break;
    }
  }
  if (!b64) throw new Error('No image returned by model');

  return { imageBuffer: Buffer.from(b64, 'base64'), model: data.model || model };
}

// Filter reference URLs by supported extensions so the model doesn't reject the request.
function filterSupportedRefs(urls = []) {
  return urls.filter(url => {
    try {
      const ext = new URL(url, 'http://x').pathname.match(/\.\w+$/)?.[0]?.toLowerCase();
      return !ext || SUPPORTED_REF_EXTS.has(ext);
    } catch {
      return true;
    }
  });
}

// ── Persist to Supabase storage + aigc_assets table ─────────────────────

async function saveAssetToStorage({ imageBuffer, prompt, model, productInfo, userId, tenantId, sessionId, authClient }) {
  if (!tenantId) throw new Error('saveAssetToStorage: tenantId required');
  const filename = `${Date.now()}_${model.replace(/\//g, '-')}.png`;
  const storagePath = `generated/${filename}`;
  const storageClient = authClient || supabase;

  const { error: uploadError } = await storageClient.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, imageBuffer, { contentType: 'image/png' });
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  // Public URL uses the service client (RLS not required for read).
  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);

  // NOTE: aigc_assets.conversation_id FKs to the WhatsApp `conversations`
  // table (predates Ogilvy). Ogilvy session IDs don't live there, so we
  // leave it null — the linkage lives on session.plan_json instead. We still
  // persist the row so the asset shows up in /aigc-library / audit trails.
  // `autopilot_session_id` (legacy field name) is included via metadata for future migration.
  const { data: row, error: dbError } = await supabase
    .from('aigc_assets')
    .insert({
      tenant_id: tenantId,
      conversation_id: null,
      user_id: userId || null,
      prompt,
      model,
      source_filename: null,
      product_info: productInfo || null,
      storage_path: storagePath,
      metadata: {
        format: 'png',
        size: imageBuffer.length,
        autopilot_session_id: sessionId || null,
      },
    })
    .select('id')
    .single();
  if (dbError) throw new Error(`DB insert failed: ${dbError.message}`);

  return { id: row.id, url: urlData.publicUrl, storage_path: storagePath };
}

// ── Public entry ────────────────────────────────────────────────────────

/**
 * Generate one ad image from product info + reference images.
 *
 * Primary path: OpenAI Images API (gpt-image-1). On failure, falls back once
 * to Gemini via OpenRouter. Returns { url, storage_path, model } on success,
 * { error, message } on failure.
 */
export async function generateAdCreative({
  productName,
  productDescription,
  headline,
  referenceImageUrls = [],
  targetCountries = [],
  language = 'English',
  sessionId = null,
  userId = null,
  tenantId = null,
  authClient = null,
}) {
  if (!tenantId) {
    return { error: 'tenant_required', message: 'tenantId is required' };
  }
  if (!config.openai.apiKey) {
    return { error: 'config_missing', message: 'OPENAI_API_KEY is not configured' };
  }
  if (!config.openrouter.apiKey) {
    return { error: 'config_missing', message: 'OPENROUTER_API_KEY is not configured (needed for fallback)' };
  }
  // CTWA ads need photorealistic product fidelity — reference images are mandatory.
  const refs = filterSupportedRefs(referenceImageUrls).slice(0, 3);
  if (!refs.length) {
    return {
      error: 'no_reference_images',
      message: '需要至少一张产品参考图。请让用户上传产品照片后再生成素材。',
    };
  }

  const prompt = buildCreativePrompt({ productName, productDescription, headline, targetCountries, language });

  // Primary → fallback. We log each failure to stderr but return the
  // aggregate error only after both paths fail.
  const attempts = [
    { label: 'primary',  caller: callOpenAIImages,       model: PRIMARY_MODEL  },
    { label: 'fallback', caller: callOpenRouterFallback, model: FALLBACK_MODEL },
  ];

  let lastErr;
  for (const { label, caller, model } of attempts) {
    try {
      const generated = await caller(model, prompt, refs);
      const asset = await saveAssetToStorage({
        imageBuffer: generated.imageBuffer,
        prompt,
        model: generated.model,
        productInfo: { company_name: productName, products: [{ model: productName }] },
        userId,
        tenantId,
        sessionId,
        authClient: authClient || supabase,
      });
      // headline + product_name echoed back so the chat transcript can
      // caption the image without a cross-row lookup against the tool_use args.
      return {
        url: asset.url,
        storage_path: asset.storage_path,
        model: generated.model,
        headline: headline || null,
        product_name: productName || null,
      };
    } catch (err) {
      console.warn(`[ogilvy/creative] ${label} (${model}) failed: ${err.message}`);
      lastErr = err;
    }
  }
  return { error: 'image_generation_failed', message: lastErr?.message || 'All paths failed' };
}
