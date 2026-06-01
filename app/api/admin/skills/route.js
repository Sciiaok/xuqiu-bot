import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import { SKILL_NAMES, SKILL_DISPLAY, ENVIRONMENTS } from '@/lib/skills-github';

/**
 * GET /api/admin/skills
 *
 * Per skill, returns the currently active commit for each environment.
 * Shape:
 *   { skills: [{ name, display, active: { test: {…} | null, production: {…} | null } }] }
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
      .select('skill_name, environment, commit_sha, commit_summary, commit_at, activated_at');
    if (error && error.code !== 'PGRST205') throw error;

    // Build {skill_name: {env: row}}
    const byName = new Map();
    for (const row of data || []) {
      if (!byName.has(row.skill_name)) byName.set(row.skill_name, {});
      byName.get(row.skill_name)[row.environment] = row;
    }

    const skills = SKILL_NAMES.map((name) => {
      const envMap = byName.get(name) || {};
      const active = {};
      for (const env of ENVIRONMENTS) active[env] = envMap[env] || null;
      return { name, display: SKILL_DISPLAY[name] || name, active };
    });
    return NextResponse.json({ skills, environments: ENVIRONMENTS });
  } catch (err) {
    console.error('[admin/skills GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
