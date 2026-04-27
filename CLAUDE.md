# CLAUDE.md

## Git & Commits

When asked to commit, just commit immediately. Do NOT enter plan mode, write plan files, or save insights to memory files. Keep git operations simple and direct.

在创建/更新PR时，你需要写PR描述，PR描述分两部分：面向产品经理和用户的说明（要求罗列清楚但精炼不啰嗦）、面向研发团队的项目工程改造说明（要求罗列清楚而且清晰）。

## Implementation Style
- Do not add fallback values, default behaviors, or extra fields that the user hasn't asked for. When in doubt, ask rather than adding unsolicited "improvements".

## Testing

你不需要写test file，也不需要执行npm test相关测试操作。

## Architecture Guardrails

Understand the project architecture before making backend changes. The app uses Supabase — check existing table relationships before adding columns. Query existing linked data rather than adding redundant columns.


## Database数据库

在你迭代改造项目时，当涉及数据库的迁移或数据库的改造时，切记要做到数据的向前兼容，不要删改旧数据，但可以自由增加新数据、扩展schema、定义新表新接口等等。