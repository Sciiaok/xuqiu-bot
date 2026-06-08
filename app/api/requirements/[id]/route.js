import { getTenantContext } from '@/lib/tenant-context';
import {
  getRequirementById,
  listRequirementAttachments,
  listRequirementEvents,
} from '@/lib/repositories/requirement.repository';

export async function GET(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const requirement = await getRequirementById({ tenantId: ctx.tenantId, id: params.id });
  if (!requirement) return Response.json({ error: 'Not found' }, { status: 404 });

  const [events, attachments] = await Promise.all([
    listRequirementEvents({ tenantId: ctx.tenantId, requirementId: params.id }),
    listRequirementAttachments({ tenantId: ctx.tenantId, requirementId: params.id }),
  ]);

  return Response.json({ data: requirement, events, attachments });
}
