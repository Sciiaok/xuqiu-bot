#!/usr/bin/env node
/**
 * PM2 Cron Script for Orchestrator Session Recovery
 *
 * Scans every 60 seconds for orchestrator sessions stuck in 'running' state
 * (server crash, timeout, etc.) and resumes them from their checkpoint.
 *
 * Usage with PM2:
 *   pm2 start scripts/cron-recover-orchestrator.js --name "orchestrator-recovery"
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env.local') });

const INTERVAL = 60 * 1000; // 60 seconds
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3002';
const CRON_SECRET = process.env.CRON_SECRET;

async function recoverSessions() {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (CRON_SECRET) headers['Authorization'] = `Bearer ${CRON_SECRET}`;

    const res = await fetch(`${API_BASE_URL}/api/cron/recover-orchestrator`, { method: 'GET', headers });
    const result = await res.json();

    if (result.recovered > 0) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] Recovered ${result.recovered} session(s):`,
        result.results.map(r => `${r.session_id.slice(0, 8)}→${r.status}`).join(', '));
    }
  } catch (err) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] Recovery check failed:`, err.message);
  }
}

recoverSessions();
setInterval(recoverSessions, INTERVAL);

console.log(`Orchestrator recovery cron started. Interval: ${INTERVAL / 1000}s`);
console.log(`API Base URL: ${API_BASE_URL}`);
