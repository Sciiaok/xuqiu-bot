# Session Skills Workflow — 2026-03-06

本次 session 完整实现了 Human Takeover & Multi-Agent 的 Playwright E2E 测试。以下是用到的 skills 及其在流程中的位置。

---

## 流程总览

```
写计划 → 开 worktree → 执行计划 → 调试测试 → 验证通过 → 合并分支
  ↑           ↑            ↑           ↑           ↑           ↑
writing    git-worktrees  executing  systematic  verification  finishing
-plans                    -plans     -debugging  -before-      -a-dev-
                                                 completion    branch
```

---

## 1. `superpowers:writing-plans`

**时机：** 在动代码之前，有 spec 或需求文档时

**本次使用：** 上一个 session 中，把 Human Takeover & Multi-Agent 功能的 E2E 测试需求写成了详细的分步计划文件 `docs/plans/2026-03-06-human-takeover-multi-agent.md`，包含：
- 每个 task 的目标文件路径
- 完整的代码片段（playwright.config.js、fixtures、spec 文件）
- 预期验证命令

**核心价值：** 把模糊的"写测试"需求变成可执行的 task 清单，后续 session 可以直接 execute 而不用再思考架构。

---

## 2. `superpowers:using-git-worktrees`

**时机：** 开始功能开发前，需要与当前工作区隔离时

**本次使用：** 整个功能开发（包括 12 个 feature commits）都在 worktree 中进行：
```
.claude/worktrees/human-takeover-multi-agent/
```
main 分支始终保持干净，worktree 完成后一键合并。

**核心价值：** 多个 feature 可以并行开发互不干扰；出问题直接丢弃 worktree 不影响主线。

---

## 3. `superpowers:executing-plans`

**时机：** 拿到写好的 plan 后，在独立 session 中执行

**本次使用：** 本 session 直接接收上一 session 产出的计划，逐 task 执行：
1. 安装 `@playwright/test` + chromium
2. 修改 `middleware.js` 加 auth bypass
3. 创建 fixtures（mock-data.js、supabase-mock.js）
4. 创建 3 个 spec 文件
5. 运行测试、修复、再运行

用 `TaskCreate` 追踪每个 task 的状态（pending → in_progress → completed）。

**核心价值：** plan 和 execute 分离，执行时只需关注代码落地，不用反复决策架构。

---

## 4. `superpowers:systematic-debugging`

**时机：** 遇到 bug、测试失败、意外行为时，在提 fix 之前

**本次使用：** 33 个测试初次运行有 19 个失败。调试过程：

**第一层：看截图定位现象**
- 截图显示 inbox 一直是"No contacts found"
- agents 页面显示正常

**第二层：写 debug 测试输出所有请求**
```js
// tests/e2e/debug.spec.js
page.on('request', req => urls.push(req.url()));
```
发现请求确实到达了 `http://localhost:54321/rest/v1/conversations`，返回 200，但页面仍无数据。

**第三层：分析 mock 响应内容**
发现 handler 逻辑有 bug：
```js
// BUG: 'contact_id' 同时出现在完整查询的 select 子句里
if (url.includes('contact_id')) { return ids only }  // ← 错误匹配了完整列表查询

// FIX: 只有 filter 参数才有 '=eq.'
if (url.includes('contact_id=eq.')) { return ids only }  // ← 正确
```

**核心价值：** 不凭感觉猜，先用工具确认"请求有没有发出去"、"响应是什么"，再定位到具体代码行。

---

## 5. `superpowers:verification-before-completion`

**时机：** 准备宣布"完成"之前，提交或创建 PR 之前

**本次使用：** 修完 bug 后不直接宣布完成，而是：
1. 第一次运行：33/33 ✅
2. 第二次运行（确认无 flakiness）：33/33 ✅
3. 清理 test-results 目录后再合并

命令：
```bash
npx playwright test --reporter=list   # 第一次
npx playwright test --reporter=list   # 第二次确认
```

**核心价值：** "looks correct" ≠ "is correct"。用实际输出作为 evidence，而不是代码审查。

---

## 6. `superpowers:finishing-a-development-branch`

**时机：** 实现完成、测试通过后，决定如何集成工作

**本次使用：**
```bash
# 在 worktree 中提交
git add middleware.js package.json playwright.config.js tests/
git commit -m "test: add Playwright E2E tests..."

# 切回 main 合并
git checkout main
git merge worktree-human-takeover-multi-agent --no-edit  # fast-forward

# 同步远端
git pull --rebase origin main
```

**核心价值：** worktree 开发完成后有标准化的收尾流程，不会遗漏提交、不会产生 merge commit 噪音。

---

## 关键经验

| 问题 | 根因 | 解法 |
|------|------|------|
| 测试全部失败，contacts 不加载 | supabase mock 的 URL 写死了 `localhost:54321`，但 `.next` 缓存里内嵌的是生产 URL | 改用 `**/rest/v1/*` glob 匹配任意 Supabase host |
| contacts 加载后仍为空 | `url.includes('contact_id')` 误匹配了 `select` 子句 | 改为 `url.includes('contact_id=eq.')` 精确匹配 filter 参数 |
| 单独运行某个测试时 404 | Next.js dev server 冷启动时页面未编译，首次访问需要等待 | 完整跑全套测试（server 已预热），不单独隔离运行 |
