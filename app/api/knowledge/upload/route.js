import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { getSupabaseAdmin } from '../../../../lib/supabase-admin.js';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';
import { processDocument } from '../../../../src/kb-upload.service.js';
import { markFirstKbUpload } from '../../../../lib/repositories/onboarding.repository.js';
import { emit as emitProgress } from '../../../../lib/kb-upload-bus.js';

// Async pipeline: this handler returns in <2s with a doc_id. The actual LLM
// extraction runs as a fire-and-forget background promise and emits progress
// events to the in-memory bus, which /api/knowledge/upload/stream forwards to
// the browser via SSE. PM2 fork-mode keeps the process alive until the bg
// promise finishes; on process restart the cron-recover script picks up
// orphaned `processing` docs.

const ALLOWED_TYPES = {
  'application/pdf': 'pdf_text',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx_text',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/markdown': 'markdown',
  'text/plain': 'txt',
};

const VALID_LAYERS = ['company', 'product', 'logistics', 'sales'];
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const formData = await request.formData();
    const file = formData.get('file');
    const agentId = formData.get('agent_id');
    const layer = formData.get('layer');
    const description = formData.get('description') || null;

    if (!file || !agentId || !layer) {
      return NextResponse.json(
        { error: 'file, agent_id, and layer are required' },
        { status: 400 }
      );
    }
    if (!VALID_LAYERS.includes(layer)) {
      return NextResponse.json(
        { error: `Invalid layer. Must be one of: ${VALID_LAYERS.join(', ')}` },
        { status: 400 }
      );
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: `文件超过上限 50 MB（当前 ${(file.size / 1024 / 1024).toFixed(1)} MB），请压缩或拆分后再上传。` },
        { status: 413 }
      );
    }
    const fileType = ALLOWED_TYPES[file.type];
    if (!fileType) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Supported: PDF, Excel, CSV, Word, Markdown, TXT` },
        { status: 400 }
      );
    }

    if (!(await findAgentInTenant({ tenantId: ctx.tenantId, agentId }))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    const { data: agent, error: agentError } = await supabase
      .from('agents').select('id, product_line').eq('id', agentId).single();
    if (agentError || !agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const contentSha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    // Idempotency: same agent + same content + still in flight or already
    // succeeded → return the existing row instead of starting a duplicate.
    // status='error' is intentionally NOT deduped — re-upload is a retry.
    const { data: existing } = await supabase
      .from('kb_documents')
      .select('id, status, layer, filename, knowledge_points_count')
      .eq('agent_id', agentId)
      .eq('content_sha256', contentSha256)
      .in('status', ['processing', 'ready'])
      .maybeSingle();
    if (existing) {
      return NextResponse.json({
        document_id: existing.id,
        status: existing.status,
        dedup: true,
        filename: existing.filename,
        layer: existing.layer,
        knowledge_points: existing.knowledge_points_count || 0,
      });
    }

    // Storage upload (best-effort, private bucket via service role)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${agentId}/${layer}/${Date.now()}_${safeName}`;
    let storageOk = false;
    try {
      const { error: uploadError } = await getSupabaseAdmin().storage
        .from('kb-assets').upload(storagePath, buffer, { contentType: file.type });
      if (!uploadError) storageOk = true;
      else console.warn(`[knowledge/upload] Storage upload skipped: ${uploadError.message}`);
    } catch (storageErr) {
      console.warn(`[knowledge/upload] Storage upload skipped: ${storageErr.message}`);
    }

    const { data: doc, error: docError } = await supabase
      .from('kb_documents')
      .insert({
        tenant_id: ctx.tenantId,
        agent_id: agentId,
        product_line_id: agent.product_line,
        filename: file.name,
        storage_path: storageOk ? storagePath : null,
        file_size: file.size,
        layer,
        source_type: 'file',
        description,
        status: 'processing',
        content_sha256: contentSha256,
      })
      .select('id')
      .single();

    if (docError) {
      // 23505 = unique_violation — race with a concurrent upload of same content.
      // Re-query and return the winner so the client can attach to its stream.
      if (docError.code === '23505') {
        const { data: winner } = await supabase
          .from('kb_documents')
          .select('id, status, layer, filename, knowledge_points_count')
          .eq('agent_id', agentId)
          .eq('content_sha256', contentSha256)
          .maybeSingle();
        if (winner) {
          return NextResponse.json({
            document_id: winner.id,
            status: winner.status,
            dedup: true,
            filename: winner.filename,
            layer: winner.layer,
            knowledge_points: winner.knowledge_points_count || 0,
          });
        }
      }
      return NextResponse.json(
        { error: `DB insert failed: ${docError.message}` },
        { status: 500 }
      );
    }

    await markFirstKbUpload(ctx.tenantId);

    // Fire-and-forget. The catch is purely a safety net — runBackground
    // already emits 'error' to the bus and updates doc.status on its own.
    runBackground({
      tenantCtx: ctx,
      doc,
      agent,
      filename: file.name,
      mimeType: file.type,
      fileType,
      buffer,
      layer,
    }).catch(err => {
      console.error('[knowledge/upload] runBackground crashed:', err);
    });

    return NextResponse.json({
      document_id: doc.id,
      status: 'processing',
      dedup: false,
      filename: file.name,
      layer,
    });
  } catch (error) {
    console.error('[knowledge/upload] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function runBackground({ tenantCtx, doc, agent, filename, mimeType, fileType, buffer, layer }) {
  const docId = doc.id;
  emitProgress(docId, 'progress', { stage: 'parsing' });

  try {
    let textContent;
    if (fileType === 'txt' || fileType === 'markdown' || fileType === 'csv') {
      textContent = buffer.toString('utf-8');
    } else if (fileType === 'xlsx_text') {
      const { extractExcelText } = await import('../../../../src/kb-file-parsers.js');
      textContent = await extractExcelText(buffer);
    } else if (fileType === 'pdf_text') {
      const { extractPdfText } = await import('../../../../src/kb-file-parsers.js');
      textContent = await extractPdfText(buffer);
    } else if (fileType === 'docx') {
      const { extractDocxText } = await import('../../../../src/kb-file-parsers.js');
      textContent = await extractDocxText(buffer);
    } else {
      textContent = buffer.toString('utf-8');
    }

    const docCtx = {
      tenantId: tenantCtx.tenantId,
      agentId: agent.id,
      productLineId: agent.product_line,
    };
    const onProgress = (data) => emitProgress(docId, 'progress', data);

    const { extractAndStoreImages } = await import('../../../../src/kb-image-extractor.service.js');
    const [result, imageResult] = await Promise.all([
      processDocument(docCtx, docId, textContent, layer, { filename, fileType, onProgress }),
      extractAndStoreImages(docCtx, buffer, docId, mimeType)
        .then(r => {
          onProgress({ stage: 'images', extracted: r?.extracted || 0 });
          return r;
        })
        .catch(e => ({ extracted: 0, skipped: 0, errors: [`extraction failed: ${e.message}`] })),
    ]);

    emitProgress(docId, 'done', {
      knowledge_points: result.knowledge_points || 0,
      conflicts: result.conflicts || [],
      images: imageResult,
    });
  } catch (err) {
    // processDocument's own catch already cleaned up partial rows + set
    // status='error'. Just surface the error to any SSE subscriber.
    emitProgress(docId, 'error', { message: err.message });
  }
}
