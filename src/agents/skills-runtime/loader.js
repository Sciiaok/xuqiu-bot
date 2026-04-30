/**
 * Skills runtime — load a `.skill` bundle (Anthropic skill format) from disk
 * and return its content in a shape Ogilvy (or any other agent) can consume.
 *
 * What "loading" means:
 *   1. Locate the bundle: prefer `skills/<name>.skill` (zip), fall back to
 *      `skills/<name>/` (extracted directory). Both forms are supported so a
 *      .skill can be replaced as a single file OR the contents can be edited
 *      in-place during development.
 *   2. Parse `SKILL.md`'s YAML frontmatter (name + description) and split out
 *      its body — the body is what becomes the agent's system prompt.
 *   3. Index `references/*.md` into a Map<basenameWithoutExt, content> so the
 *      agent can pull a reference on demand via a `read_skill_reference` tool
 *      instead of pre-loading every reference into the prompt.
 *
 * Caching: results are memoized in a module-level Map keyed by absolute path.
 * Restart the process to pick up a swapped .skill bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

// Resolve `skills/` relative to this file (not process.cwd()) so the path
// holds whether the server runs from the repo root, a subdirectory, or a
// bundled standalone build (Vercel etc.). This file is at
// src/agents/skills-runtime/loader.js — three dirs up is the project root.
const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills');
const cache = new Map();

/**
 * Load a skill bundle by name.
 *
 * @param {string} name — skill name (matches the bundle's frontmatter.name and
 *   the file/directory under `skills/`)
 * @returns {Promise<{
 *   metadata: { name: string, description: string },
 *   systemPrompt: string,           // SKILL.md body, frontmatter stripped
 *   references: Map<string, string>,// references/<key>.md → content
 *   source: { kind: 'zip'|'dir', path: string, sha256: string },
 * }>}
 */
export async function loadSkill(name) {
  const zipPath = path.join(SKILLS_DIR, `${name}.skill`);
  const dirPath = path.join(SKILLS_DIR, name);

  if (fs.existsSync(zipPath)) {
    const cached = cache.get(zipPath);
    const stat = fs.statSync(zipPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.skill;

    const skill = await loadFromZip(zipPath, name);
    cache.set(zipPath, { skill, mtimeMs: stat.mtimeMs });
    return skill;
  }

  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    const cached = cache.get(dirPath);
    if (cached) return cached.skill;
    const skill = loadFromDir(dirPath, name);
    cache.set(dirPath, { skill });
    return skill;
  }

  throw new Error(
    `[skills-runtime] skill "${name}" not found. Looked for ${zipPath} and ${dirPath}.`,
  );
}

// ── zip path ────────────────────────────────────────────────────────────

async function loadFromZip(zipPath, expectedName) {
  const buf = fs.readFileSync(zipPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const zip = await JSZip.loadAsync(buf);

  // Skill bundles wrap content in a single top-level dir matching the name.
  const root = `${expectedName}/`;
  const skillFile = zip.file(`${root}SKILL.md`);
  if (!skillFile) {
    throw new Error(`[skills-runtime] ${zipPath}: missing ${root}SKILL.md at zip root`);
  }
  const skillRaw = await skillFile.async('string');
  const { metadata, body } = parseSkillFrontmatter(skillRaw, zipPath);
  assertNameMatch(metadata, expectedName, zipPath);

  // Walk references/. zip.folder(...).forEach iterates files inside that dir.
  const references = new Map();
  const refDir = zip.folder(`${root}references`);
  if (refDir) {
    const promises = [];
    refDir.forEach((relPath, file) => {
      if (file.dir) return;
      if (!relPath.endsWith('.md')) return;
      const key = path.basename(relPath, '.md');
      promises.push(file.async('string').then(content => references.set(key, content)));
    });
    await Promise.all(promises);
  }

  return {
    metadata,
    systemPrompt: body,
    references,
    source: { kind: 'zip', path: zipPath, sha256 },
  };
}

// ── extracted dir path ──────────────────────────────────────────────────

function loadFromDir(dirPath, expectedName) {
  const skillPath = path.join(dirPath, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    throw new Error(`[skills-runtime] ${dirPath}: missing SKILL.md`);
  }
  const skillRaw = fs.readFileSync(skillPath, 'utf8');
  const { metadata, body } = parseSkillFrontmatter(skillRaw, dirPath);
  assertNameMatch(metadata, expectedName, dirPath);

  const references = new Map();
  const refDir = path.join(dirPath, 'references');
  if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
    for (const f of fs.readdirSync(refDir)) {
      if (!f.endsWith('.md')) continue;
      const key = path.basename(f, '.md');
      references.set(key, fs.readFileSync(path.join(refDir, f), 'utf8'));
    }
  }

  // Best-effort sha256 over the SKILL.md body — directory mode is dev-only,
  // exact bundle integrity isn't meaningful here.
  const sha256 = crypto.createHash('sha256').update(skillRaw).digest('hex').slice(0, 16);

  return {
    metadata,
    systemPrompt: body,
    references,
    source: { kind: 'dir', path: dirPath, sha256 },
  };
}

// ── frontmatter parser ──────────────────────────────────────────────────
//
// Skill bundles use a tiny YAML frontmatter (name + description). We don't
// need full YAML — just the leading `---\n...\n---\n` block. Description can
// span multiple lines via the `>` block-scalar form, which we collapse to a
// single space-joined string.

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
      // Block scalar: take subsequent indented lines until we hit a non-indented
      // line or end. Join with a single space (`>` is folded; we don't preserve
      // line breaks since description is a single sentence).
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
      `against accidentally swapping the wrong .skill into the slot.`,
    );
  }
}
