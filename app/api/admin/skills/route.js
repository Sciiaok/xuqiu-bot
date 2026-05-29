import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import { SKILL_NAMES, SKILL_DISPLAY } from '@/lib/skills-github';

/**
 * GET /api/admin/skills
 *
 * Returns the current active version (if any) per known skill. Used by the
 * admin UI to render the per-skill cards.
 */
export async function GET() {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (ctx.tenantId !== FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('current_skill')
      .select('skill_name, commit_sha, commit_summary, commit_at, activated_at');
    if (error && error.code !== 'PGRST205') throw error;

    const activeByName = new Map((data || []).map((r) => [r.skill_name, r]));
    const skills = SKILL_NAMES.map((name) => ({
      name,
      display: SKILL_DISPLAY[name] || name,
      active: activeByName.get(name) || null,
    }));
    return NextResponse.json({ skills });
  } catch (err) {
    console.error('[admin/skills GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
