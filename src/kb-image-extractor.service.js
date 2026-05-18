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

  // Probe once up-front whether the content_sha256 column exists, before
  // spawning workers. Previously this was a per-image lazy probe with
  // `hashColumnState.probed`, but all 8 workers would race past the probe
  // simultaneously and each fire its own SELECT (N round-trips instead of 1).
  // One probe at the top, shared via ctx.
  const hashColumnExists = await probeContentShaColumn();

  // Worker-pool: VISION_CONCURRENCY parallel processOneImage calls. Each emits
  // a progress tick when it finishes so the UI counter ticks live.
  // `seenHashes` is shared across workers — same-bytes image (logo repeated
  // across sheets) is dropped without a wasted DB SELECT or storage write.
  const ctxShared = {
    tenantId, agentId, productLineId, docId,
    seenHashes: new Set(),
    hashColumnExists,
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
 * Cheap probe: does `kb_assets` have the `content_sha256` column?
 * If the 2026-05-13 migration hasn't been applied, the column is missing
 * and Postgres replies with 42703 — we treat that as "skip dedup features"
 * for the rest of the run.
 *
 * One call up-front instead of having every worker race their own probe.
 */
async function probeContentShaColumn() {
  try {
    const { error } = await supabase
      .from('kb_assets')
      .select('content_sha256', { head: true, count: 'exact' })
      .limit(1);
    if (!error) return true;
    if (error.code === '42703' || /content_sha256/i.test(error.message || '')) return false;
    // unknown error → assume column exists; later INSERT will surface specifics
    return true;
  } catch (e) {
    if (/content_sha256/i.test(e?.message || '')) return false;
    return true;
  }
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
  const { tenantId, agentId, productLineId, docId, seenHashes, hashColumnExists } = ctx;

  // 1. Encode raw pixel buffer → JPEG (consistent format for storage + vision)
  const jpegBuffer = await encodeToJpeg(img);
  const contentSha256 = crypto.createHash('sha256').update(jpegBuffer).digest('hex');

  // 1b. In-memory dedup: if a worker already enqueued this exact byte stream
  //     in the current batch (logo repeated across xlsx sheets), drop it
  //     without any DB or storage I/O.
  //
  //     Note: `has` and `add` are back-to-back synchronous calls with no await
  //     in between, so a worker can't interleave between them. JS event loop
  //     guarantees atomicity here.
  if (seenHashes?.has(contentSha256)) return false;
  seenHashes?.add(contentSha256);

  // 2. Storage upload + Vision caption in parallel — neither depends on the
  //    other's result. Saves ~200-500ms per image.
  const admin = getSupabaseAdmin();
  const filename = `${docId}_img${String(idx + 1).padStart(2, '0')}.jpg`;
  const storagePath = `${agentId}/extracted/${filename}`;

  const [uploadResult, visionResult] = await Promise.all([
    admin.storage.from(STORAGE_BUCKET).upload(storagePath, jpegBuffer, {
      contentType: 'image/jpeg', upsert: true,
    }),
    captionAndJudge(jpegBuffer, { tenantId, productLineId }),
  ]);
  if (uploadResult.error) throw new Error(`storage upload: ${uploadResult.error.message}`);

  // 3. Row context (XLSX only). When the source XLSX has the image anchored
  //    to a cell, we know which row → which product. Prepend that to the
  //    caption so the embedding sees it, and surface linked_skus so the
  //    tag-based find_asset path can hit ("VA3" → matches this image).
  //    Without this, vision-only captions read like "a gray sedan" with
  //    zero linkage back to the model name in the spreadsheet.
  const rowContext = img.rowContext || null;
  const enrichedCaption = rowContext?.summary
    ? `[${rowContext.summary}] ${visionResult.caption || ''}`.trim()
    : (visionResult.caption || '');

  // 4. Caption embedding (so semantic find_asset can reach it). Must follow
  //    vision because the input is the caption text. Embed the enriched
  //    version so semantic search picks up "捷达VA3 / Jetta VA3" tokens.
  let captionEmbedding = null;
  try {
    if (enrichedCaption) {
      captionEmbedding = await generateEmbedding(enrichedCaption, {
        tenantId, callSite: 'kb.embedding.caption', productLine: productLineId,
      });
    }
  } catch {
    // Embedding is best-effort — kb_assets row should still land
  }

  // 5. Write kb_assets row. Only include content_sha256 if the column exists —
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
    description: enrichedCaption,
    description_en: enrichedCaption,
    caption_embedding: captionEmbedding,
    view: visionResult.view,
    scenario: visionResult.scenario,
    is_sendable: visionResult.is_sendable,
    linked_skus: rowContext?.linkedSkus?.length ? rowContext.linkedSkus : null,
    source_doc_id: docId,
  };
  if (hashColumnExists) insertRow.content_sha256 = contentSha256;
  const { error: insErr } = await supabase.from('kb_assets').insert(insertRow);
  if (insErr) {
    // 23505 = unique_violation on (tenant_id, source_doc_id, content_sha256).
    // Means a concurrent run (reparse-vs-upload, PM2 restart respawn) already
    // wrote this exact image. Treat as soft-dedup: DON'T rollback storage —
    // the row that won the race is using the same path (`upsert:true` above
    // means our blob WAS the one persisted, and removing it would orphan the
    // legitimate row).
    if (insErr.code === '23505') {
      return false;
    }
    // Other errors: roll back the storage upload to avoid orphans (use admin
    // client — same role that wrote the object, so it can also delete it).
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
// `xl/drawings/*.xml`. We parse those anchors to map each image back to its
// row, then pull brand / product / model from the row's cells so the kb_assets
// row gets linked_skus + an enriched caption — without this binding, the
// image is just "a gray car" to find_asset.
async function extractXlsxImages(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  // Build path → rowContext map once, before walking media files.
  const anchorMap = await buildXlsxAnchorMap(zip).catch(() => new Map());

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
        rowContext: anchorMap.get(path) || null,
      });
    } catch {
      // Skip undecodable entries (rare format / corrupt blob).
    }
  }
  return out;
}

