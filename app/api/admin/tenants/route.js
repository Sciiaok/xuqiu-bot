import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';

/**
 * GET /api/admin/tenants
 *
 * Founder-only：列出所有 tenant + 各自的 active Meta 连接 + 数据量摘要。
 */
export async function GET() {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (ctx.tenantId !== FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('id, name, slug, status, created_at, created_by, metadata')
      .order('created_at', { ascending: true });
    if (error) throw error;

    // 各 tenant 的 active connection + 用户数 + 产品线数 + 对话数 —— 一次拉
    const tenantIds = (tenants || []).map(t => t.id);

    const [{ data: conns }, { data: users }, { data: lines }, { data: convs }, { data: progresses }] = await Promise.all([
      supabase.from('meta_connections').select('tenant_id, business_name, bm_id, last_health_check_at, health_check_failed_count').in('tenant_id', tenantIds).eq('status', 'active'),
      supabase.from('users').select('tenant_id').in('tenant_id', tenantIds),
      supabase.from('product_lines').select('tenant_id').in('tenant_id', tenantIds).eq('is_active', true),
      supabase.from('conversations').select('tenant_id').in('tenant_id', tenantIds),
      supabase.from('onboarding_progress').select('tenant_id, completed_at, account_created_at, meta_connected_at, first_ai_reply_at').in('tenant_id', tenantIds),
    ]);

    const connByTenant = new Map((conns || []).map(c => [c.tenant_id, c]));
    const userCountByTenant = new Map();
    for (const u of users || []) userCountByTenant.set(u.tenant_id, (userCountByTenant.get(u.tenant_id) || 0) + 1);
    const lineCountByTenant = new Map();
    for (const l of lines || []) lineCountByTenant.set(l.tenant_id, (lineCountByTenant.get(l.tenant_id) || 0) + 1);
    const convCountByTenant = new Map();
    for (const c of convs || []) convCountByTenant.set(c.tenant_id, (convCountByTenant.get(c.tenant_id) || 0) + 1);
    const progressByTenant = new Map((progresses || []).map(p => [p.tenant_id, p]));

    return NextResponse.json({
      tenants: (tenants || []).map(t => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        created_at: t.created_at,
        is_founder: t.id === FOUNDER_TENANT_ID,
        meta_connection: connByTenant.get(t.id) || null,
        counts: {
          users: userCountByTenant.get(t.id) || 0,
          product_lines: lineCountByTenant.get(t.id) || 0,
          conversations: convCountByTenant.get(t.id) || 0,
        },
        onboarding: progressByTenant.get(t.id) || null,
      })),
    });
  } catch (err) {
    console.error('[admin/tenants GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
