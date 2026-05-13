/**
 * KB Image Extractor — pull embedded images out of uploaded documents,
 * encode them as JPEG, vision-caption them, and write kb_assets rows.
 *
 * Currently handles:
 *   - PDF  (via unpdf → raw pixels + sharp → JPEG)
 *   - DOCX (via mammoth's image converter)
 *   - XLSX (via jszip → xl/media/* → sharp)
 *
 * .csv / .txt / .md don't have meaningful embedded images.
 *
 * Output: each extracted image becomes a kb_assets row with source_doc_id
 * pointing back to the document, an auto-generated caption, and tag
 * inferences (is_sendable=false if vision marks it as internal-looking).
 */
import crypto from 'node:crypto';
import sharp from 'sharp';
import { extractImages } from 'unpdf';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import supabase from '../lib/supabase.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { openrouter, MODELS } from './llm-client.js';
import { generateEmbedding } from './kb-search.service.js';

const STORAGE_BUCKET = 'kb-assets';

// Skip tiny images (likely logos, icons, decorative bullets).
// Threshold tuned so a 200×200 product thumb still passes but a 32×32 icon doesn't.
const MIN_IMAGE_PIXELS = 100 * 100;

// Vision-caption fan-out. 8 keeps Haiku rate-limit-safe while collapsing
// a 50-image extract from ~minutes (serial) to ~10s.
const VISION_CONCURRENCY = 8;

// "Are you sure?" tripwire. The 50 MB file ceiling is the real cap; this only
// fires for pathological cases (someone fits 5000 logos into one doc) and emits
// a warning rather than silently truncating.
const SANITY_IMAGE_WARN_AT = 500;

// Inner-loop memory safety cap. We load each candidate's raw pixel buffer into
// memory before the worker pool runs, so a 5000-image doc could easily eat
// many GB of RAM. The cap is intentionally well above SANITY_IMAGE_WARN_AT
// so a realistic catalog never hits it; if it does, that's the rare case
// where truncation is the lesser evil compared to OOM-killing the process.
const MAX_IMAGES_PER_DOC = 2000;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Extract all images from a document buffer, persist + caption + write
 * kb_assets rows. Returns a summary so the upload route can include it
 * in its response.
 *
 * Reparse-safe: before extracting, deletes any prior kb_assets rows (and
 * their storage objects) that this same source_doc_id wrote under
 * `<agent_id>/extracted/`. Manually-uploaded assets at other paths are
 * untouched.
 *
 * @param {Object} ctx                   { tenantId, agentId, productLineId }
 * @param {Buffer} buffer                Raw file bytes (already validated upstream)
 * @param {string} docId                 kb_documents.id this file became
 * @param {string} mimeType              File MIME type
 * @param {Object} [options]
 * @param {(ev:any)=>void} [options.onProgress]  Receives
 *                                       `{stage:'images', total, done, warning?}`
 *                                       events. Surfaced via SSE in the upload
 *                                       pipeline so the KB UI can show "12/47".
 * @returns {Promise<{extracted: number, skipped: number, total: number, errors: string[]}>}
 */
