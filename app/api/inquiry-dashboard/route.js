import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';
import { fetchDashboardData, parseDashboardParams } from '@/lib/inquiry-dashboard';

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const params = parseDashboardParams(searchParams);
    const data = await fetchDashboardData(supabase, { tenantId: ctx.tenantId, ...params });
    return NextResponse.json(data);
  } catch (error) {
    console.error('Inquiry Dashboard API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
