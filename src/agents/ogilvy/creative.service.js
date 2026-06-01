/**
 * Ogilvy creative service — single-image ad creative generation.
 *
 * Self-contained: 两条生图路径都走 OpenRouter /chat/completions(image-out
 * 模型),输出在 message.images[]。primary = openai/gpt-5.4-image-2,失败兜
 * 底 Gemini 3.1 Flash Image。
 *
 * Scope:
 *   - Single-image generation. carousel/video creative_type values from the
 *     v2 schema still resolve to a single image, but the result carries a
 *     `placeholder: true` flag so callers know the multi-frame format is not
 *     yet produced.
 *   - Three aspect ratios: 1:1 (1024×1024), portrait (1024×1536), landscape
 *     (1536×1024). 4:5 and 9:16 both map to 1024×1536 — the closest portrait
 *     gpt-image-2 supports; the prompt nudges composition toward the target.
 *   - cta_style switches the bottom-right CTA chip rendered into the image.
 *   - Uses user-uploaded product images as reference (mandatory — Meta CTWA needs fidelity)
 *   - Returns { url, storage_path, model } on success, { error } on failure
 */
import { config } from '../../config.js';
import supabase from '../../../lib/supabase.js';
import { logLlmCall } from '../../llm-client.js';
import { calcImageCostUsd } from '../../llm-pricing.js';

// gpt-5.4-image-2 通过 OR chat-completions 路径出图 1024×1024 实测 >2min,
// 120s 不够会全量兜到 Gemini —— 跟老 commit 913e008 在直连路径上踩过的坑
// 一致(切到 OR 不改变模型本身的出图时间)。aws-test 实测 primary 120003ms
// 命中 timeout × N 次后才确认。
const FETCH_TIMEOUT = 400_000;
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

const PRIMARY_MODEL = 'openai/gpt-5.4-image-2';
const FALLBACK_MODEL = 'google/gemini-3.1-flash-image-preview';

// 两条路径都把参考图当 image_url 塞 message content,过滤一道扩展名避免
// 模型端 invalid_request。两个 provider 都允许 png/jpg/webp。
const SUPPORTED_REF_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// ── Prompt builder ──────────────────────────────────────────────────────

// Aspect-ratio → framing hint。两条生图路径(OpenRouter chat-completions)
// 都不接受 size 参数,目标画幅完全靠 prompt 引导。v2 schema 暴露 4 个比例,
// 文案明确指出要按目标比例构图。
const ASPECT_FRAMING = {
  '1:1':  'Square 1:1 framing.',
  '4:5':  'Portrait 4:5 vertical framing — composition should still read on a slightly taller 4:5 crop; subject placement upper-center.',
  '9:16': 'Vertical 9:16 framing for Reels / Stories / TikTok — composition centered vertically; main subject upper-center, leave bottom 25% safer for platform overlays.',
  '16:9': 'Landscape 16:9 framing for horizontal placements — composition wide and cinematic, subject left-of-center.',
};

// cta_style → image-overlay description. V_1.0 default is whatsapp; the other
// values are schema-level placeholders for future non-CTW formats.
const CTA_OVERLAY = {
  whatsapp:    'A WhatsApp-style CTA button at bottom right (green, recognizable WhatsApp logo) — this is a Click-to-WhatsApp ad.',
  signup:      'A "Sign Up" CTA button at bottom right (solid, brand-neutral).',
  shop:        'A "Shop Now" CTA button at bottom right (solid, brand-neutral).',
  install:     'An "Install" CTA button at bottom right (app-store-style chip).',
  learn_more:  'A "Learn More" CTA button at bottom right (subtle, neutral).',
  call_now:    'A "Call Now" CTA button at bottom right (with a phone icon).',
};

