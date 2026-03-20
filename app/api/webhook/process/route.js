import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { processConversationQueue } from '../../../../lib/queue-processor.js';
import { hasPendingMessages, releaseStaleLocks } from '../../../../lib/repositories/queue.repository.js';

/**
 * POST /api/webhook/process - Trigger queue processing for a conversation
 * Called after the aggregation window expires
 */
export async function POST(request) {
  const demoResponse = demoGuard({ status: 'ok' });
  if (demoResponse) return demoResponse;

  try {
    const body = await request.json();
    const { conversationId } = body;

    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversationId is required' },
        { status: 400 }
      );
    }

    // Check if there are actually pending messages ready to process
    const hasReady = await hasPendingMessages(conversationId);
    if (!hasReady) {
      return NextResponse.json({
        status: 'skipped',
        reason: 'no_ready_messages',
      });
    }

    // Process the conversation queue
    const result = await processConversationQueue(conversationId);

    return NextResponse.json({
      status: result.processed ? 'processed' : 'skipped',
      ...result,
    });
  } catch (error) {
    console.error('Error in webhook process:', error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

/**
 * GET /api/webhook/process - Health check and stale lock cleanup
 * Can be called by a cron job to recover from crashed instances
 */
export async function GET() {
  try {
    const releasedCount = await releaseStaleLocks();

    return NextResponse.json({
      status: 'ok',
      releasedStaleLocks: releasedCount,
    });
  } catch (error) {
    console.error('Error in webhook process health check:', error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
