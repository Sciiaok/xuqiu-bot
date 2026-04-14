import { NextResponse } from 'next/server';
import {
  generateReport,
  retryReport,
  reportExists,
  computePeriod,
} from '@/lib/services/report-generator';
import { config } from '@/src/config';

const MAX_AUTO_RETRIES = 3;

/**
 * POST /api/cron/generate-reports
 *
 * Called daily at 08:00 CST by PM2 cron.
 * Determines which reports to generate based on current date:
 *   - Daily: every day
 *   - Weekly: every Monday
 *   - Monthly: every 1st of month
 *
 * Also retries any failed reports (up to 3 times).
 */
export async function POST(request) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get('authorization');
    const cronSecret = config.secrets.cron;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const results = { generated: [], skipped: [], failed: [], retried: [] };

    // Determine which report types to generate
    const now = new Date();
    const chinaHour = (now.getUTCHours() + 8) % 24;
    const chinaDate = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const chinaDayOfWeek = chinaDate.getUTCDay(); // 0=Sun, 1=Mon
    const chinaDayOfMonth = chinaDate.getUTCDate();

    const typesToGenerate = ['daily'];
    if (chinaDayOfWeek === 1) typesToGenerate.push('weekly');
    if (chinaDayOfMonth === 1) typesToGenerate.push('monthly');

    // Generate each report type
    for (const type of typesToGenerate) {
      const { periodStart, periodEnd } = computePeriod(type, now);

      try {
        // Check if already exists
        const existing = await reportExists(type, periodStart, periodEnd);
        if (existing) {
          if (existing.status === 'completed') {
            results.skipped.push({ type, periodStart, periodEnd, reason: 'already exists' });
            continue;
          }
          if (existing.status === 'generating') {
            results.skipped.push({ type, periodStart, periodEnd, reason: 'already generating' });
            continue;
          }
          // Failed — will be handled in retry phase below
          continue;
        }

        const report = await generateReport({ type, periodStart, periodEnd });
        results.generated.push({ type, periodStart, periodEnd, id: report.id });
      } catch (err) {
        console.error(`[generate-reports] Failed to generate ${type} (${periodStart}~${periodEnd}):`, err.message);
        results.failed.push({ type, periodStart, periodEnd, error: err.message });
      }
    }

    // Retry failed reports (auto-retry up to MAX_AUTO_RETRIES)
    try {
      const { data: failedReports } = await (await import('@/lib/supabase')).default
        .from('ai_reports')
        .select('id, type, period_start, period_end, retry_count')
        .eq('status', 'failed')
        .lt('retry_count', MAX_AUTO_RETRIES)
        .order('created_at', { ascending: true })
        .limit(10);

      for (const report of failedReports || []) {
        try {
          await retryReport(report.id);
          results.retried.push({ id: report.id, type: report.type, attempt: report.retry_count + 1 });
        } catch (err) {
          console.error(`[generate-reports] Retry failed for ${report.id}:`, err.message);
          results.failed.push({ id: report.id, type: report.type, error: err.message });
        }
      }
    } catch (err) {
      console.error('[generate-reports] Failed to fetch failed reports for retry:', err.message);
    }

    return NextResponse.json({
      success: true,
      timestamp: now.toISOString(),
      chinaTime: `${chinaDate.toISOString().split('T')[0]} ${String(chinaHour).padStart(2, '0')}:00 CST`,
      results,
    });
  } catch (error) {
    console.error('[generate-reports] Cron error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// Support GET for manual testing
export async function GET(request) {
  return POST(request);
}
