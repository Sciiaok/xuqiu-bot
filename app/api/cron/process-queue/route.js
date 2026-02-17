import { NextResponse } from 'next/server';
import { processConversationQueue } from '../../../../lib/queue-processor.js';
import {
  getConversationsWithPendingMessages,
  releaseStaleLocks,
} from '../../../../lib/repositories/queue.repository.js';

/**
 * GET /api/cron/process-queue - Cron endpoint for fallback queue processing
 * Handles messages that weren't processed due to setTimeout failures
 */
export async function GET(request) {
  // Optional: Verify cron secret for security
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    // 1. Release stale locks from crashed instances
    const releasedLocks = await releaseStaleLocks();
    if (releasedLocks > 0) {
      console.log(`[Cron] Released ${releasedLocks} stale locks`);
    }

    // 2. Get all conversations with pending messages ready to process
    const conversationIds = await getConversationsWithPendingMessages();

    if (conversationIds.length === 0) {
      return NextResponse.json({
        status: 'ok',
        releasedLocks,
        processedConversations: 0,
        durationMs: Date.now() - startTime,
      });
    }

    console.log(`[Cron] Found ${conversationIds.length} conversations with pending messages`);

    // 3. Process each conversation
    const results = [];
    for (const convId of conversationIds) {
      try {
        const result = await processConversationQueue(convId);
        results.push({
          conversationId: convId,
          processed: result.processed,
          messageCount: result.messageCount || 0,
        });
      } catch (error) {
        console.error(`[Cron] Error processing conversation ${convId}:`, error);
        results.push({
          conversationId: convId,
          processed: false,
          error: error.message,
        });
      }
    }

    const processedCount = results.filter(r => r.processed).length;
    console.log(`[Cron] Processed ${processedCount}/${conversationIds.length} conversations`);

    return NextResponse.json({
      status: 'ok',
      releasedLocks,
      processedConversations: processedCount,
      totalConversations: conversationIds.length,
      results,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    console.error('[Cron] process-queue error:', error);
    return NextResponse.json(
      {
        status: 'error',
        error: error.message,
        durationMs: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}