function buildCreativePrompt({
  productName,
  productDescription,
  headline,
  targetCountries,
  language,
  aspectRatio = '1:1',
  ctaStyle = 'whatsapp',
}) {
  const lang = language || 'English';
  const sceneBrief = (productDescription || '').trim();
  const framing = ASPECT_FRAMING[aspectRatio] || ASPECT_FRAMING['1:1'];
  const ctaLine = CTA_OVERLAY[ctaStyle] || CTA_OVERLAY.whatsapp;
  return `Generate a professional advertising image for a B2B ad.

## Framing
${framing}

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
- ${ctaLine}
- No Chinese/CJK characters unless language is Chinese
- No phone numbers, no email addresses, no URLs in the image
- No emojis in text overlay
- The ONLY text on the image is the headline above + the CTA chip — do not add taglines, sub-headers, or feature callouts unless the scene brief explicitly asks for them`;
}

// ── Image generation via OpenRouter chat/completions ────────────────────
//
// 适用 image-out 模型 (openai/gpt-5.4-image-2、google/gemini-3.1-flash-
// image-preview 等)。OR 不暴露 /v1/images/edits,这些模型统一走 chat-
// completions 输出 message.images[]。参考图当 image_url part 塞进去。

async function callOpenRouterImageGen(model, prompt, refUrls) {
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
      // OpenRouter 实际扣费(usage.cost)。caller 直接落表,绕过本地价表
      // (token 计费的模型本地价表偏差最大可达 45 倍)。
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Image generation failed');

  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('No message in response');

  // image-out 模型的图在 message.images[] (不是 message.content[]) ——
  // content 在图响应里是 null。每项形如:
  //   { type: 'image_url', image_url: { url: 'data:image/...;base64,...' } }
  let b64 = null;
  for (const part of Array.isArray(message.images) ? message.images : []) {
    if (part?.type === 'image_url') {
      const u = part.image_url?.url;
      b64 = u?.includes(',') ? u.split(',')[1] : u;
      if (b64) break;
    }
  }
  if (!b64) throw new Error('No image returned by model');

  return { imageBuffer: Buffer.from(b64, 'base64'), model: data.model || model, usage: data.usage || null };
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
  if (uploadError) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.storage.upload_failed',
      component: 'ogilvy/creative',
      session_id: sessionId || null,
      tenant_id: tenantId,
      bucket: STORAGE_BUCKET,
      storage_path: storagePath,
      image_size: imageBuffer.length,
      model,
      error: uploadError.message,
    }));
    throw new Error(`Storage upload failed: ${uploadError.message}`);
  }

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
  if (dbError) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.aigc_assets.insert_failed',
      component: 'ogilvy/creative',
      session_id: sessionId || null,
      tenant_id: tenantId,
      user_id: userId || null,
      model,
      storage_path: storagePath,
      pg_code: dbError.code || null,
      pg_details: dbError.details || null,
      error: dbError.message,
    }));
    throw new Error(`DB insert failed: ${dbError.message}`);
  }

  return { id: row.id, url: urlData.publicUrl, storage_path: storagePath };
}

// ── Public entry ────────────────────────────────────────────────────────

/**
 * Generate one ad image from product info + reference images.
 *
 * Primary: openai/gpt-5.4-image-2 via OpenRouter chat-completions. On failure,
 * falls back once to google/gemini-3.1-flash-image-preview. Returns
 * { url, storage_path, model, ... } on success, { error, message } on failure.
 */
