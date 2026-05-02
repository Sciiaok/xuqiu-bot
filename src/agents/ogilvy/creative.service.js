/**
 * Autopilot creative service — single-image ad creative generation.
 *
 * Self-contained: all OpenRouter image-gen + Supabase persistence lives here.
 *
 * Scope for MVP:
 *   - Square 1080×1080 image for Meta feed
 *   - Uses user-uploaded product images as reference (mandatory — Meta CTWA needs fidelity)
 *   - No best-of-N scoring, no language routing logic, no PDF parsing
 *   - Returns { url, storage_path, model } on success, { error } on failure
 */
import { config } from '../../config.js';
import supabase from '../../../lib/supabase.js';

const FETCH_TIMEOUT = 120_000;
const STORAGE_BUCKET = 'aigc-assets';

// Fallback chain — we try models in order; the first that returns an image wins.
const IMAGE_MODELS = [
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-2.5-flash-image',
  'openai/gpt-5-image-mini',
];

// OpenRouter vision/image models reject some formats (e.g. avif).
const SUPPORTED_REF_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// ── Prompt builder ──────────────────────────────────────────────────────

function buildCreativePrompt({ productName, productDescription, headline, targetCountries, language }) {
  const lang = language || 'English';
  const sceneBrief = (productDescription || '').trim();
  return `Generate a professional advertising image (1080x1080 square, exactly 1080 pixels wide and 1080 pixels tall) for a B2B WhatsApp-conversion ad.

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

// ── OpenRouter image model caller ───────────────────────────────────────

async function callImageModel(model, promptContent) {
  const url = `${config.openrouter.baseURL.replace(/\/$/, '')}/chat/completions`;
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

  const b64 = extractBase64Image(message);
  if (!b64) throw new Error('No image returned by model');

  return {
    imageBuffer: Buffer.from(b64, 'base64'),
    model: data.model || model,
  };
}

// Image models return base64 in three different shapes depending on provider.
function extractBase64Image(message) {
  // Format 1: message.images[] (GPT-5-image)
  if (message.images?.length) {
    const img = message.images[0];
    const url = typeof img === 'string' ? img : img?.image_url?.url;
    if (url?.includes(',')) return url.split(',')[1];
    return url;
  }
  // Format 2: message.content[] with type=image_url (Gemini via OpenRouter)
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url') {
        const url = part.image_url?.url;
        if (url?.includes(',')) return url.split(',')[1];
        return url;
      }
    }
  }
  // Format 3: markdown ![](data:...) inside a text block
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter(p => p.type === 'text').map(p => p.text).join('')
      : '';
  if (text) {
    const match = text.match(/!\[.*?\]\((data:image\/[^;]+;base64,([A-Za-z0-9+/=\s]+))\)/);
    if (match?.[2]) return match[2].replace(/\s/g, '');
  }
  return null;
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
  // table (predates autopilot). Autopilot session IDs don't live there, so we
  // leave it null — the linkage lives on session.plan_json instead. We still
  // persist the row so the asset shows up in /aigc-library / audit trails.
  // `autopilot_session_id` is included via metadata for future migration.
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
 * Falls back through IMAGE_MODELS in order; returns the first success.
 * Returns { url, storage_path, model } on success, { error, message } on failure.
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
  if (!config.openrouter.apiKey) {
    return { error: 'config_missing', message: 'OPENROUTER_API_KEY is not configured' };
  }
  // CTWA ads need photorealistic product fidelity — reference images are mandatory.
  const refs = filterSupportedRefs(referenceImageUrls);
  if (!refs.length) {
    return {
      error: 'no_reference_images',
      message: '需要至少一张产品参考图。请让用户上传产品照片后再生成素材。',
    };
  }

  const prompt = buildCreativePrompt({ productName, productDescription, headline, targetCountries, language });
  const promptContent = [
    ...refs.slice(0, 3).map(url => ({ type: 'image_url', image_url: { url } })),
    { type: 'text', text: prompt },
  ];

  // Try models in sequence. We log each failure to stderr but return the
  // aggregate error only if every model fails.
  let lastErr;
  for (const model of IMAGE_MODELS) {
    try {
      const generated = await callImageModel(model, promptContent);
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
      console.warn(`[autopilot/creative] ${model} failed: ${err.message}`);
      lastErr = err;
    }
  }
  return { error: 'image_generation_failed', message: lastErr?.message || 'All image models failed' };
}
