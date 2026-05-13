# CLAUDE.md

## Codebase index — read first

Before starting any non-trivial task, skim `.claude/index/`:

- **`.claude/index/MAP.md`** — feature → files / services / tables navigation map, including a "where does new code go" decision table.
- **`.claude/index/glossary.md`** — domain vocabulary (lead vs. inquiry, KB four layers, takeover, orchestrator, etc.).
- **`.claude/index/schema.md`** — current DB tables / columns / foreign keys / indexes snapshot (script-generated).
- **`.claude/index/routes.md`** — all API endpoints and UI pages (script-generated).

After changing schema or adding routes, run `npm run index` to refresh the generated artifacts. Hand-written files (MAP, glossary) are maintained manually when adding a new feature or making larger changes.

Trivial single-file edits can skip the index and grep directly.

## Starting a new task

Before touching any files, pull the latest `main` and branch off it. Never work
directly on `main` or on a stale branch.

```bash
git checkout main
git pull --ff-only origin main
git checkout -b feat/<short-description>
```

## Implementation style

### Think before you code

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations of the request are reasonable, surface them —
  don't silently pick one.
- If a simpler approach exists, say so. Push back when the framing pulls
  toward over-engineering.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" the user didn't request.
- No error handling for scenarios that can't happen.
- No fallback values, default behaviors, or extra fields the user didn't
  ask for. When in doubt, ask before adding unsolicited "improvements."
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: would a senior engineer call this overcomplicated? If yes,
simplify.

### Surgical changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken.
- Match existing style even if you'd do it differently.
- Notice unrelated dead code? Mention it — don't delete it unless asked.

When *your* changes leave imports / variables / functions orphaned, remove
them. Pre-existing dead code stays.

The test: every changed line should trace directly to the user's request.

### Parallel-first

**Independent steps run together. Serial only when there's a real dependency.**

Before starting a task, identify which steps have no data dependency on each
other and dispatch them in a single message instead of chaining them.

**Run in parallel:**

- The four `.claude/index/` files at task start — one message, four `Read`
  calls.
- Independent greps, finds, or file reads across the codebase.
- Cross-module exploration (frontend + backend + schema) — spawn several
  `Explore` subagents in one message, each scoped to one area.
- Edits to unrelated files — issue the `Edit` calls together.
- Read-only verification probes (`curl` healthcheck, log greps, `git status`)
  and independent Playwright flows during a system test.

**Run serially:**

- Real data dependencies (step B consumes step A's output).
- Multiple edits to the same file.
- Git write operations (commit, push, rebase).
- Dev server startup before browser-driven tests.

**Don't over-fragment.** Subagent startup and context loading have overhead.
For trivial lookups, a direct tool call beats spinning up an agent. Match the
granularity of parallelism to the size of the work.

## Architecture & database

**Understand before you change.** This project runs on Supabase. Before adding
columns to a table, check existing table relationships — query the linked data
rather than duplicating it into a new column.

**Forward compatibility.** When a change involves migrations or schema work,
preserve existing data: never delete or rewrite old rows. Adding new data,
extending the schema, defining new tables / endpoints — all fair game.

**Direct DB access for inspection.** When you need to read cloud data, the
Supabase API key is already in `.env.local`. Write SQL directly against the
cloud DB rather than scaffolding a route just to read.

## Git & commits

When asked to commit, commit immediately. Don't enter plan mode, write plan
files, or save insights to memory. Keep git operations direct.

**Pull request descriptions** have two sections:

1. **For PMs and users** — list changes clearly but concisely, no fluff.
2. **For engineering** — files touched, architectural decisions, compatibility
   notes, test coverage. Clear and well-organized.

## Testing

**Don't write test files. Don't run `npm test` or similar.**

### When to run a system test

Run one when either condition holds:

- The user explicitly asks ("系统测试 / 完整测试 / 验收测试" or similar).
- A single iteration is large enough that any of these are true — run it
  proactively even if the user didn't ask:
  1. Touches ≥2 of: UI, backend API, database.
  2. Spans ≥3 files across different feature modules / pages.
  3. Adds a new page or route.
  4. Is a cross-module refactor (one change ripples to multiple consumers).

### How to run it — speed first

1. **Reuse the dev server.** Probe with `curl -sf http://localhost:3000 >/dev/null`;
   if it answers, use it. Only start `npm run dev` (with `run_in_background`)
   when it isn't running. Never restart it before a system test.
2. **Drive the browser via Playwright MCP, headless.** No step-by-step manual
   clicking.
   - Scope: the golden path and key edges of *this iteration's* changes. No
     full-site regression.
   - Use locator auto-wait. No fixed `sleep` calls.
   - In one pass, collect: console errors, failed network requests (4xx/5xx),
     uncaught exceptions.
   - Run independent flows in parallel, not in series.
3. **Tail the dev server log** with `grep` for error patterns. Don't read the
   full log.
4. **Keep artifacts only on failure.** Traces and screenshots persist when
   assertions fail; on a passing path, leave nothing behind.
5. **Conclude explicitly:** what was tested, what was observed, whether it
   matched expectations. On failure, give the root cause — never just "it
   started."

Visual / brand / typographic judgement (the kind Playwright can't see) goes
through frontend self-evaluation below — separate screenshots, judged by eye.
Don't fold it into the system test.

## Frontend self-evaluation

After any frontend / UI / interaction iteration, evaluate the result against
the four dimensions below and iterate until each passes. Don't deliver a
failing result to the user.

- Design quality: Does the design feel like a coherent whole rather than a collection of parts? Strong work here means the colors, typography, layout, imagery, and other details combine to create a distinct mood and identity.
- Originality: Is there evidence of custom decisions, or is this template layouts, library defaults, and AI-generated patterns? A human designer should recognize deliberate creative choices. Unmodified stock components—or telltale signs of AI generation like purple gradients over white cards—fail here.
- Craft: Technical execution: typography hierarchy, spacing consistency, color harmony, contrast ratios. This is a competence check rather than a creativity check. Most reasonable implementations do fine here by default; failing means broken fundamentals.
- Functionality: Usability independent of aesthetics. Can users understand what the interface does, find primary actions, and complete tasks without guessing?

If any dimension fails, iterate. Don't ship a failing artifact.
