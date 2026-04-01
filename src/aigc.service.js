import { anthropic, MODELS } from './llm-client.js';
import { config } from './config.js';
import supabase from '../lib/supabase.js';

const OPENROUTER_CHAT_URL = `${config.aigc.baseURL}/v1/chat/completions`;
const FETCH_TIMEOUT = 120_000;
const BEST_OF_N = parseInt(process.env.AIGC_BEST_OF_N, 10) || 1;
const SCORE_THRESHOLD = 6;     // Minimum acceptable fidelity score (1-10)

/**
 * Extract product information from PDF text content.
 * Uses OpenRouter-configured Anthropic SDK.
 */
export async function extractProductInfo(pdfText) {
  const response = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Extract product information from this document text. Return ONLY valid JSON with these fields:
- company_name: string
- products: array of { model, category, key_specs (object), selling_points (array of strings) }
- certifications: array of strings

Document text:
${pdfText.slice(0, 12000)}`,
    }],
  });

  const content = response.content?.[0]?.text;
  if (!content) throw new Error('No content in response');

  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) throw new Error('No JSON found in response');

  return JSON.parse(jsonMatch[1]);
}

/**
 * Generate an ad image via OpenRouter image-capable models.
 * Returns { imageBuffer, model, prompt }.
 */
const IMAGE_MODEL_FALLBACKS = (process.env.MIXAI_API_GEMINI_KEY || process.env.MIXAI_API_KEY)
  ? ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview']
  : ['google/gemini-3.1-flash-image-preview', 'google/gemini-2.0-flash-exp:free', 'openai/gpt-image-1'];

export async function generateAdImage({ prompt, model, referenceImages }) {
  if (!config.aigc.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

  // Build message content: text prompt + optional reference images
  let content;
  if (referenceImages?.length) {
    content = [
      ...referenceImages.slice(0, 3).map(ref => ({
        type: 'image_url',
        image_url: { url: typeof ref === 'string' ? ref : ref.url },
      })),
      { type: 'text', text: prompt },
    ];
  } else {
    content = prompt;
  }

  // Try models in order until one succeeds
  // Set AIGC_NO_FALLBACK=1 to disable model fallback chain (faster failures in testing)
  const modelsToTry = model
    ? [model]
    : process.env.AIGC_NO_FALLBACK
      ? [config.aigc.imageModel]
      : [config.aigc.imageModel, ...IMAGE_MODEL_FALLBACKS.filter(m => m !== config.aigc.imageModel)];

  let lastError;
  for (const currentModel of modelsToTry) {
    try {
      const result = await callImageModel(currentModel, content);
      return { ...result, prompt };
    } catch (err) {
      console.warn(`[aigc] ${currentModel} failed:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('All image models failed');
}

async function callImageModel(model, content) {
  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.aigc.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
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

/**
 * Extract base64 image data from various response formats.
 */
export function extractBase64Image(message) {
  // Format 1: message.images[] (GPT-5-image)
  if (message.images?.length) {
    const img = message.images[0];
    const url = typeof img === 'string' ? img : img?.image_url?.url;
    if (url?.includes(',')) return url.split(',')[1];
    return url;
  }

  // Format 2: message.content[] multimodal (OpenRouter Gemini)
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url') {
        const url = part.image_url?.url;
        if (url?.includes(',')) return url.split(',')[1];
        return url;
      }
    }
  }

  // Format 3: markdown ![image](data:...) in text (MixAI Gemini)
  const text = typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.filter(p => p.type === 'text').map(p => p.text).join('')
    : '';
  if (text) {
    const match = text.match(/!\[.*?\]\((data:image\/[^;]+;base64,([A-Za-z0-9+/=\s]+))\)/);
    if (match?.[2]) return match[2].replace(/\s/g, '');
  }

  return null;
}

/**
 * Build an ad image prompt from product info and user instructions.
 *
 * @param {object} params
 * @param {object} params.productInfo - Extracted product info (company_name, products[])
 * @param {string} params.userPrompt - Ad content suggestion from strategy phase
 * @param {string} [params.format] - Image dimensions (forced to 1080x1080 for Meta feed)
 * @param {string} [params.targetProduct] - Product model name to feature (matches against products[])
 * @param {string} [params.language] - Target language for text overlays
 * @param {string} [params.website] - Company website for CTA
 */
