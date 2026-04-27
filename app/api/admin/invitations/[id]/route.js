import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import { recordAudit } from '@/lib/repositories/audit-log.repository';

/**
 * DELETE /api/admin/invitations/[id]
 * 撤销一条邀请（status → revoked）。已 accepted 的不能再撤。
 */
export async function DELETE(_request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (ctx.tenantId !== FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;

    const { data: existing, error: fetchErr } = await supabase
      .from('invitations')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }
    if (existing.status === 'accepted') {
      return NextResponse.json(
        { error: '该邀请已被接受，无法撤销' },
        { status: 409 }
      );
    }

    const { error: updErr } = await supabase
      .from('invitations')
      .update({ status: 'revoked' })
      .eq('id', id);
    if (updErr) throw updErr;

    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'invitation.revoked',
      details: { invitation_id: id },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[admin/invitations DELETE] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
