/**
 * KB Image Extractor — pull embedded images out of uploaded documents,
 * encode them as JPEG, vision-caption them, and write kb_assets rows.
 *
 * Currently handles:
 *   - PDF  (via unpdf → raw pixels + sharp → JPEG)
 *   - DOCX (via mammoth's image converter)
 *
 * .xlsx / .csv / .txt / .md don't have meaningful embedded images.
 *
 * Output: each extracted image becomes a kb_assets row with source_doc_id
 * pointing back to the document, an auto-generated caption, and tag
 * inferences (is_sendable=false if vision marks it as internal-looking).
 */
import sharp from 'sharp';
import { extractImages } from 'unpdf';
import mammoth from 'mammoth';
import supabase from '../lib/supabase.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { openrouter, MODELS } from './llm-client.js';
import { generateEmbedding } from './kb-search.service.js';

const STORAGE_BUCKET = 'kb-assets';

// Skip tiny images (likely logos, icons, decorative bullets).
// Threshold tuned so a 200×200 product thumb still passes but a 32×32 icon doesn't.
const MIN_IMAGE_PIXELS = 100 * 100;

// Cap on extraction work per document to avoid runaway costs on huge brochures.
const MAX_IMAGES_PER_DOC = 20;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Extract all images from a document buffer, persist + caption + write
 * kb_assets rows. Returns a summary so the upload route can include it
 * in its response.
 *
 * @param {Object} ctx          { tenantId, agentId, productLineId }
 * @param {Buffer} buffer       Raw file bytes (already validated upstream)
 * @param {string} docId        kb_documents.id this file became
 * @param {string} mimeType     File MIME type
 * @returns {Promise<{extracted: number, skipped: number, errors: string[]}>}
 */
export async function extractAndStoreImages(ctx, buffer, docId, mimeType) {
  const { tenantId, agentId, productLineId } = ctx || {};
  if (!tenantId || !agentId || !productLineId) {
    throw new Error('extractAndStoreImages: tenantId+agentId+productLineId required');
  }

  let rawImages = [];
  try {
    if (mimeType === 'application/pdf') {
      rawImages = await extractPdfImages(buffer);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      rawImages = await extractDocxImages(buffer);
    } else {
      // Other types (xlsx/csv/md/txt): no extraction
      return { extracted: 0, skipped: 0, errors: [] };
    }
  } catch (e) {
    return { extracted: 0, skipped: 0, errors: [`extract failed: ${e.message}`] };
  }

  // Cap + filter tiny
  const candidates = rawImages
    .filter(img => img.width * img.height >= MIN_IMAGE_PIXELS)
    .slice(0, MAX_IMAGES_PER_DOC);

  let extracted = 0;
  const errors = [];
  for (const [idx, img] of candidates.entries()) {
    try {
      await processOneImage({ tenantId, agentId, productLineId, docId }, img, idx);
      extracted++;
    } catch (e) {
      errors.push(`image ${idx}: ${e.message}`);
    }
  }

  return {
    extracted,
    skipped: rawImages.length - candidates.length,
    errors,
  };
}

// ── Per-image pipeline ──────────────────────────────────────────────

async function processOneImage(ctx, img, idx) {
  const { tenantId, agentId, productLineId, docId } = ctx;

  // 1. Encode raw pixel buffer → JPEG (consistent format for storage + vision)
  const jpegBuffer = await encodeToJpeg(img);

  // 2. Upload to storage. Use admin (service-role) client because this runs
  //    as a back-end side effect of the user-initiated doc upload — there's
  //    no user session to inherit, and the kb-assets bucket RLS only permits
  //    'authenticated' role.
  const admin = getSupabaseAdmin();
  const filename = `${docId}_img${String(idx + 1).padStart(2, '0')}.jpg`;
  const storagePath = `${agentId}/extracted/${filename}`;
  const { error: upErr } = await admin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, jpegBuffer, { contentType: 'image/jpeg', upsert: true });
  if (upErr) throw new Error(`storage upload: ${upErr.message}`);

  // 3. Vision caption + safety call
  const visionResult = await captionAndJudge(jpegBuffer);

  // 4. Caption embedding (so semantic find_asset can reach it)
  let captionEmbedding = null;
  try {
    if (visionResult.caption) {
      captionEmbedding = await generateEmbedding(visionResult.caption);
    }
  } catch {
    // Embedding is best-effort — kb_assets row should still land
  }

  // 5. Write kb_assets row
  const { error: insErr } = await supabase.from('kb_assets').insert({
    tenant_id: tenantId,
    agent_id: agentId,
    product_line_id: productLineId,
    asset_type: visionResult.asset_type || 'product_image',
    filename,
    storage_path: storagePath,
    mime_type: 'image/jpeg',
    file_size_bytes: jpegBuffer.length,
    description: visionResult.caption,
    description_en: visionResult.caption,
    caption_embedding: captionEmbedding,
    view: visionResult.view,
    scenario: visionResult.scenario,
    is_sendable: visionResult.is_sendable,
    source_doc_id: docId,
  });
  if (insErr) {
    // Roll back the storage upload to avoid orphans (use admin client — same
    // role that wrote the object, so it can also delete it).
    await admin.storage.from(STORAGE_BUCKET).remove([storagePath])
      .catch((cleanupErr) => console.warn('[kb-image-extractor] rollback storage remove failed:', cleanupErr?.message));
    throw new Error(`insert kb_assets: ${insErr.message}`);
  }
}

