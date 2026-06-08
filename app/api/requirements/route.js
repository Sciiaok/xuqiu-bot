import { getTenantContext } from '@/lib/tenant-context';
import { listRequirements } from '@/lib/repositories/requirement.repository';

export async function GET(request) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const rows = await listRequirements({
    tenantId: ctx.tenantId,
    filters: {
      status: params.get('status') || '',
      priority: params.get('priority') || '',
      current_owner: params.get('current_owner') || '',
      requirement_type: params.get('requirement_type') || '',
    },
    limit: Number(params.get('limit') || 100),
  });

  return Response.json({ data: rows });
}
