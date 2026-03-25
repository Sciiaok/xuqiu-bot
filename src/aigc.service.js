import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import supabase from '../lib/supabase.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL && { baseURL: config.anthropic.baseURL }),
});

const OPENROUTER_CHAT_URL = `${config.aigc.baseURL}/v1/chat/completions`;
const FETCH_TIMEOUT = 120_000;

/**
 * Extract product information from PDF text content.
 * Uses OpenRouter-configured Anthropic SDK.
 */
export async function extractProductInfo(pdfText) {
  if (!config.anthropic.apiKey) throw new Error('API key is not configured');

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
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
const IMAGE_MODEL_FALLBACKS = [
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-2.0-flash-exp:free',
  'openai/gpt-image-1',
];

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
  const modelsToTry = model
    ? [model]
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
 * Extract base64 image data from various OpenRouter response formats.
 */
export function extractBase64Image(message) {
  // Format 1: message.images[] (GPT-5-image)
  if (message.images?.length) {
    const img = message.images[0];
    const url = typeof img === 'string' ? img : img?.image_url?.url;
    if (url?.includes(',')) return url.split(',')[1];
    return url;
  }

  // Format 2: message.content[] multimodal (Gemini)
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url') {
        const url = part.image_url?.url;
        if (url?.includes(',')) return url.split(',')[1];
        return url;
      }
    }
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
    ? `- Reference the provided competitor/product images for visual style, layout, and color palette. Adapt their best design patterns while creating original content for our product.`
    : '';

  return `Generate a professional ad image (1080x1080 square, exactly 1080 pixels wide and 1080 pixels tall) for ${company}.

Product: ${product?.model || 'Product'} — ${product?.category || ''}
Key specs: ${specs}
Selling points: ${sellingPoints}

${userPrompt}

Requirements:
- Image MUST be exactly 1080x1080 pixels (square format for Facebook/Instagram feed)
- Professional, clean design suitable for Facebook/Instagram ads
- Include product name and key specs as text overlay
${langInstruction}
${ctaLine}
${refInstruction}
- Do NOT include any phone numbers or contact details in the image
- High quality, photorealistic style`;
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

  const { imageBuffer, model: usedModel } = await generateAdImage({ prompt, model, referenceImages });

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
