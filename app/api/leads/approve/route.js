// app/api/leads/approve/route.js
import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { leadIds, approveAll, filters } = body;

    let idsToApprove = leadIds || [];

    // If approveAll, query leads matching filters
    if (approveAll) {
      let query = supabase
        .from('leads')
        .select('id')
        .eq('tenant_id', ctx.tenantId)
        .eq('approved', false);

      if (filters?.stage) {
        query = query.eq('stage', filters.stage);
      }
      if (filters?.scoreMin !== undefined) {
        query = query.gte('score', filters.scoreMin);
      }
      if (filters?.scoreMax !== undefined) {
        query = query.lte('score', filters.scoreMax);
      }

      const { data, error } = await query;
      if (error) throw error;

      idsToApprove = data?.map(l => l.id) || [];
    }

    if (idsToApprove.length === 0) {
      return NextResponse.json({
        success: true,
        approved: 0,
        message: 'No leads to approve',
      });
    }

    // 显式 tenant 过滤防止越权批准 —— 即使前端传了别 tenant 的 leadIds，
    // 这里也会把它们 filter 掉。
    const { data: approved, error: approveError } = await supabase
      .from('leads')
      .update({
        approved: true,
        approved_at: new Date().toISOString(),
        approved_by: ctx.user.email || 'manual',
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', ctx.tenantId)
      .in('id', idsToApprove)
      .eq('approved', false)
      .select('id');

    if (approveError) throw approveError;

    const approvedCount = approved?.length || 0;
    return NextResponse.json({
      success: true,
      approved: approvedCount,
      message: `${approvedCount} lead${approvedCount !== 1 ? 's' : ''} approved`,
    });
  } catch (error) {
    console.error('Error approving leads:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
