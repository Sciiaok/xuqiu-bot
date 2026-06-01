import { NextResponse } from 'next/server';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import { SKILL_NAMES, listBranches } from '@/lib/skills-github';

/**
 * GET /api/admin/skills/[name]/branches
 *
 * Returns the list of branches in LeadEngine/skills, with the default branch
 * first. The name param exists for URL symmetry with the other skill routes
 * but isn't used in the response — branches are repo-wide, not per skill.
 */
export async function GET(_req, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (ctx.tenantId !== FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { name } = await params;
    if (!SKILL_NAMES.includes(name)) {
      return NextResponse.json({ error: 'unknown skill' }, { status: 404 });
    }

    const { branches, defaultBranch } = await listBranches();
    return NextResponse.json({ branches, default: defaultBranch });
  } catch (err) {
    console.error('[admin/skills/[name]/branches GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
