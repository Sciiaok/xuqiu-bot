#!/usr/bin/env node
/**
 * PM2 Cron Script for AI Report Generation
 *
 * Runs once daily at 08:00 CST (00:00 UTC).
 * Checks every minute if it's time, then calls the generate-reports API.
 *
 * Usage with PM2:
 *   pm2 start scripts/cron-generate-reports.js --name "report-cron"
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env.local') });

const CHECK_INTERVAL = 60 * 1000; // Check every 60 seconds
const TARGET_HOUR_CST = 8; // 08:00 China time
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3002';
const CRON_SECRET = process.env.CRON_SECRET;

let lastRunDate = null; // Track which date we last ran for (prevent double runs)

function getChinaTime() {
  const now = new Date();
  const chinaMs = now.getTime() + 8 * 60 * 60 * 1000;
  return new Date(chinaMs);
}

async function checkAndGenerate() {
  const china = getChinaTime();
  const chinaHour = china.getUTCHours();
  const chinaDate = china.toISOString().split('T')[0];

  // Only run at target hour, and only once per day
  if (chinaHour !== TARGET_HOUR_CST) return;
  if (lastRunDate === chinaDate) return;

  lastRunDate = chinaDate;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Triggering report generation (China time: ${chinaDate} ${TARGET_HOUR_CST}:00)...`);

  try {
    const response = await fetch(`${API_BASE_URL}/api/cron/generate-reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CRON_SECRET}`,
      },
    });

    const result = await response.json();

    if (result.success) {
      const r = result.results;
      console.log(`[${timestamp}] Report generation completed:`, {
        generated: r.generated?.length || 0,
        skipped: r.skipped?.length || 0,
        failed: r.failed?.length || 0,
        retried: r.retried?.length || 0,
      });
    } else {
      console.error(`[${timestamp}] Report generation failed:`, result.error);
    }
  } catch (error) {
    console.error(`[${timestamp}] Report generation error:`, error.message);
    // Reset lastRunDate so we retry next minute
    lastRunDate = null;
  }
}

// Check immediately on start
checkAndGenerate();

// Then check every minute
setInterval(checkAndGenerate, CHECK_INTERVAL);

console.log(`Report generation cron started. Target: ${TARGET_HOUR_CST}:00 CST daily`);
console.log(`API Base URL: ${API_BASE_URL}`);
