import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import { SKILL_NAMES, fetchSkillBundleAtCommit, getCommitMeta } from '@/lib/skills-github';

const SHA_RE = /^[a-f0-9]{40}$/;

/**
 * POST /api/admin/skills/[name]/activate
 * Body: { commit_sha: string }
 *
 * Atomically:
 *   1. If commit_sha isn't already cached, fetch SKILL.md + references from
 *      GitHub and insert into skill_versions.
 *   2. Upsert skill_active to point at commit_sha.
 *
 * Next loadSkill(name) call (from any process) picks up the new active row.
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
    if (!SHA_RE.test(commitSha)) {
      return NextResponse.json({ error: 'commit_sha must be a 40-char hex sha' }, { status: 400 });
    }

    const admin = getSupabaseAdmin();

    // Import if not cached
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
        commit_sha: commitSha,
        activated_at: new Date().toISOString(),
        activated_by: ctx.user?.id || null,
      });
    if (activateErr) throw activateErr;

    return NextResponse.json({ ok: true, skill_name: name, commit_sha: commitSha });
  } catch (err) {
    console.error('[admin/skills/[name]/activate POST] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
