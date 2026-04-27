import { redirect } from 'next/navigation';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';

// 登录后的根路径分发：
//   founder    → /admin/tenants（不参与业务，直接进平台管理）
//   普通租户   → /analytics（业务监控看板）
//   未登录 / 解析失败 → /login
export default async function V5Page() {
  const ctx = await getTenantContext();
  if (!ctx) redirect('/login');
  if (ctx.tenantId === FOUNDER_TENANT_ID) redirect('/admin/tenants');
  redirect('/analytics');
}