export function buildAdPrompt({ productInfo, userPrompt, format, targetProduct, language, website, referenceImages }) {
  const company = productInfo?.company_name || 'Our Company';

  // Match the correct product by name, fall back to first
  let product = productInfo?.products?.[0];
  if (targetProduct && productInfo?.products?.length > 1) {
    const match = productInfo.products.find(p =>
      (p.model || p.name || '').toLowerCase().includes(targetProduct.toLowerCase()),
    );
    if (match) product = match;
  }

  const specs = product
    ? Object.entries(product.key_specs || {}).map(([k, v]) => `${k}: ${v}`).join(', ')
    : '';

  const sellingPoints = product?.selling_points?.slice(0, 3).join('. ') || '';

  const langInstruction = language && language !== 'en'
    ? `- All text overlays MUST be in ${language}. Use correct diacritics and characters.`
    : '- Text overlays in English.';

  const ctaLine = website
    ? `- Include a CTA button at the bottom with text "Visit ${website}" or "WhatsApp Us"`
    : '- Include a WhatsApp CTA button at the bottom';

  const refInstruction = referenceImages?.length
    ? `## Product Fidelity (CRITICAL — highest priority)
- The provided reference images show the EXACT product. You MUST preserve:
  - Product shape, proportions, and silhouette — do NOT alter the body shape
  - Exact colors, paint finish, and material textures
  - Brand logos, badges, and nameplate positions
  - Key design details (grille pattern, wheel design, light signatures, etc.)
- Do NOT hallucinate, invent, or modify any product feature not visible in the reference
- Do NOT blend features from other products or brands
- The product in the generated image must be immediately recognizable as the same product shown in the reference

## Scene & Composition
- Place the product in a contextually appropriate scene/background
- The product should be the dominant visual element (60-70% of frame)
- Adapt the lighting and environment from the reference style, but keep the product appearance identical`
    : '';

  return `Generate a professional ad image (1080x1080 square, exactly 1080 pixels wide and 1080 pixels tall) for ${company}.

Product: ${product?.model || 'Product'} — ${product?.category || ''}
Key specs: ${specs}
Selling points: ${sellingPoints}

${userPrompt}

${refInstruction}

Requirements:
- Image MUST be exactly 1080x1080 pixels (square format for Facebook/Instagram feed)
- Professional, clean design suitable for Facebook/Instagram ads
- Include product name and key specs as text overlay
${langInstruction}
${ctaLine}
- Do NOT include any phone numbers or contact details in the image
- Photorealistic, commercial photography quality, studio-grade lighting`;
}

/**
 * Score a generated image against reference images using a vision model.
 * Returns { score: 1-10, reason: string }.
 */
async function scoreImageFidelity(generatedB64, referenceImages) {
  if (!referenceImages?.length) return { score: 8, reason: 'No reference to compare' };

  try {
    const response = await anthropic.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          // Reference images first
          ...referenceImages.slice(0, 2).map(ref => ({
            type: 'image',
            source: { type: 'url', url: typeof ref === 'string' ? ref : ref.url },
          })),
          // Generated image
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: generatedB64 },
          },
          {
            type: 'text',
            text: `The first image(s) are reference photos of the REAL product. The last image is an AI-generated ad.

Score the generated ad image on product fidelity (1-10):
- 10: Product is pixel-perfect match to reference (shape, color, details all correct)
- 7-9: Product is clearly recognizable, minor differences in angle/lighting
- 4-6: Product is somewhat recognizable but has noticeable errors (wrong shape, wrong color, missing details)
- 1-3: Product is unrecognizable or completely different from reference

Reply ONLY with JSON: {"score": <number>, "reason": "<one sentence>"}`,
          },
        ],
      }],
    });

    const text = response.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { score: Number(parsed.score) || 5, reason: parsed.reason || '' };
    }
    return { score: 5, reason: 'Could not parse score' };
  } catch (err) {
    console.warn('[aigc] Vision scoring failed:', err.message);
    return { score: 5, reason: `Scoring error: ${err.message}` };
  }
}

/**
 * Generate N candidate images and pick the best one by vision model scoring.
 * Falls back to first successful candidate if scoring fails.
 */