export async function generateAdCreative({
  productName,
  productDescription,
  headline,
  referenceImageUrls = [],
  targetCountries = [],
  language = 'English',
  aspectRatio = '1:1',
  ctaStyle = 'whatsapp',
  creativeType = 'single_image',
  sessionId = null,
  userId = null,
  tenantId = null,
  productLine = null,
  authClient = null,
}) {
  if (!tenantId) {
    return { error: 'tenant_required', message: 'tenantId is required' };
  }
  if (!config.openrouter.apiKey) {
    return { error: 'config_missing', message: 'OPENROUTER_API_KEY is not configured' };
  }
  // CTWA ads need photorealistic product fidelity — reference images are mandatory.
  const refs = filterSupportedRefs(referenceImageUrls).slice(0, 3);
  if (!refs.length) {
    return {
      error: 'no_reference_images',
      message: '需要至少一张产品参考图。请让用户上传产品照片后再生成素材。',
    };
  }

  const prompt = buildCreativePrompt({
    productName,
    productDescription,
    headline,
    targetCountries,
    language,
    aspectRatio,
    ctaStyle,
  });

  // 入口埋点 —— 没出问题也能看到这次到底用了几张参考图、目标语言/国家、prompt
  // 多大，跟下面每个 attempt 的成败配对就能完整还原一次生图过程。事件名用
  // 'creative.start' 跟 llm-client 的 'llm.call' 区分开，pm2 logs 可直接 grep。
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'creative.start',
    component: 'ogilvy/creative',
    session_id: sessionId,
    tenant_id: tenantId,
    product_line: productLine,
    primary_model: PRIMARY_MODEL,
    fallback_model: FALLBACK_MODEL,
    ref_count: refs.length,
    target_countries: targetCountries,
    language,
    headline_len: (headline || '').length,
    prompt_len: prompt.length,
  }));

  // Primary → fallback. We log each failure to stderr but return the
  // aggregate error only after both paths fail. 两条路径同一 caller,只换 model。
  const attempts = [
    { label: 'primary',  model: PRIMARY_MODEL  },
    { label: 'fallback', model: FALLBACK_MODEL },
  ];

  let lastErr;
  for (const { label, model } of attempts) {
    const t0 = Date.now();
    try {
      const generated = await callOpenRouterImageGen(model, prompt, refs);
      // 图片成本两档:
      //   1. response.usage.cost (OpenRouter 权威账单值)
      //   2. 兜底 flat per-call(usage 缺失时,见 llm-pricing.js#IMAGE_PRICES_PER_CALL)
      // 从 2026-05-17 起 ogilvy session 强绑 product_line,/product-lines/[id]
      // /cost-stats 能看到本产品线的图片生成开销。
      const orCost = generated.usage?.cost;
      const inputTokens = Number(generated.usage?.input_tokens) || 0;
      const outputTokens = Number(generated.usage?.output_tokens) || 0;
      const costUsdOverride = orCost != null
        ? orCost
        : calcImageCostUsd({ model: generated.model, count: 1 });
      const costSource = orCost != null ? 'openrouter' : 'local-pricing-table';
      logLlmCall({
        method: 'image.edit',
        provider: 'openrouter',
        models: [generated.model],
        responseModel: generated.model,
        finishReason: 'image_returned',
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        durationMs: Date.now() - t0,
        tenantId,
        callSite: 'ogilvy.image-gen',
        sessionId,
        productLine,
        costUsdOverride,
        costSource,
      });
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
      // aspect_ratio / cta_style / creative_type echoed so the model can
      // confirm what was actually produced; `placeholder` flags non-single_image
      // requests as a synthetic single image (carousel/video not yet real).
      return {
        url: asset.url,
        storage_path: asset.storage_path,
        model: generated.model,
        headline: headline || null,
        product_name: productName || null,
        aspect_ratio: aspectRatio,
        cta_style: ctaStyle,
        creative_type: creativeType,
        placeholder: creativeType !== 'single_image',
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      // 结构化 stdout —— 让 pm2 logs / 日志聚合平台都能 grep "creative.attempt.fail"。
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        event: 'creative.attempt.fail',
        component: 'ogilvy/creative',
        session_id: sessionId,
        tenant_id: tenantId,
        product_line: productLine,
        attempt: label,
        model,
        duration_ms: durationMs,
        error_message: err?.message || String(err),
      }));
      // 同时落 llm_usage_logs —— 没这一行的话整次会话只有 fallback 的成功记录，
      // 完全看不出 primary 是否被尝试过、为什么挂。cost_usd=0 因为失败不扣费。
      logLlmCall({
        method: 'image.edit',
        provider: 'openrouter',
        models: [model],
        responseModel: model,
        finishReason: 'error',
        promptTokens: 0,
        completionTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        durationMs,
        tenantId,
        callSite: 'ogilvy.image-gen',
        sessionId,
        productLine,
        costUsdOverride: 0,
        costSource: 'no-charge-failed',
        errorMessage: err?.message || String(err),
      });
      lastErr = err;
    }
  }
  return { error: 'image_generation_failed', message: lastErr?.message || 'All paths failed' };
}