// ── XLSX anchor → row context ────────────────────────────────────────
// XLSX is OOXML. Pictures referenced as `<xdr:pic>` inside
// `xl/drawings/drawingN.xml` carry an anchor (<xdr:from>/<xdr:row>) and an
// embed rId. The drawing's _rels file maps rId → media path. The sheet that
// owns the drawing is found through `xl/worksheets/_rels/sheetN.xml.rels`.
//
// We bypass a full XML parser dep (xlsx community edition doesn't preserve
// images, fast-xml-parser isn't installed). The shapes we need are well-
// structured enough that scoped regexes handle them — wrap the whole pipeline
// in a single try/catch in the caller so any parse miss degrades to "no
// anchor info" rather than failing the upload.

async function buildXlsxAnchorMap(zip) {
  const map = new Map();
  const sharedStrings = await loadXlsxSharedStrings(zip);

  const sheetPaths = Object.keys(zip.files).filter(
    (p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p) && !zip.files[p].dir,
  );

  // WPS DISPIMG: build the global ID→media map once. The user's catalog
  // XLSX uses this scheme (`_xlfn.DISPIMG("ID_xxx",1)` formulas referencing
  // pictures in `xl/cellimages.xml`) instead of standard <xdr:pic> anchors.
  // Without this branch, only ~1 image gets bound; the rest fall back to
  // anonymous vision-captioned blobs.
  const dispImgIdToMedia = await loadWpsDispImgMap(zip);

  for (const sheetPath of sheetPaths) {
    const sheetNum = (sheetPath.match(/sheet(\d+)\.xml$/) || [])[1];
    if (!sheetNum) continue;

    const sheetXml = await zip.files[sheetPath].async('string');
    const headerCols = parseHeaderRow(sheetXml, sharedStrings);

    // Path A: standard cell anchors via xl/drawings/drawing*.xml
    const sheetRelsPath = `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`;
    if (zip.files[sheetRelsPath]) {
      const sheetRelsXml = await zip.files[sheetRelsPath].async('string');
      const drawingNum = (sheetRelsXml.match(/Target="[^"]*drawings\/drawing(\d+)\.xml"/) || [])[1];
      if (drawingNum) {
        const drawingRelsPath = `xl/drawings/_rels/drawing${drawingNum}.xml.rels`;
        const drawingPath = `xl/drawings/drawing${drawingNum}.xml`;
        if (zip.files[drawingRelsPath] && zip.files[drawingPath]) {
          const [drawingRelsXml, drawingXml] = await Promise.all([
            zip.files[drawingRelsPath].async('string'),
            zip.files[drawingPath].async('string'),
          ]);
          const rIdToMedia = parseRelsTargets(drawingRelsXml, drawingRelsPath);
          const anchors = parseDrawingAnchors(drawingXml, rIdToMedia);
          if (headerCols.size) {
            for (const anchor of anchors) {
              const rowNum = anchor.row + 1;
              const rowCells = parseSheetRowCells(sheetXml, rowNum, sharedStrings);
              if (!rowCells.size) continue;
              const ctx = buildRowContext(headerCols, rowCells);
              if (ctx) map.set(anchor.mediaPath, ctx);
            }
          }
        }
      }
    }

    // Path B: WPS DISPIMG formulas inside sheet cells. The row is the cell's
    // own row; the image is looked up by the DISPIMG ID through cellimages.xml.
    if (dispImgIdToMedia.size && headerCols.size) {
      const cellHits = findDispImgCells(sheetXml);
      for (const hit of cellHits) {
        const mediaPath = dispImgIdToMedia.get(hit.dispId);
        if (!mediaPath) continue;
        if (map.has(mediaPath)) continue; // Path A wins if it already bound
        const rowCells = parseSheetRowCells(sheetXml, hit.row, sharedStrings);
        if (!rowCells.size) continue;
        const ctx = buildRowContext(headerCols, rowCells);
        if (ctx) map.set(mediaPath, ctx);
      }
    }
  }
  return map;
}

// `<Relationship Id="rId1" Target="..."/>` parser. Resolves Target relative
// to the rels file's owner document (drawing1.xml → drawings/, cellimages.xml
// → xl/). Returns Map<rId, absoluteZipPath>.
function parseRelsTargets(xml, relsPath) {
  const ownerDir = relsPath.replace(/_rels\/[^/]+\.rels$/, '').replace(/\/$/, '');
  const map = new Map();
  // Attributes contain "/" inside URL-shaped Type= values, so the inner
  // class must accept "/" — only the trailing literal /> is forbidden.
  for (const m of xml.matchAll(/<Relationship\b([^>]+?)\/>/g)) {
    const attrs = m[1];
    const id = (attrs.match(/\bId="([^"]+)"/) || [])[1];
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    if (!id || !target) continue;
    if (!/\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(target)) continue;
    map.set(id, resolveRelPath(ownerDir, target));
  }
  return map;
}

function resolveRelPath(ownerDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = ownerDir ? ownerDir.split('/').filter(Boolean) : [];
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function loadWpsDispImgMap(zip) {
  const map = new Map();
  if (!zip.files['xl/cellimages.xml'] || !zip.files['xl/_rels/cellimages.xml.rels']) return map;
  const [ci, ciRels] = await Promise.all([
    zip.files['xl/cellimages.xml'].async('string'),
    zip.files['xl/_rels/cellimages.xml.rels'].async('string'),
  ]);
  const rIdToMedia = parseRelsTargets(ciRels, 'xl/_rels/cellimages.xml.rels');
  // Each <etc:cellImage> wraps <xdr:pic> with cNvPr name="ID_xxx" and
  // <a:blip r:embed="rIdN"/>. The name IS the DISPIMG formula's first arg.
  for (const m of ci.matchAll(/<etc:cellImage\b[^>]*>([\s\S]*?)<\/etc:cellImage>/g)) {
    const inner = m[1];
    const idName = (inner.match(/<xdr:cNvPr\b[^>]*\bname="([^"]+)"/) || [])[1];
    const rId = (inner.match(/r:embed="([^"]+)"/) || [])[1];
    if (!idName || !rId) continue;
    const media = rIdToMedia.get(rId);
    if (media) map.set(idName, media);
  }
  return map;
}

function findDispImgCells(sheetXml) {
  // Walk each <c r="X#" ...>body</c> block separately so DISPIMG matches are
  // scoped to a single cell. A single span-the-whole-sheet regex caught the
  // first <c> in the document plus the next DISPIMG anywhere downstream,
  // producing wrong (col,row) pairs.
  const hits = [];
  for (const c of sheetXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attrs = c[1];
    const body = c[2];
    if (!body.includes('DISPIMG')) continue;
    const refMatch = attrs.match(/\br="([A-Z]+)(\d+)"/);
    if (!refMatch) continue;
    const dispMatch = body.match(/DISPIMG\([^,]*?(?:"|&quot;)(ID_[A-Fa-f0-9]+)(?:"|&quot;)/);
    if (!dispMatch) continue;
    hits.push({ col: refMatch[1], row: parseInt(refMatch[2], 10), dispId: dispMatch[1] });
  }
  return hits;
}

function parseDrawingAnchors(xml, rIdToMedia) {
  const anchors = [];
  const anchorRegex = /<xdr:(twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g;
  for (const m of xml.matchAll(anchorRegex)) {
    const inner = m[2];
    const fromBlock = inner.match(/<xdr:from>([\s\S]*?)<\/xdr:from>/);
    if (!fromBlock) continue;
    const rowMatch = fromBlock[1].match(/<xdr:row>(\d+)<\/xdr:row>/);
    if (!rowMatch) continue;
    const embedMatch = inner.match(/r:embed="([^"]+)"/);
    if (!embedMatch) continue;
    const mediaPath = rIdToMedia.get(embedMatch[1]);
    if (!mediaPath) continue;
    anchors.push({ row: parseInt(rowMatch[1], 10), mediaPath });
  }
  return anchors;
}

async function loadXlsxSharedStrings(zip) {
  const path = 'xl/sharedStrings.xml';
  if (!zip.files[path]) return [];
  const xml = await zip.files[path].async('string');
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const texts = [...m[1].matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((t) => decodeXmlEntities(t[1]));
    out.push(texts.join(''));
  }
  return out;
}

function decodeXmlEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseHeaderRow(sheetXml, sharedStrings) {
  // Try the first non-empty row in the sheet — covers files that have a
  // title row above the header.
  for (let r = 1; r <= 5; r++) {
    const cells = parseSheetRowCells(sheetXml, r, sharedStrings);
    if (cells.size >= 3) return cells;
  }
  return new Map();
}

function parseSheetRowCells(sheetXml, rowNum, sharedStrings) {
  const out = new Map();
  const re = new RegExp(`<row\\b[^>]*\\br="${rowNum}"[^>]*>([\\s\\S]*?)</row>`);
  const m = sheetXml.match(re);
  if (!m) return out;
  const rowBody = m[1];
  for (const c of rowBody.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attrs = c[1];
    const body = c[2];
    const cellRef = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
    if (!cellRef) continue;
    const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
    let value = null;
    if (t === 'inlineStr') {
      const inline = body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      if (inline) value = decodeXmlEntities(inline[1]);
    } else {
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      if (v) {
        if (t === 's') {
          const idx = parseInt(v[1], 10);
          value = sharedStrings[idx] || '';
        } else {
          value = decodeXmlEntities(v[1]);
        }
      }
    }
    if (value != null && String(value).trim() !== '') out.set(cellRef, String(value).trim());
  }
  return out;
}

// Header aliases — covers the columns that actually carry product identity.
// Add new aliases here if a new tenant's catalog uses different header text.
const HEADER_ALIASES = {
  brand: ['品牌', '厂商', '制造商', 'brand', 'manufacturer', 'maker'],
  product: ['产品', '车型', '型号系列', 'product', 'series'],
  model: ['型号', '版本', 'model', 'version', 'variant'],
  modelEn: ['型号英', '英文型号', 'modelen', 'englishmodel'],
  sku: ['sku', '编码', '编号', 'code'],
};

function normalizeHeaderKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s（）()【】\[\]:：]/g, '')
    .trim();
}

