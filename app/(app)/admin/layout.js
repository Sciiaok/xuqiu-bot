import { redirect } from 'next/navigation';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';

// 双保险：middleware 已挡 founder-only，这层在 middleware 失效时兜底。
export default async function AdminLayout({ children }) {
  const ctx = await getTenantContext();
  if (!ctx || ctx.tenantId !== FOUNDER_TENANT_ID) {
    redirect('/analytics');
  }
  return children;
}