export async function extractAndStoreImages(ctx, buffer, docId, mimeType, options = {}) {
  const { tenantId, agentId, productLineId } = ctx || {};
  if (!tenantId || !agentId || !productLineId) {
    throw new Error('extractAndStoreImages: tenantId+agentId+productLineId required');
  }
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  // Clear prior auto-extracted rows for this doc so reparse / re-upload don't
  // pile up duplicates. We scope deletion to storage paths under
  // `<agent>/extracted/`, leaving any future hand-uploaded assets alone.
  await clearPriorAutoAssets({ tenantId, docId });

  let rawImages = [];
  try {
    if (mimeType === 'application/pdf') {
      rawImages = await extractPdfImages(buffer);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      rawImages = await extractDocxImages(buffer);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      rawImages = await extractXlsxImages(buffer);
    } else {
      // Other types (csv/md/txt): no extraction
      onProgress?.({ stage: 'images', total: 0, done: 0 });
      return { extracted: 0, skipped: 0, total: 0, errors: [] };
    }
  } catch (e) {
    return { extracted: 0, skipped: 0, total: 0, errors: [`extract failed: ${e.message}`] };
  }

  const candidates = rawImages.filter(img => img.width * img.height >= MIN_IMAGE_PIXELS);
  const skippedTiny = rawImages.length - candidates.length;

  if (candidates.length === 0) {
    onProgress?.({ stage: 'images', total: 0, done: 0 });
    return { extracted: 0, skipped: skippedTiny, total: 0, errors: [] };
  }

  // Sanity warning, not a cap — emit through SSE so the UI can show it.
  if (candidates.length >= SANITY_IMAGE_WARN_AT) {
    onProgress?.({
      stage: 'images',
      total: candidates.length,
      done: 0,
      warning: `本文件包含 ${candidates.length} 张图，将全部抽取（可能耗时较久）。`,
    });
  } else {
    onProgress?.({ stage: 'images', total: candidates.length, done: 0 });
  }

  // Worker-pool: VISION_CONCURRENCY parallel processOneImage calls. Each emits
  // a progress tick when it finishes so the UI counter ticks live.
  // `seenHashes` is shared across workers — same-bytes image (logo repeated
  // across sheets) is dropped without a wasted DB SELECT or storage write.
  // `hashColumnExists` is probed once on the first call and reused so every
  // image after the first either trusts the column is present, or skips the
  // dedup query entirely. Saves N round-trips on big xlsx uploads.
  const ctxShared = {
    tenantId, agentId, productLineId, docId,
    seenHashes: new Set(),
    hashColumnState: { probed: false, exists: true },
  };
  let extracted = 0;
  let processed = 0;
  const errors = [];
  let nextIdx = 0;
  const worker = async () => {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= candidates.length) return;
      try {
        const ok = await processOneImage(ctxShared, candidates[myIdx], myIdx);
        if (ok !== false) extracted++;
      } catch (e) {
        errors.push(`image ${myIdx}: ${e.message}`);
      }
      processed++;
      onProgress?.({ stage: 'images', total: candidates.length, done: processed });
    }
  };
  const workerCount = Math.min(VISION_CONCURRENCY, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  return {
    extracted,
    skipped: skippedTiny,
    total: candidates.length,
    errors,
  };
}

/**
 * Remove auto-extracted kb_assets (and their storage objects) for one source
 * document. Scoped to `<agent>/extracted/` so we don't trash anything a human
 * uploaded under a different prefix. Best-effort: failures here don't block
 * the fresh extraction pass that follows.
 */
async function clearPriorAutoAssets({ tenantId, docId }) {
  if (!docId) return;
  try {
    const { data: prior } = await supabase
      .from('kb_assets')
      .select('id, storage_path')
      .eq('tenant_id', tenantId)
      .eq('source_doc_id', docId)
      .like('storage_path', '%/extracted/%');
    if (!prior || prior.length === 0) return;

    const admin = getSupabaseAdmin();
    const paths = prior.map((r) => r.storage_path).filter(Boolean);
    if (paths.length > 0) {
      try {
        await admin.storage.from(STORAGE_BUCKET).remove(paths);
      } catch (e) {
        console.warn('[kb-image-extractor] storage cleanup failed:', e?.message);
      }
    }
    const ids = prior.map((r) => r.id);
    const { error } = await supabase.from('kb_assets').delete().in('id', ids);
    if (error) console.warn('[kb-image-extractor] kb_assets cleanup failed:', error.message);
  } catch (e) {
    console.warn('[kb-image-extractor] clearPriorAutoAssets failed:', e?.message);
  }
}

// ── Per-image pipeline ──────────────────────────────────────────────