function buildRowContext(headerCols, rowCells) {
  if (!headerCols.size || !rowCells.size) return null;
  const resolved = { brand: null, product: null, model: null, modelEn: null, sku: null };
  for (const [col, headerName] of headerCols) {
    const norm = normalizeHeaderKey(headerName);
    for (const key of Object.keys(HEADER_ALIASES)) {
      if (resolved[key]) continue;
      if (HEADER_ALIASES[key].some((alias) => normalizeHeaderKey(alias) === norm)) {
        const v = rowCells.get(col);
        if (v) resolved[key] = v;
      }
    }
  }

  const summaryParts = [resolved.brand, resolved.product, resolved.model].filter(Boolean);
  const summary = summaryParts.join(' ').trim();

  const skus = new Set();
  const push = (v) => { if (v) skus.add(String(v).trim()); };
  push(resolved.brand);
  push(resolved.product);
  push(resolved.model);
  push(resolved.modelEn);
  push(resolved.sku);
  if (resolved.product && resolved.model) push(`${resolved.product} ${resolved.model}`);
  if (resolved.product && resolved.brand) push(`${resolved.brand} ${resolved.product}`);
  if (resolved.brand && resolved.product && resolved.model) {
    push(`${resolved.brand} ${resolved.product} ${resolved.model}`);
  }

  const linkedSkus = [...skus].filter(Boolean);
  if (linkedSkus.length === 0) return null;
  return { summary, linkedSkus };
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

async function captionAndJudge(jpegBuffer, meta = {}) {
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
    }, { tenantId: meta.tenantId, callSite: 'kb.image-extract.caption', productLine: meta.productLineId });
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
