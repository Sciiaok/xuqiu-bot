import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { fetchDashboardData, parseDashboardParams } from '@/lib/inquiry-dashboard';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const data = await fetchDashboardData(supabase, parseDashboardParams(searchParams));
    return NextResponse.json(data);
  } catch (error) {
    console.error('Inquiry Dashboard API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
