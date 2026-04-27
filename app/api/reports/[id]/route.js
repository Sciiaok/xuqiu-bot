import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';
import { retryReport } from '@/lib/services/report-generator';

async function loadReportInTenant(reportId, tenantId) {
  const { data, error } = await supabase
    .from('ai_reports')
    .select('*')
    .eq('id', reportId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * GET /api/reports/[id] — Get a single report
 */
export async function GET(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const report = await loadReportInTenant(id, ctx.tenantId);
    if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });

    return NextResponse.json({ report });
  } catch (err) {
    console.error('[api/reports/[id]] GET error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/reports/[id] — Retry a failed report
 */
export async function POST(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    if (!(await loadReportInTenant(id, ctx.tenantId))) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }
    const report = await retryReport(id);
    return NextResponse.json({ report });
  } catch (err) {
    console.error('[api/reports/[id]] POST error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
