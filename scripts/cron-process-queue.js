#!/usr/bin/env node
/**
 * PM2 Cron Script for Message Queue Processing
 * Runs every 10 seconds as fallback for setTimeout failures
 * Ensures messages are processed even if serverless instances are destroyed
 *
 * Usage with PM2:
 *   pm2 start scripts/cron-process-queue.js --name "queue-cron"
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local (same as Next.js)
dotenv.config({ path: join(__dirname, '..', '.env.local') });

const PROCESS_INTERVAL = 10 * 1000; // 10 seconds
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3002';
const CRON_SECRET = process.env.CRON_SECRET;

async function processQueue() {
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (CRON_SECRET) {
      headers['Authorization'] = `Bearer ${CRON_SECRET}`;
    }

    const response = await fetch(`${API_BASE_URL}/api/cron/process-queue`, {
      method: 'GET',
      headers,
    });

    const result = await response.json();

    // Only log if there was something to process
    if (result.processedConversations > 0 || result.releasedLocks > 0) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] Queue processed:`, {
        releasedLocks: result.releasedLocks || 0,
        processedConversations: result.processedConversations || 0,
        durationMs: result.durationMs,
      });
    }
  } catch (error) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] Queue processing error:`, error.message);
  }
}

// Run immediately on start
processQueue();

// Then run every 10 seconds
setInterval(processQueue, PROCESS_INTERVAL);

console.log(`Queue processor cron started. Interval: ${PROCESS_INTERVAL / 1000}s`);
console.log(`API Base URL: ${API_BASE_URL}`);
