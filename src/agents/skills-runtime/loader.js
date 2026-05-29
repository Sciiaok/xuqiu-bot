/**
 * Skills runtime — load a skill bundle and return its content in a shape
 * Ogilvy / Medici can consume.
 *
 * Two sources, in priority order:
 *   1. Supabase `current_skill` view — populated by the admin UI when a
 *      version is activated. Hot-swappable: switch the active commit_sha
 *      via /admin/skills, all callers pick up the new content on the
 *      next loadSkill() call.
 *   2. Submodule fallback on disk at `skills/<name>/SKILL.md` — used as
 *      baseline when no row exists in skill_active yet (fresh install,
 *      or admin has never picked a version).
 *
 * No process-level cache: each call goes to the DB so all PM2 processes
 * (Next app + cron workers) see updates immediately. Latency ~5-20ms,
 * negligible vs. the LLM call that follows.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getSupabaseAdmin } from '../../../lib/supabase-admin.js';

const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills');

/**
 * @param {string} name
 * @returns {Promise<{
 *   metadata: { name: string, description: string },
 *   systemPrompt: string,
 *   references: Map<string, string>,
 *   source: { path: string, sha256: string },
 * }>}
 */
export async function loadSkill(name) {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('current_skill')
    .select('commit_sha, skill_md, refs')
    .eq('skill_name', name)
    .maybeSingle();

  // PGRST205 = PostgREST sees no such table (migration not yet applied).
  // Fall back to disk baseline so dev / preview environments work without
  // manual schema setup. All other errors are genuine (auth, network) and
  // bubble up.
  if (error && error.code !== 'PGRST205') {
    throw new Error(`[skills-runtime] DB read failed for "${name}": ${error.message}`);
  }

  if (data) return loadFromRow(name, data);
  return loadFromDisk(name);
}

function loadFromRow(name, row) {
  const { metadata, body } = parseSkillFrontmatter(row.skill_md, `db:${name}@${row.commit_sha.slice(0, 7)}`);
  assertNameMatch(metadata, name, `db:${name}`);

  const refs = row.refs || {};
  const keys = Object.keys(refs).sort();
  const references = new Map();
  const hash = crypto.createHash('sha256').update(row.skill_md);
  for (const key of keys) {
    const content = refs[key];
    references.set(key, content);
    hash.update('\0').update(key).update('\0').update(content);
  }
  return {
    metadata,
    systemPrompt: body,
    references,
    source: {
      path: `db://current_skill/${name}@${row.commit_sha.slice(0, 7)}`,
      sha256: hash.digest('hex').slice(0, 16),
    },
  };
}

function loadFromDisk(name) {
  const dirPath = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`[skills-runtime] skill "${name}" not found in DB or at ${dirPath}.`);
  }
  const skillPath = path.join(dirPath, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    throw new Error(`[skills-runtime] ${dirPath}: missing SKILL.md`);
  }
  const skillRaw = fs.readFileSync(skillPath, 'utf8');
  const { metadata, body } = parseSkillFrontmatter(skillRaw, dirPath);
  assertNameMatch(metadata, name, dirPath);

  const references = new Map();
  const refDir = path.join(dirPath, 'references');
  const hash = crypto.createHash('sha256').update(skillRaw);
  if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
      }
    };
    walk(refDir);
    files.sort();
    for (const full of files) {
      const rel = path.relative(refDir, full).split(path.sep).join('/');
      const key = rel.slice(0, -3);
      const content = fs.readFileSync(full, 'utf8');
      references.set(key, content);
      hash.update('\0').update(rel).update('\0').update(content);
    }
  }
  return {
    metadata,
    systemPrompt: body,
    references,
    source: { path: dirPath, sha256: hash.digest('hex').slice(0, 16) },
  };
}

// ── frontmatter parser ──────────────────────────────────────────────────
//
// Skill bundles use a tiny YAML frontmatter (name + description). We don't
// need full YAML — just the leading `---\n...\n---\n` block. Description
// can span multiple lines via the `>` block-scalar form, which we collapse
// to a single space-joined string.

function parseSkillFrontmatter(raw, sourcePath) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`[skills-runtime] ${sourcePath}: SKILL.md missing YAML frontmatter`);
  }
  const fm = match[1];
  const body = match[2];

  const lines = fm.split(/\r?\n/);
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let value = m[2];

    if (value === '>' || value === '|') {
      const collected = [];
      i++;
      while (i < lines.length && /^\s/.test(lines[i])) {
        collected.push(lines[i].trim());
        i++;
      }
      out[key] = collected.join(' ').trim();
      continue;
    }

    out[key] = value.trim();
    i++;
  }

  if (!out.name) {
    throw new Error(`[skills-runtime] ${sourcePath}: frontmatter missing 'name' field`);
  }
  return { metadata: out, body: body.trimStart() };
}

function assertNameMatch(metadata, expectedName, sourcePath) {
  if (metadata.name !== expectedName) {
    throw new Error(
      `[skills-runtime] ${sourcePath}: frontmatter.name="${metadata.name}" ` +
      `does not match expected "${expectedName}". Refusing to load — this guards ` +
      `against accidentally loading the wrong skill into the slot.`,
    );
  }
}