async function processOneImage(ctx, img, idx) {
  const { tenantId, agentId, productLineId, docId, seenHashes, hashColumnState } = ctx;

  // 1. Encode raw pixel buffer → JPEG (consistent format for storage + vision)
  const jpegBuffer = await encodeToJpeg(img);
  const contentSha256 = crypto.createHash('sha256').update(jpegBuffer).digest('hex');

  // 1b. In-memory dedup: if a worker already enqueued this exact byte stream
  //     in the current batch (logo repeated across xlsx sheets), drop it
  //     without any DB or storage I/O.
  if (seenHashes?.has(contentSha256)) return false;
  seenHashes?.add(contentSha256);

  // 1c. DB dedup probe — only on the first image of the batch. We just cleared
  //     prior auto-extracted rows for this doc, so any leftover hit means a
  //     concurrent run; honor it and skip. Subsequent images can rely on the
  //     in-memory Set (we just inserted the row a moment ago, but it's the
  //     same process — Set covers it).
  const probeState = hashColumnState || { probed: true, exists: true };
  if (!probeState.probed) {
    try {
      const { data: dup, error: dupErr } = await supabase
        .from('kb_assets')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('source_doc_id', docId)
        .eq('content_sha256', contentSha256)
        .maybeSingle();
      if (dupErr) {
        if (dupErr.code === '42703' || /content_sha256/i.test(dupErr.message || '')) {
          probeState.exists = false;
        } else {
          throw dupErr;
        }
      } else if (dup) {
        probeState.probed = true;
        return false;
      }
    } catch (e) {
      if (/content_sha256/i.test(e?.message || '')) {
        probeState.exists = false;
      } else {
        throw e;
      }
    }
    probeState.probed = true;
  }
  const hashColumnExists = probeState.exists;

  // 2. Storage upload + Vision caption in parallel — neither depends on the
  //    other's result. Saves ~200-500ms per image.
  const admin = getSupabaseAdmin();
  const filename = `${docId}_img${String(idx + 1).padStart(2, '0')}.jpg`;
  const storagePath = `${agentId}/extracted/${filename}`;

  const [uploadResult, visionResult] = await Promise.all([
    admin.storage.from(STORAGE_BUCKET).upload(storagePath, jpegBuffer, {
      contentType: 'image/jpeg', upsert: true,
    }),
    captionAndJudge(jpegBuffer),
  ]);
  if (uploadResult.error) throw new Error(`storage upload: ${uploadResult.error.message}`);

  // 3. Caption embedding (so semantic find_asset can reach it). Must follow
  //    vision because the input is the caption text.
  let captionEmbedding = null;
  try {
    if (visionResult.caption) {
      captionEmbedding = await generateEmbedding(visionResult.caption);
    }
  } catch {
    // Embedding is best-effort — kb_assets row should still land
  }

  // 4. Write kb_assets row. Only include content_sha256 if the column exists —
  //    a missing column raises 42703 and aborts the insert, so we omit it when
  //    the dedup probe earlier signaled the migration isn't applied yet.
  const insertRow = {
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
  };
  if (hashColumnExists) insertRow.content_sha256 = contentSha256;
  const { error: insErr } = await supabase.from('kb_assets').insert(insertRow);
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

// ── XLSX ─────────────────────────────────────────────────────────────

// xlsx is a ZIP; embedded pictures (Insert → Picture, or pasted images)
// land in `xl/media/imageN.{png|jpeg|gif|...}`. Cell anchors live in
// `xl/drawings/*.xml` — we don't need them for retrieval, the raw bytes are
// enough for vision-caption + sendable judgment.
async function extractXlsxImages(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const mediaFiles = Object.keys(zip.files).filter(
    (p) => p.startsWith('xl/media/') && !zip.files[p].dir,
  );

  const out = [];
  for (const path of mediaFiles) {
    if (out.length >= MAX_IMAGES_PER_DOC) break;
    try {
      const imgBuffer = await zip.files[path].async('nodebuffer');
      const meta = await sharp(imgBuffer).metadata();
      if (!meta.width || !meta.height) continue;
      const { data, info } = await sharp(imgBuffer).raw().toBuffer({ resolveWithObject: true });
      out.push({
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
        width: info.width,
        height: info.height,
        channels: info.channels,
        key: path,
      });
    } catch {
      // Skip undecodable entries (rare format / corrupt blob).
    }
  }
  return out;
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
    // Vision failure: keep the image but flag for review (is_sendable=null,
    // not false — false hides it from Medici forever; null marks it "pending"
    // so the operator can decide in the KB UI).
    return {
      caption: '(auto-caption failed — pending review)',
      asset_type: 'product_image',
      view: null,
      scenario: null,
      is_sendable: null,
    };
  }
}
