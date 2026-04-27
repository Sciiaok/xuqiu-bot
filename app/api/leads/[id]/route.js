// app/api/leads/[id]/route.js
import { NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant-context';
import { getLeadById, updateLeadFields } from '@/lib/repositories/lead.repository';

async function loadLeadInTenant(leadId, tenantId) {
  const lead = await getLeadById(leadId);
  if (!lead || lead.tenant_id !== tenantId) return null;
  return lead;
}

export async function GET(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const lead = await loadLeadInTenant(id, ctx.tenantId);

    if (!lead) {
      return NextResponse.json(
        { success: false, error: 'Lead not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, lead });
  } catch (error) {
    console.error('Error fetching lead:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    if (!(await loadLeadInTenant(id, ctx.tenantId))) {
      return NextResponse.json(
        { success: false, error: 'Lead not found' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const lead = await updateLeadFields(id, body);

    return NextResponse.json({ success: true, lead });
  } catch (error) {
    console.error('Error updating lead:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
