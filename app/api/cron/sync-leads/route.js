// app/api/cron/sync-leads/route.js
import { NextResponse } from 'next/server';
import { getLeadsNeedingSync } from '@/lib/repositories/lead.repository';
import {
  createSyncLog,
  updateSyncLog,
  hasSuccessfulSync,
  getRetryableFailedLog,
  incrementRetryCount,
} from '@/lib/repositories/sync-log.repository';
import { syncLeadsToExternal, processSyncResults, expandLeadForSync } from '@/lib/services/external-sync';
import { config } from '@/src/config';

export async function POST(request) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get('authorization');
    const cronSecret = config.secrets.cron;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get all approved leads from last 24h
    const allLeads = await getLeadsNeedingSync();

    // Filter to those needing sync
    const leadsToSync = [];
    const logsToUpdate = [];

    for (const lead of allLeads) {
      const hasSync = await hasSuccessfulSync(lead.id);
      if (hasSync) continue;

      // Check for retryable failed log
      const failedLog = await getRetryableFailedLog(lead.id);
      if (failedLog) {
        const updatedLog = await incrementRetryCount(failedLog.id);
        logsToUpdate.push({ lead, log: updatedLog, isRetry: true });
        leadsToSync.push(lead);
      } else if (!failedLog) {
        // Create new sync log
        const newLog = await createSyncLog({
          leadId: lead.id,
          status: 'syncing',
          requestPayload: expandLeadForSync(lead),  // Now returns array
        });
        logsToUpdate.push({ lead, log: newLog, isRetry: false });
        leadsToSync.push(lead);
      }
    }

    if (leadsToSync.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        results: { created: 0, skipped: 0, failed: 0 },
        message: 'No leads to sync',
      });
    }

    // Batch sync (max 100 per batch)
    const batchSize = 100;
    let totalCreated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (let i = 0; i < leadsToSync.length; i += batchSize) {
      const batch = leadsToSync.slice(i, i + batchSize);
      const batchLogs = logsToUpdate.slice(i, i + batchSize);

      try {
        const apiKey = config.secrets.revoScmApiKey;
        const apiResponse = await syncLeadsToExternal(batch, apiKey);
        const results = processSyncResults(batch, apiResponse);

        // Update logs
        for (const result of results) {
          const logEntry = batchLogs.find(bl => bl.lead.id === result.leadId);
          if (logEntry) {
            await updateSyncLog(logEntry.log.id, {
              status: result.status,
              externalId: result.externalIds,  // Now an array
              externalNo: result.externalNos,  // Now an array
              responsePayload: apiResponse,
              errorMessage: result.error,
              syncedAt: result.status === 'success' ? new Date().toISOString() : null,
            });
          }

          if (result.status === 'success') {
            // Count based on expanded inquiries
            const createdCount = (apiResponse.results || []).filter(
              r => (r.external_id === result.leadId || r.external_id.startsWith(`${result.leadId}_`))
                && r.status === 'created'
            ).length;
            const skippedCount = result.expandedCount - createdCount;
            totalCreated += createdCount;
            totalSkipped += skippedCount;
          } else {
            totalFailed++;
          }
        }
      } catch (batchError) {
        console.error('Batch sync error:', batchError);
        // Mark all in batch as failed
        for (const logEntry of batchLogs) {
          await updateSyncLog(logEntry.log.id, {
            status: 'failed',
            errorMessage: batchError.message,
          });
        }
        totalFailed += batch.length;
      }
    }

    return NextResponse.json({
      success: true,
      processed: leadsToSync.length,
      results: {
        created: totalCreated,
        skipped: totalSkipped,
        failed: totalFailed,
      },
    });
  } catch (error) {
    console.error('Cron sync error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// Also support GET for manual testing
export async function GET(request) {
  return POST(request);
}