// ── Encoding ────────────────────────────────────────────────────────

async function encodeToJpeg({ data, width, height, channels }) {
  // unpdf returns Uint8ClampedArray of raw pixels.
  // sharp expects Buffer with explicit { raw: { width, height, channels } }.
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels },
  }).jpeg({ quality: 85 }).toBuffer();
}

// ── PDF ──────────────────────────────────────────────────────────────

async function extractPdfImages(buffer) {
  // unpdf's extractImages takes (data, pageNumber). We need to walk all pages.
  // Get document proxy first to know page count.
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pageCount = pdf.numPages;
  const all = [];
  for (let p = 1; p <= pageCount; p++) {
    try {
      const pageImages = await extractImages(pdf, p);
      for (const img of pageImages) {
        all.push(img);
      }
    } catch {
      // Page-level failure: skip just this page
    }
    if (all.length >= MAX_IMAGES_PER_DOC) break;
  }
  return all;
}

// ── DOCX ─────────────────────────────────────────────────────────────

async function extractDocxImages(buffer) {
  // mammoth lets us hook into image conversion. Capture raw image buffers
  // instead of returning HTML — we don't care about the HTML output.
  const collected = [];
  await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const imgBuffer = await image.read();
        // Decode through sharp to get width/height/channels in raw form
        try {
          const meta = await sharp(imgBuffer).metadata();
          // sharp can extract the raw pixels at original size
          const { data, info } = await sharp(imgBuffer).raw().toBuffer({ resolveWithObject: true });
          collected.push({
            data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
            width: info.width,
            height: info.height,
            channels: info.channels,
            key: image.contentType || 'docx-image',
          });
        } catch {
          // If sharp can't decode (rare format), skip
        }
        return { src: '' }; // we don't care about the HTML output
      }),
    }
  );
  return collected;
}

// ── Vision caption + safety judgment ────────────────────────────────

const VISION_PROMPT = `Look at this image from a B2B export company's product document and reply with ONLY a JSON object:

{
  "caption": "1-2 sentence English description of what's actually visible (product? scene? document?). Be specific — include color, model markings, count if discernible.",
  "asset_type": "product_image" | "certificate" | "factory" | "logistics" | "brochure" | "spec_sheet" | "other",
  "view": "front" | "side" | "rear" | "interior" | "engine" | "detail" | "color_swatch" | null,
  "scenario": "factory" | "warehouse" | "loading" | "in_use" | null,
  "is_sendable": true | false
}

Set is_sendable=false ONLY if the image is clearly internal/unsuitable to send to customers: cost sheets, internal blueprints, watermarked drafts, screenshots of spreadsheets, low-quality scans of forms. Otherwise default to true.

If the image is a logo, decorative element, or page header (no product/info content), set asset_type="other" and is_sendable=false.`;

async function captionAndJudge(jpegBuffer) {
  const base64 = jpegBuffer.toString('base64');
  try {
    const response = await openrouter.messages.create({
      models: [MODELS.HAIKU],
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    });
    const text = response.choices?.[0]?.message?.content?.trim() || '{}';
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const parsed = JSON.parse(jsonMatch[1].trim());
    return {
      caption: String(parsed.caption || '').slice(0, 500),
      asset_type: parsed.asset_type || 'product_image',
      view: parsed.view || null,
      scenario: parsed.scenario || null,
      is_sendable: parsed.is_sendable !== false,
    };
  } catch (e) {
    // Vision failure: fall back to generic caption, mark unsendable so a human reviews
    return {
      caption: '(auto-caption failed)',
      asset_type: 'other',
      view: null,
      scenario: null,
      is_sendable: false,
    };
  }
}