export async function generateAdImageBestOfN({ prompt, model, referenceImages, n = BEST_OF_N }) {
  if (!referenceImages?.length || n <= 1) {
    // No references to score against — single generation
    return generateAdImage({ prompt, model, referenceImages });
  }

  // Generate N candidates in parallel
  const candidates = await Promise.allSettled(
    Array.from({ length: n }, () => generateAdImage({ prompt, model, referenceImages })),
  );

  const successful = candidates
    .filter(c => c.status === 'fulfilled')
    .map(c => c.value);

  if (successful.length === 0) {
    const firstErr = candidates.find(c => c.status === 'rejected');
    throw firstErr?.reason || new Error('All candidate generations failed');
  }

  if (successful.length === 1) return successful[0];

  // Score each candidate against references
  const scored = await Promise.all(
    successful.map(async (candidate) => {
      const b64 = candidate.imageBuffer.toString('base64');
      const { score, reason } = await scoreImageFidelity(b64, referenceImages);
      return { ...candidate, score, scoreReason: reason };
    }),
  );

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  console.log(`[aigc] Best-of-${n}: picked score=${best.score} (${best.scoreReason}), all scores: [${scored.map(s => s.score).join(', ')}]`);

  return best;
}

/**
 * Save generated image to Supabase storage and record in aigc_assets table.
 * Accepts an optional authClient for RLS-protected storage uploads.
 * Returns { id, url, storage_path }.
 */
export async function saveGeneratedAsset({ imageBuffer, prompt, model, sourceFilename, productInfo, authClient, conversationId, userId }) {
  const filename = `${Date.now()}_${model.replace(/\//g, '-')}.png`;
  const storagePath = `generated/${filename}`;

  // Use authClient for storage (RLS requires auth), fallback to service client
  const storageClient = authClient || supabase;

  const { error: uploadError } = await storageClient.storage
    .from(config.aigc.storageBucket)
    .upload(storagePath, imageBuffer, { contentType: 'image/png' });

  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  // Get public URL (doesn't need auth)
  const { data: urlData } = supabase.storage
    .from(config.aigc.storageBucket)
    .getPublicUrl(storagePath);

  // Insert record
  const { data: record, error: dbError } = await supabase
    .from('aigc_assets')
    .insert({
      conversation_id: conversationId || null,
      user_id: userId || null,
      prompt,
      model,
      source_filename: sourceFilename || null,
      product_info: productInfo || null,
      storage_path: storagePath,
      metadata: { format: 'png', size: imageBuffer.length },
    })
    .select('id')
    .single();

  if (dbError) throw new Error(`DB insert failed: ${dbError.message}`);

  return {
    id: record.id,
    url: urlData.publicUrl,
    storage_path: storagePath,
  };
}

/**
 * Full pipeline: extract product info from PDF text → generate ad image → save.
 */
export async function generateFromDocument({ pdfText, userPrompt, model, sourceFilename, format, targetProduct, language, website, referenceImages, authClient, conversationId, userId }) {
  const productInfo = await extractProductInfo(pdfText);

  const prompt = buildAdPrompt({
    productInfo,
    userPrompt: userPrompt || 'Create a compelling ad image for this product targeting African and Asian markets.',
    targetProduct,
    language,
    website,
    referenceImages,
  });

  const { imageBuffer, model: usedModel } = await generateAdImageBestOfN({ prompt, model, referenceImages });

  const asset = await saveGeneratedAsset({
    imageBuffer,
    prompt,
    model: usedModel,
    sourceFilename,
    productInfo,
    authClient,
    conversationId,
    userId,
  });

  return { ...asset, productInfo, model: usedModel };
}

/**
 * Query AIGC assets by conversation or user scope.
 *
 * @param {object} params
 * @param {'conversation' | 'user'} params.scope
 * @param {string} params.conversationId - required when scope='conversation'
 * @param {string} params.userId - required when scope='user'
 * @param {number} [params.limit=50]
 * @param {number} [params.offset=0]
 * @returns {Promise<{ data: Array, total: number }>}
 */
export async function getAssets({ scope, conversationId, userId, limit = 50, offset = 0 }) {
  let query = supabase
    .from('aigc_assets')
    .select('id, conversation_id, user_id, model, source_filename, product_info, storage_path, metadata, created_at', { count: 'exact' });

  if (scope === 'conversation') {
    if (!conversationId) throw new Error('conversationId is required for conversation scope');
    query = query.eq('conversation_id', conversationId);
  } else if (scope === 'user') {
    if (!userId) throw new Error('userId is required for user scope');
    query = query.eq('user_id', userId);
  }

  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new Error(`Query failed: ${error.message}`);

  // Attach public URLs
  const assets = (data || []).map(row => ({
    ...row,
    url: supabase.storage.from(config.aigc.storageBucket).getPublicUrl(row.storage_path).data.publicUrl,
  }));

  return { data: assets, total: count };
}
