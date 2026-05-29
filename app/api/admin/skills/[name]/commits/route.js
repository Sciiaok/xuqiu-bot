import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import { SKILL_NAMES, listSkillCommits } from '@/lib/skills-github';

/**
 * GET /api/admin/skills/[name]/commits
 *
 * Returns recent commits from LeadEngine/skills that touched <name>/, each
 * marked with `imported: bool` so the UI can show whether activating it would
 * require a fresh DB pull.
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

    const commits = await listSkillCommits(name);

    // Mark which commits are already cached in skill_versions
    const admin = getSupabaseAdmin();
    const { data: imported, error } = await admin
      .from('skill_versions')
      .select('commit_sha')
      .eq('skill_name', name)
      .in('commit_sha', commits.map((c) => c.sha));
    if (error && error.code !== 'PGRST205') throw error;
    const importedSet = new Set((imported || []).map((r) => r.commit_sha));

    return NextResponse.json({
      commits: commits.map((c) => ({ ...c, imported: importedSet.has(c.sha) })),
    });
  } catch (err) {
    console.error('[admin/skills/[name]/commits GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
