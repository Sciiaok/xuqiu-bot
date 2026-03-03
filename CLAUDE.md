# CLAUDE.md

## Git & Commits

When asked to commit, just commit immediately. Do NOT enter plan mode, write plan files, or save insights to memory files. Keep git operations simple and direct.

## Implementation Style

- When asked to implement a plan with numbered tasks/modules, execute the code changes. Do NOT spend time only reading and exploring files — produce working code. If exploration takes more than 2-3 file reads per task, pause and start implementing.
- Do not add fallback values, default behaviors, or extra fields that the user hasn't asked for. When in doubt, ask rather than adding unsolicited "improvements".

## Testing

When implementing tests, actually execute them (`npm test`, `npx jest`, etc.) — do not just perform static code review and report they "look correct". The user expects real test execution and output.

## Architecture Guardrails

Understand the project architecture before making backend changes. The app uses Supabase — check existing table relationships before adding columns. Query existing linked data rather than adding redundant columns.
