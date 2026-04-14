import { NextResponse } from 'next/server';
import {
  findExpiredTakeovers,
  endHumanTakeover,
} from '../../../../lib/repositories/conversation.repository.js';
import { config } from '../../../../src/config.js';

/**
 * GET /api/cron/release-takeovers
 * Releases human takeover on conversations idle for 1+ hour
 * Should be called by pm2 cron every minute
 */
export async function GET(request) {
  // Optional cron secret (aligned with existing process-queue pattern)
  const authHeader = request.headers.get('authorization');
  const cronSecret = config.secrets.cron;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (config.app.takeoverAutoExpireDisabled) {
      return NextResponse.json({ released: 0, skipped: 'TAKEOVER_AUTO_EXPIRE=off' });
    }

    const expiredIds = await findExpiredTakeovers();

    if (expiredIds.length === 0) {
      return NextResponse.json({ released: 0 });
    }

    for (const id of expiredIds) {
      await endHumanTakeover(id);
    }

    console.log(`Cron: released ${expiredIds.length} expired human takeover(s)`);
    return NextResponse.json({ released: expiredIds.length, ids: expiredIds });
  } catch (error) {
    console.error('Cron release-takeovers error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
