# CLAUDE.md

## Codebase Index — read first

非琐碎任务开工前先扫一眼 `.claude/index/`：

- **`.claude/index/MAP.md`** — feature → 文件/服务/表的导航地图，含"新东西该放哪一层"决策表
- **`.claude/index/glossary.md`** — 领域词表（lead vs inquiry、KB 四层、takeover、orchestrator 等）
- **`.claude/index/schema.md`** — 当前 DB 表/列/外键/索引快照（脚本生成）
- **`.claude/index/routes.md`** — 所有 API 端点 + UI 页面（脚本生成）

改了 schema 或加了路由后跑 `npm run index` 刷新自动产物。手写文件（MAP / glossary）在加新 feature 或改动较大时手动维护。

琐碎单文件改动可以跳过索引直接 grep。

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

**触发系统测试的两种场景**：
- 用户主动说"系统测试 / 完整测试 / 验收测试"或类似说法
- 单次迭代改造量较大（即使用户没说，你也应主动触发），命中以下任一条即可：
  1. 同时涉及 UI + 后端 API + 数据库中的 ≥2 项
  2. 跨 ≥3 个文件且分布在不同 feature 模块/页面
  3. 新增页面/路由
  4. 跨模块重构（一处改动会 ripple 到多个 consumer）

触发后按以下流程执行，**速度优先**：

1. **复用 dev server，不要重启**：先 `curl -sf http://localhost:3000 >/dev/null` 探活，活的直接用；未运行才以 `run_in_background` 启动 `npm run dev`。绝不在每次系统测试前重启。
2. **通过 Playwright MCP 驱动浏览器（headless）**，不要手动一步步点：
   - 范围聚焦本次改动覆盖的 golden path + 关键边界，**不做全站回归**
   - 用 auto-wait（locator 自带等待机制），禁止固定 sleep
   - 同一轮里一次性收集：页面控制台错误、失败网络请求（4xx/5xx）、未捕获异常
   - 多条独立流程并行触发，不要串行
3. **观察服务端日志**：从 dev server 的 background 输出里 grep 报错段，不要全量读
4. **失败才出产物**：trace/screenshot 仅在断言失败时保留；通过路径不留图、不留视频
5. **结论必须明确**："测了什么 / 看到什么 / 是否符合预期"；不通过给根因，不要只说"已启动"

视觉/品牌/排版评估（Playwright 看不出来的部分）走 §Frontend / UI / Interaction Self-Evaluation 单独截图肉眼判断，不混在系统测试里跑。

## Frontend / UI / Interaction Self-Evaluation

当对前端、UI、交互进行迭代开发改造时，完成实现后必须进行 self-evaluator 自评，依据以下四个维度打分并根据评估结果进行改进重做，直到达标为止：

1. **Design quality（设计品质）**：设计是否呈现为一个连贯的整体，而不是零散组件的堆砌？颜色、字体、版式、图像与其他细节是否共同营造出独特的氛围与识别度？
2. **Originality（原创性）**：是否有定制化设计决策的痕迹，而不是模板布局、组件库默认样式、或一眼能看出是 AI 生成的范式？人类设计师应能识别出刻意为之的创作选择。未经修改的现成组件、或典型 AI 生成痕迹（如白色卡片上的紫色渐变）不合格。
3. **Craft（工艺水准）**：技术执行细节——字体层级、间距一致性、配色和谐度、对比度。这是基本功检查，不是创造力检查。多数合理实现默认能通过；不通过意味着基本功出了问题。
4. **Functionality（可用性）**：抛开美学谈可用性。用户能否看懂这个界面是干什么的、找到主要操作入口、不靠猜就完成任务？

任何一项不达标就改进重做，不要把不合格的产物交付给用户。

## Architecture Guardrails

Understand the project architecture before making backend changes. The app uses Supabase — check existing table relationships before adding columns. Query existing linked data rather than adding redundant columns.


## Database数据库

在你迭代改造项目时，当涉及数据库的迁移或数据库的改造时，切记要做到数据的向前兼容，不要删改旧数据，但可以自由增加新数据、扩展schema、定义新表新接口等等。

如果需要检查/阅读/查询云端数据时，如果项目里已有supabase数据库的api key，你可以直接写SQL去云端找数据。