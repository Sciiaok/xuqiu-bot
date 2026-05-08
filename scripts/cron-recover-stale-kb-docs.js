#!/usr/bin/env node
/**
 * PM2 cron: recovers KB upload docs stuck in `status='processing'` after a
 * process restart by hitting /api/cron/recover-stale-kb-docs every 60s.
 *
 * Without this, an OOM-killed or redeployed Next.js process leaves uploads
 * showing "处理中" in the UI forever. The route marks anything older than
 * 15 min as `error` and cleans up any partial knowledge points.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env.local') });

const PROCESS_INTERVAL = 60 * 1000; // 60 seconds
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3002';
const CRON_SECRET = process.env.CRON_SECRET;

async function recover() {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (CRON_SECRET) headers['Authorization'] = `Bearer ${CRON_SECRET}`;

    const res = await fetch(`${API_BASE_URL}/api/cron/recover-stale-kb-docs`, {
      method: 'GET',
      headers,
    });
    const result = await res.json();

    if (result.recovered > 0) {
      console.log(`[${new Date().toISOString()}] Recovered ${result.recovered} stale KB doc(s):`,
        result.items?.map(i => i.filename).join(', '));
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] kb-recover error:`, error.message);
  }
}

recover();
setInterval(recover, PROCESS_INTERVAL);

console.log(`KB stale-doc recovery cron started. Interval: ${PROCESS_INTERVAL / 1000}s`);
console.log(`API Base URL: ${API_BASE_URL}`);
