import { getTenantContext } from '@/lib/tenant-context';
import { getRequirementById } from '@/lib/repositories/requirement.repository';
import { syncRequirementToBitable } from '@/src/requirement-bitable.service';

export async function POST(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const requirement = await getRequirementById({ tenantId: ctx.tenantId, id: params.id });
  if (!requirement) return Response.json({ error: 'Not found' }, { status: 404 });

  const result = await syncRequirementToBitable({ tenantId: ctx.tenantId, requirement });
  if (result.ok || result.skipped) return Response.json(result);
  return Response.json(result, { status: 500 });
}
