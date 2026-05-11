# Codebase Index

A navigation layer for Claude Code. Read this before grepping.

## Files

| File | What | Maintained by | When it updates |
| --- | --- | --- | --- |
| [`MAP.md`](MAP.md) | Feature → files/dirs/tables; "where do I add X" | **Hand-written** | Edit when adding a feature or moving directories |
| [`glossary.md`](glossary.md) | Domain terms (lead vs inquiry, KB layers, etc.) | **Hand-written** | Edit when adding/renaming a domain concept |
| [`schema.md`](schema.md) | Current DB tables, columns, FKs, indexes | **Auto** (from live Supabase) | `node scripts/build-index.mjs` after schema changes |
| [`routes.md`](routes.md) | All API endpoints + UI pages | **Auto** (from filesystem) | `node scripts/build-index.mjs` after adding routes |

## How to use this (Claude Code)

When starting a non-trivial task:

1. **Read `MAP.md`** to find the feature's main files.
2. **Read the relevant section of `schema.md`** if touching DB.
3. **Skim `glossary.md`** if the task mentions a domain word you're not 100% sure about.
4. `routes.md` is mostly for confirming an endpoint exists / its HTTP methods before writing client code.

For trivial tasks (single-file edits, UI tweaks), skip the index and grep directly. The index has overhead — it's worth it for tasks that span >2 files.

## How to maintain (humans)

- **Auto files** — never edit by hand. Run `node scripts/build-index.mjs` to refresh. Commit the result.
- **Hand files** — edit when the relevant fact changes. Don't worry about minor drift; the index is a starting point, not authoritative.
- The script requires `.env.local` with `SUPABASE_SERVICE_ROLE_KEY`. If the env is missing, the script skips `schema.md` and only regenerates `routes.md`.

## When NOT to trust this

- **After a long-running branch**: schema/routes may have moved. Regen the auto files.
- **After a refactor that touched MAP.md's territory**: verify by reading the actual code.
- **If MAP.md and the code disagree**: code wins. Update MAP.md.

The index is meant to save exploration time, not replace reading code.
