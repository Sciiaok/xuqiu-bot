/**
 * Skills runtime — load a skill bundle directory from disk and return its
 * content in a shape Ogilvy (or any other agent) can consume.
 *
 * What "loading" means:
 *   1. Locate the bundle at `skills/<name>/`.
 *   2. Parse `SKILL.md`'s YAML frontmatter (name + description) and split out
 *      its body — the body is what becomes the agent's system prompt.
 *   3. Index `references/*.md` into a Map<basenameWithoutExt, content> so the
 *      agent can pull a reference on demand via a `read_skill_reference` tool
 *      instead of pre-loading every reference into the prompt.
 *
 * Caching: results are memoized in a module-level Map keyed by absolute path.
 * Restart the process to pick up edits to a skill bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
 *   the directory under `skills/`)
 * @returns {Promise<{
 *   metadata: { name: string, description: string },
 *   systemPrompt: string,           // SKILL.md body, frontmatter stripped
 *   references: Map<string, string>,// references/<key>.md → content
 *   source: { path: string, sha256: string },
 * }>}
 */
export async function loadSkill(name) {
  const dirPath = path.join(SKILLS_DIR, name);

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`[skills-runtime] skill "${name}" not found at ${dirPath}.`);
  }

  const cached = cache.get(dirPath);
  if (cached) return cached;

  const skill = loadFromDir(dirPath, name);
  cache.set(dirPath, skill);
  return skill;
}

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
  const hash = crypto.createHash('sha256').update(skillRaw);
  if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
    // Recursive walk: bundle v2 reorganized references into `platforms/`,
    // `industries/`, `playbooks/` subdirs + a few top-level docs. Keys are
    // relative paths without the `.md` suffix using forward slashes
    // (e.g. `platforms/meta`, `industries/automotive`, `data-sources`).
    // Sorted for deterministic sha256.
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
      const key = rel.slice(0, -3); // strip ".md"
      const content = fs.readFileSync(full, 'utf8');
      references.set(key, content);
      hash.update('\0').update(rel).update('\0').update(content);
    }
  }
  const sha256 = hash.digest('hex').slice(0, 16);

  return {
    metadata,
    systemPrompt: body,
    references,
    source: { path: dirPath, sha256 },
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
      `against accidentally loading the wrong skill into the slot.`,
    );
  }
}
