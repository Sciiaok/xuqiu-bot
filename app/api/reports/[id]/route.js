import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import supabase from '@/lib/supabase';
import { retryReport } from '@/lib/services/report-generator';

/**
 * GET /api/reports/[id] — Get a single report
 */
export async function GET(request, { params }) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const { data, error } = await supabase
      .from('ai_reports')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Report not found' }, { status: 404 });
      }
      throw error;
    }

    return NextResponse.json({ report: data });
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
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const report = await retryReport(id);
    return NextResponse.json({ report });
  } catch (err) {
    console.error('[api/reports/[id]] POST error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
