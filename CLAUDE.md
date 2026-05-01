# CLAUDE.md

## Version Control

当你接到新任务，在开始项目改造前，你应该先拉取最新的main版本然后创建新分支。

## Git & Commits

When asked to commit, just commit immediately. Do NOT enter plan mode, write plan files, or save insights to memory files. Keep git operations simple and direct.

在创建/更新PR时，你需要写PR描述，PR描述分两部分：面向产品经理和用户的说明（要求罗列清楚但精炼不啰嗦）、面向研发团队的项目工程改造说明（要求罗列清楚而且清晰）。

## Implementation Style
- Do not add fallback values, default behaviors, or extra fields that the user hasn't asked for. When in doubt, ask rather than adding unsolicited "improvements".

### Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## Testing

你不需要写test file，也不需要执行npm test相关测试操作。

## Architecture Guardrails

Understand the project architecture before making backend changes. The app uses Supabase — check existing table relationships before adding columns. Query existing linked data rather than adding redundant columns.


## Database数据库

在你迭代改造项目时，当涉及数据库的迁移或数据库的改造时，切记要做到数据的向前兼容，不要删改旧数据，但可以自由增加新数据、扩展schema、定义新表新接口等等。

如果需要检查/阅读/查询云端数据时，如果项目里已有supabase数据库的api key，你可以直接写SQL去云端找数据。