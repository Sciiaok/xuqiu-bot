// app/api/leads/approve/route.js
import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import supabase from '@/lib/supabase';
import { batchApproveLeads } from '@/lib/repositories/lead.repository';

export async function POST(request) {
  const demoResponse = demoGuard({ success: true, approved: 0, message: 'Demo mode' });
  if (demoResponse) return demoResponse;

  try {
    const body = await request.json();
    const { leadIds, approveAll, filters } = body;

    let idsToApprove = leadIds || [];

    // If approveAll, query leads matching filters
    if (approveAll) {
      let query = supabase
        .from('leads')
        .select('id')
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

    const approvedCount = await batchApproveLeads(idsToApprove, 'manual');

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
