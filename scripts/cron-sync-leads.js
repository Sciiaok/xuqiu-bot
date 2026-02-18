#!/usr/bin/env node
/**
 * PM2 Cron Script for Lead Sync
 * Runs every 30 seconds to sync approved leads to external system
 *
 * Usage with PM2:
 *   pm2 start scripts/cron-sync-leads.js --name "lead-sync-cron"
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local (same as Next.js)
dotenv.config({ path: join(__dirname, '..', '.env.local') });

const SYNC_INTERVAL = 30 * 1000; // 30 seconds
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3002';
const CRON_SECRET = process.env.CRON_SECRET;

async function syncLeads() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting lead sync...`);

  try {
    const response = await fetch(`${API_BASE_URL}/api/cron/sync-leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CRON_SECRET}`,
      },
    });

    const result = await response.json();

    if (result.success) {
      console.log(`[${timestamp}] Sync completed:`, {
        processed: result.processed,
        created: result.results?.created || 0,
        skipped: result.results?.skipped || 0,
        failed: result.results?.failed || 0,
      });
    } else {
      console.error(`[${timestamp}] Sync failed:`, result.error);
    }
  } catch (error) {
    console.error(`[${timestamp}] Sync error:`, error.message);
  }
}

// Run immediately on start
syncLeads();

// Then run every 30 seconds
setInterval(syncLeads, SYNC_INTERVAL);

console.log(`Lead sync cron started. Interval: ${SYNC_INTERVAL / 1000}s`);
console.log(`API Base URL: ${API_BASE_URL}`);
