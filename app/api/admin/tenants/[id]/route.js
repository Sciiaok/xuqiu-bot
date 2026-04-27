import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import { recordAudit } from '@/lib/repositories/audit-log.repository';

/**
 * PATCH /api/admin/tenants/[id]  body: { status: 'active' | 'suspended' }
 *
 * Founder-only：暂停 / 恢复一个 tenant。暂停的 tenant 用户登录后所有 API 拉
 * 取的会被业务层按 tenant.status 过滤（V1 暂未在每条 API 检查；先把状态记下，
 * 必要时在 getTenantContext 加 suspended 拒绝）。
 */
export async function PATCH(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (ctx.tenantId !== FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;
    if (id === FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Cannot modify founder tenant' }, { status: 400 });
    }

    const body = await request.json();
    const status = body?.status;
    if (!['active', 'suspended'].includes(status)) {
      return NextResponse.json({ error: 'status must be active or suspended' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('tenants')
      .update({ status })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await recordAudit({
      tenantId: id,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: status === 'suspended' ? 'tenant.suspended' : 'tenant.resumed',
      details: { tenant_name: data?.name },
    });

    return NextResponse.json({ tenant: data });
  } catch (err) {
    console.error('[admin/tenants PATCH] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
