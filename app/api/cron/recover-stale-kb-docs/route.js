import { NextResponse } from 'next/server';
import supabase from '../../../../../lib/supabase.js';
import { cleanupPartialDoc } from '../../../../../src/kb-upload.service.js';
import { config } from '../../../../../src/config.js';

/**
 * GET /api/cron/recover-stale-kb-docs
 *
 * Sweeps `kb_documents` rows stuck in status='processing' for >15 min and
 * marks them 'error' after deleting any partial rows they wrote. This catches
 * uploads orphaned by PM2 restarts / OOM kills — without it, the doc would
 * stay 'processing' forever and the UI would never resolve.
 */
const STALE_AFTER_MIN = 15;

export async function GET(request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = config.secrets.cron;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - STALE_AFTER_MIN * 60_000).toISOString();
  const { data: stale, error } = await supabase
    .from('kb_documents')
    .select('id, filename, created_at')
    .eq('status', 'processing')
    .lt('created_at', cutoff);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!stale?.length) {
    return NextResponse.json({ recovered: 0 });
  }

  const recovered = [];
  for (const doc of stale) {
    try {
      await cleanupPartialDoc(doc.id);
      const { error: updErr } = await supabase
        .from('kb_documents')
        .update({
          status: 'error',
          error_message: `processing orphaned (>${STALE_AFTER_MIN}min, likely PM2 restart)`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', doc.id);
      if (updErr) throw updErr;
      recovered.push({ id: doc.id, filename: doc.filename });
    } catch (e) {
      console.error('[recover-stale-kb-docs]', doc.id, e.message);
    }
  }
  return NextResponse.json({ recovered: recovered.length, items: recovered });
}
