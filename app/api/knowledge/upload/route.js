import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { getSupabaseAdmin } from '../../../../lib/supabase-admin.js';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';
import { processDocument } from '../../../../src/kb-upload.service.js';
import { markFirstKbUpload } from '../../../../lib/repositories/onboarding.repository.js';

export const maxDuration = 120;

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
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const agentId = formData.get('agent_id');
    const layer = formData.get('layer');

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

    // Validate file type
    const fileType = ALLOWED_TYPES[file.type];
    if (!fileType) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Supported: PDF, Excel, CSV, Word, Markdown, TXT` },
        { status: 400 }
      );
    }

    // Get agent info — also enforces tenant ownership.
    if (!(await findAgentInTenant({ tenantId: ctx.tenantId, agentId }))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, product_line')
      .eq('id', agentId)
      .single();

    if (agentError || !agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Upload file to Supabase Storage (optional — skip if bucket not available)
    const buffer = Buffer.from(await file.arrayBuffer());
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${agentId}/${layer}/${Date.now()}_${safeName}`;

    // kb-assets bucket is private with no anon-write policy; use service-role
    // client (tenant ownership already verified above via findAgentInTenant).
    let storageOk = false;
    try {
      const { error: uploadError } = await getSupabaseAdmin().storage
        .from('kb-assets')
        .upload(storagePath, buffer, { contentType: file.type });
      if (!uploadError) storageOk = true;
      else console.warn(`[knowledge/upload] Storage upload skipped: ${uploadError.message}`);
    } catch (storageErr) {
      console.warn(`[knowledge/upload] Storage upload skipped: ${storageErr.message}`);
    }

    // Create document record
    const description = formData.get('description') || null;
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
        status: 'pending',
      })
      .select('id')
      .single();

    if (docError) {
      return NextResponse.json(
        { error: `DB insert failed: ${docError.message}` },
        { status: 500 }
      );
    }
    await markFirstKbUpload(ctx.tenantId);

    // Extract text content from file
    // For now, handle text-based formats directly; PDF/Excel need additional parsing
    let textContent;
    if (fileType === 'txt' || fileType === 'markdown' || fileType === 'csv') {
      textContent = buffer.toString('utf-8');
    } else if (fileType === 'xlsx_text') {
      // Use xlsx library to extract text
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

    // Process document (extract knowledge, translate, embed) + extract images
    // in parallel — images are independent of text extraction.
    let result, imageResult;
    try {
      const docCtx = { tenantId: ctx.tenantId, agentId, productLineId: agent.product_line };
      const { extractAndStoreImages } = await import('../../../../src/kb-image-extractor.service.js');
      [result, imageResult] = await Promise.all([
        processDocument(docCtx, doc.id, textContent, layer, { filename: file.name, fileType }),
        extractAndStoreImages(docCtx, buffer, doc.id, file.type).catch(e => ({
          extracted: 0, skipped: 0, errors: [`extraction failed: ${e.message}`],
        })),
      ]);
    } catch (err) {
      console.error(`[knowledge/upload] Failed to process ${file.name}:`, err.message);
      return NextResponse.json({
        document_id: doc.id,
        status: 'error',
        error: err.message,
      });
    }

    return NextResponse.json({
      document_id: doc.id,
      status: 'ready',
      filename: file.name,
      layer,
      ...result,
      images: imageResult,
    });
  } catch (error) {
    console.error('[knowledge/upload] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
