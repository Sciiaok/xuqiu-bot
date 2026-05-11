#!/usr/bin/env node
// Regenerates the auto-derived parts of `.claude/index/`:
//   - schema.md  → current DB tables, columns, FKs (live from Supabase)
//   - routes.md  → API endpoints + UI pages (from filesystem)
//
// Run manually after schema changes or new routes:
//   node scripts/build-index.mjs
//
// Hand-written files (MAP.md, glossary.md, README.md) are not touched.

import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv({ path: '.env.local' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.claude/index');

await fs.mkdir(OUT_DIR, { recursive: true });

await Promise.all([buildSchema(), buildRoutes()]);

// Writes `content` to `file` only if the meaningful body differs from what's
// already on disk. The `Generated:` timestamp line is excluded from the diff
// so the file stays clean when nothing real changed.
async function writeIfChanged(file, content, label) {
  const normalize = (s) => s.replace(/^Generated: .*$/m, '');
  let prev = null;
  try { prev = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (prev !== null && normalize(prev) === normalize(content)) {
    console.log(`[${label}] up to date — skipping write`);
    return;
  }
  await fs.writeFile(file, content);
  console.log(`[${label}] wrote ${path.basename(file)}`);
}

async function buildSchema() {
  const url = 'https://exevqpqpsvojfowpzize.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.warn('[schema] SUPABASE_SERVICE_ROLE_KEY missing — skipping schema.md regen');
    return;
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const columnsSql = `
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;
  `;
  const fksSql = `
    SELECT
      tc.table_name AS src_table,
      kcu.column_name AS src_column,
      ccu.table_name AS dst_table,
      ccu.column_name AS dst_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
    ORDER BY tc.table_name, kcu.column_name;
  `;
  const indexesSql = `
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname;
  `;

  const [cols, fks, idx] = await Promise.all([
    rpc(sb, columnsSql),
    rpc(sb, fksSql),
    rpc(sb, indexesSql),
  ]);

  // Group columns by table
  const byTable = new Map();
  for (const c of cols) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
    byTable.get(c.table_name).push(c);
  }
  // Group FKs by source table
  const fkBySrc = new Map();
  for (const f of fks) {
    if (!fkBySrc.has(f.src_table)) fkBySrc.set(f.src_table, []);
    fkBySrc.get(f.src_table).push(f);
  }
  // Group indexes by table (skip PK / unique constraint indexes which are obvious)
  const idxByTable = new Map();
  for (const i of idx) {
    if (/_pkey$/.test(i.indexname)) continue;
    if (!idxByTable.has(i.tablename)) idxByTable.set(i.tablename, []);
    idxByTable.get(i.tablename).push(i);
  }

  const lines = [];
  lines.push('# Schema Snapshot (auto-generated)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Live snapshot of `public` schema from Supabase. **Do not edit by hand** — run `node scripts/build-index.mjs` to refresh.');
  lines.push('');
  lines.push(`Tables: **${byTable.size}**. Listed alphabetically.`);
  lines.push('');

  const tableNames = [...byTable.keys()].sort();
  // Table-of-contents
  lines.push('## Tables');
  lines.push('');
  for (const t of tableNames) {
    lines.push(`- [\`${t}\`](#${anchor(t)})`);
  }
  lines.push('');

  for (const t of tableNames) {
    lines.push(`### \`${t}\``);
    lines.push('');
    lines.push('| Column | Type | Nullable | Default |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of byTable.get(t)) {
      const type = c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type;
      const def = c.column_default ? `\`${truncate(c.column_default, 40)}\`` : '';
      lines.push(`| \`${c.column_name}\` | ${type} | ${c.is_nullable === 'YES' ? 'Y' : 'N'} | ${def} |`);
    }
    lines.push('');
    const myFks = fkBySrc.get(t) || [];
    if (myFks.length) {
      lines.push('**Foreign keys:**');
      for (const f of myFks) {
        lines.push(`- \`${f.src_column}\` → \`${f.dst_table}.${f.dst_column}\``);
      }
      lines.push('');
    }
    const myIdx = idxByTable.get(t) || [];
    if (myIdx.length) {
      lines.push('**Indexes:**');
      for (const i of myIdx) {
        const def = i.indexdef.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+\S+\s+ON\s+\S+\s+/, '');
        lines.push(`- \`${i.indexname}\` ${def}`);
      }
      lines.push('');
    }
  }

  await writeIfChanged(
    path.join(OUT_DIR, 'schema.md'),
    lines.join('\n'),
    `schema (${tableNames.length} tables)`,
  );
}

async function rpc(sb, query) {
  // dev_exec_sql wraps as `SELECT row_to_json(t)::jsonb FROM (<query>) t`,
  // so trailing semicolons / whitespace must be stripped.
  const clean = query.trim().replace(/;+$/, '').trim();
  const { data, error } = await sb.rpc('dev_exec_sql', { query: clean });
  if (error) throw new Error(`SQL failed: ${error.message}\n${clean}`);
  return Array.isArray(data) ? data : [];
}

function anchor(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function buildRoutes() {
  const apiRoutes = await collectApiRoutes(path.join(ROOT, 'app/api'));
  const pageRoutes = await collectPageRoutes(path.join(ROOT, 'app/(app)'), '/');

  const lines = [];
  lines.push('# Routes (auto-generated)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Filesystem-derived list of API endpoints and UI pages. **Do not edit** — run `node scripts/build-index.mjs` to refresh.');
  lines.push('');

  lines.push('## API Endpoints');
  lines.push('');
  lines.push(`Total: **${apiRoutes.length}**`);
  lines.push('');
  lines.push('| Path | Methods | File |');
  lines.push('| --- | --- | --- |');
  for (const r of apiRoutes) {
    lines.push(`| \`${r.urlPath}\` | ${r.methods.join(', ')} | [${r.relFile}](../../${r.relFile}) |`);
  }
  lines.push('');

  lines.push('## UI Pages');
  lines.push('');
  lines.push(`Total: **${pageRoutes.length}**`);
  lines.push('');
  lines.push('| URL | File |');
  lines.push('| --- | --- |');
  for (const r of pageRoutes) {
    lines.push(`| \`${r.urlPath}\` | [${r.relFile}](../../${r.relFile}) |`);
  }
  lines.push('');

  lines.push('## Cron Jobs');
  lines.push('');
  const cronRoutes = apiRoutes.filter((r) => r.urlPath.startsWith('/api/cron/'));
  if (cronRoutes.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const r of cronRoutes) {
      lines.push(`- \`${r.urlPath}\` → [${r.relFile}](../../${r.relFile})`);
    }
  }
  lines.push('');

  await writeIfChanged(
    path.join(OUT_DIR, 'routes.md'),
    lines.join('\n'),
    `routes (${apiRoutes.length} API + ${pageRoutes.length} pages)`,
  );
}

async function collectApiRoutes(apiDir) {
  const out = [];
  await walk(apiDir, async (full, rel) => {
    if (!/\/route\.(js|ts)$/.test(full)) return;
    const src = await fs.readFile(full, 'utf8');
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
      .filter((m) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src));
    if (methods.length === 0) return;
    const urlPath = '/api/' + rel.replace(/\/route\.(js|ts)$/, '');
    out.push({
      urlPath,
      methods,
      relFile: path.relative(ROOT, full),
    });
  });
  out.sort((a, b) => a.urlPath.localeCompare(b.urlPath));
  return out;
}

async function collectPageRoutes(pageDir, urlPrefix) {
  const out = [];
  await walk(pageDir, async (full) => {
    if (!/\/page\.(js|jsx|ts|tsx)$/.test(full)) return;
    const rel = path.relative(pageDir, full).replace(/\/page\.(js|jsx|ts|tsx)$/, '');
    // Strip route groups like (foo) and ignore api groups
    const urlPath = urlPrefix + rel
      .split('/')
      .filter((seg) => !/^\(.+\)$/.test(seg))
      .join('/');
    out.push({
      urlPath: urlPath.replace(/\/+$/, '') || '/',
      relFile: path.relative(ROOT, full),
    });
  });
  out.sort((a, b) => a.urlPath.localeCompare(b.urlPath));
  return out;
}

async function walk(dir, onFile) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  await Promise.all(entries.map(async (e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, onFile);
    } else if (e.isFile()) {
      await onFile(full, path.relative(dir.includes('app/api') ? path.join(ROOT, 'app/api') : dir, full));
    }
  }));
}
