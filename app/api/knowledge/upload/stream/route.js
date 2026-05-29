import { NextResponse } from 'next/server';
import supabase from '../../../../../lib/supabase.js';
import { getTenantContext, findProductLineInTenant } from '../../../../../lib/tenant-context.js';
import { streamSSE } from '../../../../../lib/sse.js';
import { subscribe, hasBus } from '../../../../../lib/kb-upload-bus.js';

/**
 * GET /api/knowledge/upload/stream?doc_id=xxx
 *
 * Streams progress events for an in-flight KB upload via SSE. Events are
 * `progress` (stage updates), `done` (final counts), or `error` (failure).
 *
 * Behavior:
 *   - If doc is already in a terminal state (ready/error), emit a single
 *     synthetic event and close — no need to keep the connection open.
 *   - If still processing but the bus has no buffer (process was restarted),
 *     emit an error indicating the worker was lost; cron-recover will set
 *     status='error' on the next sweep.
 */
export async function GET(request) {
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const docId = searchParams.get('doc_id');
  if (!docId) return NextResponse.json({ error: 'doc_id is required' }, { status: 400 });

  const { data: doc, error } = await supabase
    .from('kb_documents')
    .select('id, product_line_id, status, error_message, knowledge_points_count')
    .eq('id', docId)
    .maybeSingle();
  if (error || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }
  if (!(await findProductLineInTenant({ tenantId: ctx.tenantId, productLineId: doc.product_line_id }))) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  const abortController = new AbortController();

  async function* gen() {
    if (doc.status === 'ready') {
      yield {
        event: 'done',
        data: { knowledge_points: doc.knowledge_points_count || 0, replayed: true },
      };
      return;
    }
    if (doc.status === 'error') {
      yield {
        event: 'error',
        data: { message: doc.error_message || 'unknown error', replayed: true },
      };
      return;
    }
    // status === 'processing' (or legacy 'pending')
    if (!hasBus(docId)) {
      // Worker was lost (process restart). Surface immediately so the UI
      // doesn't hang; cron-recover will mark this doc 'error' shortly.
      yield {
        event: 'error',
        data: { message: '后台处理进程已丢失（可能服务重启），稍后重试', orphan: true },
      };
      return;
    }
    for await (const evt of subscribe(docId, abortController.signal)) {
      yield evt;
    }
  }

  return streamSSE(gen(), {
    heartbeatIntervalMs: 15_000,
    onAbort: () => abortController.abort(),
  });
}
