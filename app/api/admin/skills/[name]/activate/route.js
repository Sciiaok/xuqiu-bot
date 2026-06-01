import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import {
  SKILL_NAMES,
  ENVIRONMENTS,
  fetchSkillBundleAtCommit,
  getCommitMeta,
} from '@/lib/skills-github';

const SHA_RE = /^[a-f0-9]{40}$/;

/**
 * POST /api/admin/skills/[name]/activate
 * Body: { commit_sha: string, environment: 'test' | 'production' }
 *
 * Atomically:
 *   1. If commit_sha isn't already cached in skill_versions, fetch SKILL.md
 *      + references from GitHub and insert.
 *   2. Upsert skill_active for (skill_name, environment) to point at the sha.
 *
 * Only affects servers whose LEADENGINE_ENV matches the chosen environment.
 */
export async function POST(request, { params }) {
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

    const body = await request.json();
    const commitSha = String(body?.commit_sha || '').trim().toLowerCase();
    const environment = String(body?.environment || '').trim();
    if (!SHA_RE.test(commitSha)) {
      return NextResponse.json({ error: 'commit_sha must be a 40-char hex sha' }, { status: 400 });
    }
    if (!ENVIRONMENTS.includes(environment)) {
      return NextResponse.json(
        { error: `environment must be one of: ${ENVIRONMENTS.join(', ')}` },
        { status: 400 },
      );
    }

    const admin = getSupabaseAdmin();

    // Import bundle if not yet cached (env-independent — content is the same
    // for any commit, only the active pointer differs across envs).
    const { data: existing, error: lookupErr } = await admin
      .from('skill_versions')
      .select('commit_sha')
      .eq('skill_name', name)
      .eq('commit_sha', commitSha)
      .maybeSingle();
    if (lookupErr) throw lookupErr;

    if (!existing) {
      const [{ skillMd, refs }, meta] = await Promise.all([
        fetchSkillBundleAtCommit(name, commitSha),
        getCommitMeta(commitSha),
      ]);
      const { error: insertErr } = await admin.from('skill_versions').insert({
        skill_name: name,
        commit_sha: commitSha,
        commit_summary: meta.summary,
        commit_at: meta.date,
        skill_md: skillMd,
        refs,
        imported_by: ctx.user?.id || null,
      });
      if (insertErr) throw insertErr;
    }

    const { error: activateErr } = await admin
      .from('skill_active')
      .upsert({
        skill_name: name,
        environment,
        commit_sha: commitSha,
        activated_at: new Date().toISOString(),
        activated_by: ctx.user?.id || null,
      });
    if (activateErr) throw activateErr;

    return NextResponse.json({ ok: true, skill_name: name, environment, commit_sha: commitSha });
  } catch (err) {
    console.error('[admin/skills/[name]/activate POST] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
