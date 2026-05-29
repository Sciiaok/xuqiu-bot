import { NextResponse } from 'next/server';
import supabase from '../../../../../lib/supabase.js';
import { getSupabaseAdmin } from '../../../../../lib/supabase-admin.js';
import { getTenantContext, findProductLineInTenant } from '../../../../../lib/tenant-context.js';
import { getDocumentById } from '../../../../../lib/repositories/knowledge-base.repository.js';
import { processDocument } from '../../../../../src/kb-upload.service.js';
import { parseBufferToContent, inferFileTypeFromName } from '../../../../../src/kb-file-parsers.js';
import { emit as emitProgress } from '../../../../../lib/kb-upload-bus.js';

/**
 * POST /api/knowledge/documents/reparse?doc_id=xxx
 *
 * 用原始上传文件（kb-assets bucket 的 storage_path）重跑解析管道：
 *   1. 校验权限（doc 所属产品线必须属于当前 tenant）
 *   2. 从 storage 重下原文件，按 filename 扩展名推 fileType
 *   3. fire-and-forget runBackground → processDocument(..., { isReparse: true })
 *
 * **容灾设计：cleanup 由 processDocument 内部触发，且只在 LLM 抽取全部
 * 成功后才执行**。如果中途 LLM API 抖（如 OpenRouter 500、Anthropic 限流），
 * 旧数据完整保留，doc 状态被回滚成 reparse 之前的样子 + error_message
 * 标注失败原因，Medici 继续能查询旧数据，用户重试 reparse 即可。
 *
 * 前端复用 subscribeUploadProgress(docId) 监听进度。
 */
export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    let docId = searchParams.get('doc_id');
    if (!docId) {
      const body = await request.json().catch(() => ({}));
      docId = body?.doc_id;
    }
    if (!docId) {
      return NextResponse.json({ error: 'doc_id is required' }, { status: 400 });
    }

    const doc = await getDocumentById(docId);
    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

    const line = await findProductLineInTenant({ tenantId: ctx.tenantId, productLineId: doc.product_line_id });
    if (!line) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

    if (!doc.storage_path) {
      return NextResponse.json(
        { error: '原文件未保存到 Storage（早期脚本导入或上传时 Storage 不可用），无法重新解析。请重新上传文件。' },
        { status: 400 }
      );
    }

    // 处理中的文档拒绝重复重解析 —— 避免 fire-and-forget 重叠写库。
    if (doc.status === 'processing') {
      return NextResponse.json({
        document_id: doc.id,
        status: 'processing',
        message: '该文档已在解析中，可订阅进度流。',
      });
    }

    // ── 拉原文件 ───────────────────────────────────────────────
    const admin = getSupabaseAdmin();
    const { data: fileObj, error: dlErr } = await admin.storage
      .from('kb-assets').download(doc.storage_path);
    if (dlErr || !fileObj) {
      return NextResponse.json(
        { error: `重下载原文件失败：${dlErr?.message || 'unknown'}` },
        { status: 500 }
      );
    }
    const buffer = Buffer.from(await fileObj.arrayBuffer());

    // ── 状态预置为 'processing'（让 UI 立即反映） ─────────────────
    // 注意：**不在这里清子表数据**。cleanup 由 processDocument 在 LLM 抽取
    // 完全成功后才触发，避免中途失败导致旧数据丢失。
    const { error: updErr } = await supabase
      .from('kb_documents')
      .update({
        status: 'processing',
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', docId);
    if (updErr) {
      return NextResponse.json(
        { error: `重置状态失败：${updErr.message}` },
        { status: 500 }
      );
    }

    const fileType = inferFileTypeFromName(doc.filename);
    const filename = doc.filename;

    const docCtx = {
      tenantId: ctx.tenantId,
      productLineId: line.id,
    };

    // ── Fire-and-forget。和 /api/knowledge/upload 的 runBackground 同款 SSE 事件 ──
    runReparseBackground({ docCtx, docId, buffer, fileType, filename, layer: doc.layer })
      .catch(err => console.error('[knowledge/documents/reparse] runBackground crashed:', err));

    return NextResponse.json({
      document_id: docId,
      status: 'processing',
      filename: doc.filename,
      layer: doc.layer,
    });
  } catch (error) {
    console.error('[knowledge/documents/reparse] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function runReparseBackground({ docCtx, docId, buffer, fileType, filename, layer }) {
  emitProgress(docId, 'progress', { stage: 'parsing' });
  try {
    const parsedContent = await parseBufferToContent(buffer, fileType);

    // 图片抽取也重跑 —— 失败不阻塞主流程
    const { extractAndStoreImages } = await import('../../../../../src/kb-image-extractor.service.js');
    const onProgress = (data) => emitProgress(docId, 'progress', data);

    const [result, imageResult] = await Promise.all([
      processDocument(docCtx, docId, parsedContent, layer, {
        filename, fileType, onProgress,
        isReparse: true,   // 关键：LLM 抽取失败时保留旧数据，详见 processDocument 的容灾说明
      }),
      extractAndStoreImages(docCtx, buffer, docId, mimeFromFileType(fileType), { onProgress })
        .then(r => {
          onProgress({
            stage: 'images',
            total: r?.total || 0,
            done: r?.extracted || 0,
            extracted: r?.extracted || 0,
            errors: r?.errors?.length || 0,
          });
          return r;
        })
        .catch(e => ({ extracted: 0, skipped: 0, total: 0, errors: [`extraction failed: ${e.message}`] })),
    ]);

    let linkResult = { linked: 0 };
    if ((imageResult?.extracted || 0) > 0) {
      onProgress({ stage: 'linking', total: imageResult.extracted, done: 0 });
      const { linkAssetsToProducts } = await import('../../../../../src/kb-asset-linker.service.js');
      linkResult = await linkAssetsToProducts({
        tenantId: docCtx.tenantId,
        productLineId: docCtx.productLineId,
        docId,
      }).catch((e) => ({ linked: 0, errors: [`linker failed: ${e.message}`] }));
    }

    emitProgress(docId, 'done', {
      knowledge_points: result.knowledge_points || 0,
      conflicts: result.conflicts || [],
      images: imageResult,
      linked_assets: linkResult.linked || 0,
      status: result.status,
      partial_reason: result.partial_reason || null,
    });
  } catch (err) {
    emitProgress(docId, 'error', { message: err.message });
  }
}

function mimeFromFileType(fileType) {
  switch (fileType) {
    case 'pdf_text':  return 'application/pdf';
    case 'xlsx_text': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'docx':      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'csv':       return 'text/csv';
    case 'markdown':  return 'text/markdown';
    default:          return 'text/plain';
  }
}
