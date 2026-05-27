import supabase from '../../../../lib/supabase.js';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { getSession } from '../../../../lib/repositories/ogilvy.repository.js';
import { parseBufferToContent, inferFileTypeFromName } from '../../../../src/kb-file-parsers.js';

/**
 * POST /api/ogilvy/upload
 *
 * Composer paperclip target. Handles two kinds of attachments:
 *
 *   - **image** (JPG/PNG/GIF/WebP) — uploaded to the chat-uploads bucket;
 *     response includes a public URL. The agent sees it as an `image_url`
 *     content block via attachmentToImageBlock.
 *
 *   - **document** (PDF / DOCX / Markdown / TXT / CSV) — parsed server-side
 *     via the same kb-file-parsers used by the KB pipeline. Extracted plain
 *     text is returned inline; the binary is NOT persisted to storage. The
 *     agent sees the text prepended to the user message via
 *     getMessagesForLLM's doc-attachment handling.
 *
 * Hard cap 50MB regardless of type. PDF/DOCX rarely come close; the cap
 * is there to bound memory + extraction time per upload.
 */
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// MIME-based whitelist for docs. Some browsers send odd content-types for
// .md and .markdown (text/x-markdown, application/octet-stream when no MIME
// is registered) so we also accept by extension fallback below.
const ALLOWED_DOC_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'text/csv',
  'application/csv',
]);
const ALLOWED_DOC_EXTS = new Set(['pdf', 'docx', 'md', 'markdown', 'txt', 'csv']);
// XLSX recognized but rejected with a specific message; the KB chunked path
// is the right home for spreadsheets, not the chat composer.
const XLSX_EXTS = new Set(['xlsx', 'xls']);
const MAX_SIZE_BYTES = 50 * 1024 * 1024;

function isImageFile(file) {
  return ALLOWED_IMAGE_TYPES.has(file.type);
}
function isDocFile(file) {
  if (ALLOWED_DOC_TYPES.has(file.type)) return true;
  // Extension fallback — handles browsers/OSes that send blank or wrong MIME.
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ALLOWED_DOC_EXTS.has(ext);
}

export async function POST(request) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const sessionId = formData.get('session_id');

    if (!file || !(file instanceof File)) {
      return Response.json({ error: 'file is required' }, { status: 400 });
    }
    if (file.size > MAX_SIZE_BYTES) {
      return Response.json({ error: '文件超过 50MB 上限,请压缩后再传' }, { status: 400 });
    }

    const isImage = isImageFile(file);
    const isDoc = !isImage && isDocFile(file);
    // Friendly XLSX rejection — its chunked extraction is meant for KB, not chat.
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!isImage && !isDoc && XLSX_EXTS.has(ext)) {
      return Response.json({
        error: 'XLSX/XLS 暂不支持,请导出为 CSV 再上传',
      }, { status: 400 });
    }
    if (!isImage && !isDoc) {
      return Response.json({
        error: `不支持的文件类型:${file.type || file.name}。支持图片(JPG/PNG/GIF/WebP)或文档(PDF/Word/Markdown/TXT/CSV)`,
      }, { status: 400 });
    }

    // 给了 session_id 就要验它归当前 tenant —— 否则可上传到别 tenant 的 session 路径。
    if (sessionId) {
      const session = await getSession(sessionId);
      if (!session || session.tenant_id !== ctx.tenantId) {
        return Response.json({ error: 'Session not found' }, { status: 404 });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    if (isDoc) {
      // 文档:服务端抽文本,不入 storage。kb-file-parsers 已经覆盖 pdf-parse /
      // mammoth(docx)/ utf-8(md/txt/csv)。XLSX 走 chunked,这一版不开放。
      const fileType = inferFileTypeFromName(file.name);
      if (fileType === 'xlsx_text') {
        return Response.json({
          error: 'XLSX 暂不支持,请导出为 CSV 再上传',
        }, { status: 400 });
      }
      let text;
      try {
        const parsed = await parseBufferToContent(buffer, fileType);
        text = typeof parsed === 'string' ? parsed : '';
      } catch (err) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          event: 'ogilvy.parse_document.failed',
          component: 'ogilvy/upload',
          tenant_id: ctx.tenantId,
          session_id: sessionId || null,
          filename: file.name,
          file_type: fileType,
          size: file.size,
          error: err.message,
        }));
        return Response.json({ error: `解析失败:${err.message}` }, { status: 400 });
      }
      const charCount = text.length;
      if (charCount === 0) {
        return Response.json({ error: '从文件中提取到的文本为空' }, { status: 400 });
      }
      return Response.json({
        kind: 'doc',
        text,
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
        size: file.size,
        char_count: charCount,
      });
    }

    // 图片:沿用旧路径,上传 storage 拿 public URL。沿用上面 isDoc/XLSX 校验时
    // 算好的 ext;空 extension(裸文件名,极少)兜底成 png。
    const imgExt = ext || 'png';
    const prefix = sessionId || `anon-${ctx.user.id}`;
    const storagePath = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${imgExt}`;

    let { error: uploadError } = await supabase.storage
      .from('chat-uploads')
      .upload(storagePath, buffer, { contentType: file.type, upsert: false });

    // Auto-create the bucket on first use — matches the legacy upload route.
    if (uploadError && (uploadError.message?.includes('not found') || uploadError.statusCode === 404)) {
      await supabase.storage.createBucket('chat-uploads', { public: true }).catch(() => {});
      ({ error: uploadError } = await supabase.storage
        .from('chat-uploads')
        .upload(storagePath, buffer, { contentType: file.type, upsert: false }));
    }

    if (uploadError) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'ogilvy.upload_image.failed',
        component: 'ogilvy/upload',
        tenant_id: ctx.tenantId,
        session_id: sessionId || null,
        bucket: 'chat-uploads',
        storage_path: storagePath,
        size: file.size,
        content_type: file.type,
        storage_status: uploadError.statusCode || null,
        error: uploadError.message,
      }));
      return Response.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
    }

    const { data: urlData } = supabase.storage
      .from('chat-uploads')
      .getPublicUrl(storagePath);

    return Response.json({
      kind: 'image',
      url: urlData.publicUrl,
      storage_path: storagePath,
      filename: file.name,
      content_type: file.type,
      size: file.size,
    });
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.upload.unhandled_error',
      component: 'ogilvy/upload',
      tenant_id: ctx.tenantId,
      error: err.message || 'Upload failed',
      error_name: err.name || null,
    }));
    return Response.json({ error: err.message || 'Upload failed' }, { status: 500 });
  }
}
