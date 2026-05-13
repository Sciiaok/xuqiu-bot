#!/usr/bin/env node
/**
 * One-off backfill: run extractAndStoreImages over existing xlsx kb_documents
 * that pre-date xlsx image-extraction support (2026-05-13).
 *
 * Re-running is safe-ish (inserts duplicate rows on second run — that's a
 * pre-existing reparse issue, not introduced here). Run once.
 *
 *   node scripts/backfill-xlsx-images.mjs           # all xlsx docs across tenants
 *   node scripts/backfill-xlsx-images.mjs --doc-id <uuid>
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env.local. Try the script's parent first (normal layout); if running
// inside a git worktree the env file lives in the main checkout, so fall back
// to /Users/a123/Desktop/LeadEngine/.env.local.
const localEnv = path.resolve(__dirname, '..', '.env.local');
dotenv.config({ path: localEnv });
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  dotenv.config({ path: '/Users/a123/Desktop/LeadEngine/.env.local' });
}
import { createClient } from '@supabase/supabase-js';
import { extractAndStoreImages } from '../src/kb-image-extractor.service.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const args = process.argv.slice(2);
const docIdArgIdx = args.indexOf('--doc-id');
const onlyDocId = docIdArgIdx >= 0 ? args[docIdArgIdx + 1] : null;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://exevqpqpsvojfowpzize.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function main() {
  let query = supabase
    .from('kb_documents')
    .select('id, tenant_id, agent_id, product_line_id, filename, storage_path')
    .ilike('filename', '%.xlsx')
    .eq('status', 'ready')
    .not('storage_path', 'is', null);
  if (onlyDocId) query = query.eq('id', onlyDocId);

  const { data: docs, error } = await query;
  if (error) {
    console.error('query failed:', error.message);
    process.exit(1);
  }
  console.log(`Found ${docs.length} xlsx document(s) to backfill.\n`);

  let totalExtracted = 0;
  let totalFailed = 0;
  for (const doc of docs) {
    console.log(`▶ ${doc.id} · ${doc.filename}`);
    const t0 = Date.now();
    try {
      console.log(`   downloading ${doc.storage_path}...`);
      const { data: file, error: dlErr } = await supabase.storage
        .from('kb-assets').download(doc.storage_path);
      if (dlErr || !file) {
        console.error(`   download failed: ${dlErr?.message || 'no file'}`);
        totalFailed++;
        continue;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      console.log(`   downloaded ${buffer.length} bytes in ${Date.now() - t0}ms, extracting...`);
      const result = await extractAndStoreImages(
        { tenantId: doc.tenant_id, agentId: doc.agent_id, productLineId: doc.product_line_id },
        buffer,
        doc.id,
        XLSX_MIME,
        {
          onProgress: (ev) => {
            if (ev.stage === 'images') {
              process.stdout.write(`\r   images: ${ev.done || 0}/${ev.total || 0}${ev.warning ? ' ⚠ ' + ev.warning : ''}     `);
            }
          },
        },
      );
      process.stdout.write('\n');
      console.log(`   extracted=${result.extracted}, skipped=${result.skipped}, total=${result.total}, errors=${result.errors.length}, elapsed=${Date.now() - t0}ms`);
      if (result.errors.length) console.log(`   errors:`, result.errors.slice(0, 5));
      totalExtracted += result.extracted;
    } catch (e) {
      console.error(`   crashed after ${Date.now() - t0}ms: ${e.message}`);
      console.error(e.stack);
      totalFailed++;
    }
  }
  console.log(`\nDone. extracted=${totalExtracted}, doc_failures=${totalFailed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
