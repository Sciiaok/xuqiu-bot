# Lead Engine

基于 Next.js 14 + Supabase 的 WhatsApp 询盘处理与广告投放平台。后端串接 Meta Marketing API、Claude (via OpenRouter)、Redis 队列；前端是投放 / 客户中心 / 询盘 / 数据看板一体的运营面板。

---

## 一、代码结构

```
LeadEngine/
├── app/                    # Next.js App Router（前端 + API routes）
│   ├── (app)/              # 受保护页面（需登录）
│   │   ├── analytics/      # 数据看板
│   │   ├── reports/        # AI 报告
│   │   ├── agents/         # 智能体管理
│   │   ├── ai-automation/  # AI 自动化投放
│   │   ├── campaign-studio/# 广告数据 / 创意 pipeline
│   │   ├── leadhub/        # 询盘
│   │   ├── inbox/          # 客户中心 / 对话
│   │   ├── knowledge-base/ # 知识库
│   │   ├── layout.js       # 受保护区域布局（含 Sidebar）
│   │   └── page.js         # 根路由，重定向到 /analytics
│   ├── (auth)/             # 未登录可见
│   │   ├── login/          # /login
│   │   └── layout.js
│   ├── api/                # API Route Handlers
│   │   ├── ads/            # Meta Ads 查询 / 同步
│   │   ├── agents/         # Agent CRUD / 运行
│   │   ├── campaign/       # 投放编排 SSE
│   │   ├── contacts/       # 联系人
│   │   ├── conversations/  # 对话 / takeover
│   │   ├── cron/           # 给 PM2 cron 调用的内部接口
│   │   ├── inquiries/      # 询盘筛选 / 导出
│   │   ├── knowledge/      # 知识库搜索 / 上传
│   │   ├── leads/          # 线索 CRUD / 同步
│   │   ├── media/          # WhatsApp 媒体代理
│   │   ├── product-assets/ # 产品素材
│   │   ├── product-docs/   # 产品文档
│   │   ├── reports/        # 报告生成 / 导出
│   │   ├── send-message/   # 发送 WhatsApp 消息
│   │   └── webhook/        # WhatsApp Cloud API webhook
│   ├── components/         # 前端共享组件（Sidebar、Card、DataTable 等）
│   ├── layout.js           # 根布局（语言、Theme）
│   ├── page.js             # 根路由 → /analytics
│   ├── globals.css
│   └── v5-theme.css
│
├── src/                    # 后端服务（业务逻辑，被 API routes 调用）
│   ├── config.js           # 集中式环境配置
│   ├── claude.service.js   # Claude LLM 客户端
│   ├── llm-client.js       # 通用 LLM 抽象
│   ├── whatsapp.service.js # WhatsApp Cloud API 封装
│   ├── whatsapp-media.service.js
│   ├── whisper.service.js  # 音频转写
│   ├── feishu.service.js   # 飞书通知
│   ├── agent-router.service.js       # 智能体路由（用哪个 agent 处理）
│   ├── agent-runtime.service.js      # 智能体运行时（单轮 / 多轮推理）
│   ├── routing.service.js            # 后置路由动作（FAQ 回复 / 飞书推送）
│   ├── campaign-intake.service.js    # 广告需求采集
│   ├── campaign-orchestrator.service.js  # 广告投放全流程编排
│   ├── research-agent.service.js     # 市场调研 agent (v1)
│   ├── research-agent-v2.service.js  # 市场调研 agent (v2)
│   ├── strategy-agent.service.js     # 策略 agent
│   ├── creative-plan.service.js      # 创意规划
│   ├── execution-agent.service.js    # 投放执行 agent
│   ├── aigc.service.js               # 图片生成
│   ├── meta-account.service.js       # Meta 账号 / 广告结构
│   ├── meta-ads-mcp-client.js        # MCP 客户端
│   ├── kb-*.service.js               # 知识库搜索 / 上传 / 导入 / 自学
│   ├── product-knowledge.service.js
│   ├── product-search.service.js
│   ├── reference-collector.service.js
│   ├── inquiry-quality.js
│   └── scoring-rules.json
│
├── lib/                    # 通用工具 / 仓储层（前后端共用）
│   ├── supabase.js                 # 匿名 client（只读 public）
│   ├── supabase-browser.js         # 浏览器端 SSR client
│   ├── supabase-server.js          # 服务端 SSR client（带 auth / demo）
│   ├── redis.js                    # Redis (ioredis) 单例
│   ├── session.js                  # 会话管理
│   ├── sse.js                      # SSE server 工具
│   ├── consume-sse.js              # SSE client 工具
│   ├── demo-mode.js                # Demo 模式守卫
│   ├── i18n-utils.js
│   ├── core-trace.js               # 链路追踪
│   ├── queue-processor.js          # 消息队列处理器
│   ├── inquiries-filters.js        # 询盘筛选常量 / 标签 / 排序
│   ├── inquiry-dashboard.js        # 询盘看板聚合
│   ├── lead-extractor.js           # 从对话提取线索
│   ├── conversation-context.service.js
│   ├── agent-routing.service.js    # 对话层的 agent 分派
│   ├── referral-context.js
│   ├── car-catalog-context.js
│   ├── country-codes.js            # ISO 国家代码
│   ├── phone-country-prefixes.js   # 电话前缀 → 国家
│   ├── wa-country.js               # WhatsApp 号码归属
│   ├── repositories/               # 数据访问层（Supabase 封装）
│   ├── services/                   # 轻量业务服务
│   └── __tests__/
│
├── scripts/                # 运维 / cron / 一次性脚本
│   ├── deploy.sh                   # 部署脚本（打包 → scp → 远程 build → pm2 restart）
│   ├── cron-sync-leads.js          # 定时同步线索（PM2 服务）
│   ├── cron-process-queue.js       # 定时处理消息队列（PM2 服务）
│   ├── cron-generate-reports.js    # 定时生成报告（PM2 服务）
│   ├── cron-recover-orchestrator.js# 定时恢复 orchestrator（PM2 服务）
│   ├── seed-*.js                   # Seeds（默认 agent、demo 数据）
│   └── ...                         # 其它调试 / 迁移脚本
│
├── tests/                  # 测试
│   ├── unit/               # 单元测试（vitest）
│   ├── integration/        # 集成测试（连真 API / Supabase）
│   ├── stability/          # 稳定性测试
│   ├── eval/               # LLM 评估用例
│   └── *.mjs               # 调试脚本
│
├── supabase/               # Supabase 本地 config + SQL migrations
│   └── migrations/         # 按编号命名的 DDL 文件
│
├── i18n/                   # next-intl 配置
├── messages/               # i18n 翻译资源
├── public/                 # 静态资源
├── docs/                   # 设计文档 / 发布笔记 / 想法池
│
├── middleware.js           # Supabase auth / locale 中间件
├── next.config.js
├── ecosystem.config.cjs    # PM2 进程配置
├── package.json
├── CLAUDE.md               # AI 协作约定
└── README.md
```

### 关键架构点

- **Next.js App Router**：`app/(app)` 是路由分组（URL 里不出现 `(app)`），用来共享 layout；`app/(auth)` 同理。
- **双层后端**：`src/` 放"重业务"服务（调 LLM / Meta API / WhatsApp），`lib/` 放前后端共用的轻量工具和数据仓储。API routes 只做参数校验 + 调用 `src/` 服务。
- **鉴权**：`middleware.js` 只保护 `(app)` 下的页面，`/login` 不受保护；所有 API 路由在各自 handler 里通过 `createClient()` 取当前 user。
- **PM2 常驻进程**：Next.js 主进程 + 4 个 cron 工作进程，见 `ecosystem.config.cjs`。
- **Redis**：用于消息队列、广告看板缓存（60 min TTL）、SSE 进度缓存等，所有访问统一走 `lib/redis.js`。
- **Supabase**：所有表结构在 `supabase/migrations/` 按编号演进，改 schema 必须新建 migration 文件，不直接在控制台手改。

---

## 二、开发 / 测试 / 发布规范

### 环境准备

```bash
# 1. Node.js 20 LTS（24 未验证，低于 18 跑不起来）
node -v

# 2. 安装依赖
npm install --legacy-peer-deps

# 3. 准备环境变量
cp .env.demo .env.local   # 然后按需填入真实 key
```

关键环境变量（完整列表见 `src/config.js`）：

| 变量 | 说明 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase 客户端 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 服务端（后端用，不要暴露） |
| `OPENROUTER_API_KEY` 或 `ANTHROPIC_API_KEY` | LLM |
| `WA_TOKEN` / `WA_PHONE_NUMBER_ID` / `WA_VERIFY_TOKEN` | WhatsApp Cloud API |
| `META_SYSTEM_TOKEN` / `META_AD_ACCOUNT_ID` / `META_PAGE_ID` | Meta Marketing API |
| `REDIS_URL` | Redis 连接串 |
| `DEMO_MODE` | `true` 时跳过登录直接进应用 |

### 本地开发

```bash
npm run dev        # 起 Next.js dev server，端口 3002
```

浏览器打开 http://localhost:3002 —— 根路由会自动跳转到 `/analytics`。

需要本地跑 cron 服务时：

```bash
npm run cron:start   # lead-sync
npm run queue:start  # queue processor
```

### 编码规范

- **路径引用**：API routes / 页面之间尽量用相对路径；`src/` 服务从自身相对导入即可。
- **不要在 `app/api/*` 写复杂业务**：长逻辑放 `src/`，route handler 只做入参校验 / 调用 / 拼响应。
- **不要在 `src/` 里 `import` React / Next**：`src/` 必须对 runtime 中立，能被脚本和 API 同时调用。
- **改数据库 schema**：新建 `supabase/migrations/NNN_xxx.sql`，不要修改已提交的 migration。
- **新增表字段前先查现有表关系**（见 `CLAUDE.md`）：能用 join 就不要加冗余列。
- **不添加用户没要求的 fallback / 默认值 / 额外字段**（见 `CLAUDE.md`）。

### 测试

```bash
npm test                  # vitest 全部单测（无需外部依赖）
npm run test:webhook-tdd  # webhook / 多模态关键路径 TDD 套件
```

集成测试（需要真实 `.env.local`，会调外部 API，默认不在 CI 跑）：

```bash
node tests/integration-orchestrator.mjs
node tests/integration-aigc.mjs
# ... 其它 tests/integration-*.mjs / tests/e2e-*.mjs
```

规范：

- **单测必须真跑**，不能只做静态 review 就说 "looks correct"（见 `CLAUDE.md`）。
- 新功能至少配一个单测 / 集成测试用例。
- 改动 `src/` 服务时，对应 `tests/unit/*.test.js` 要跑通。
- 涉及 LLM 输出的用 `tests/eval/` 的 eval runner，不要硬断言具体文本。

### 发布

1. **本地自检**
   ```bash
   npm run build   # 必须 0 error 才能部署
   npm test
   ```

2. **提交代码**
   ```bash
   git add -p
   git commit -m "feat(xxx): ..."
   git push
   ```

3. **部署到生产（AWS EC2）**
   ```bash
   npm run deploy
   ```
   这会执行 `scripts/deploy.sh`：打包 → scp 到服务器 → 远程解压 → `npm install --legacy-peer-deps` → `npm run build` → `pm2 restart` 所有服务。

4. **验证**
   - 打开 `http://<elastic-ip>:3002/analytics` 看页面
   - `ssh aws-leadengine "pm2 status"` 查进程状态
   - `ssh aws-leadengine "pm2 logs lead-engine-next --lines 50"` 查日志

### 回滚

`deploy.sh` 本身不带回滚。要回滚：

```bash
git revert <bad-commit>     # 或 git reset 到已知好版本
git push
npm run deploy
```

紧急情况可 ssh 到服务器 `pm2 stop <service>` 立刻停服务。

### Git 约定

- 分支命名：`feat/xxx`、`fix/xxx`、`ui/xxx`、`perf/xxx`、`chore/xxx`
- Commit message 用 Conventional Commits（`feat:` / `fix:` / `perf:` / `refactor:` / `docs:` / `chore:`）
- **不要 `--no-verify` 跳过 hooks**；hook 报错先修问题再重提
- **不要 force push 到 `main`**

---

## 三、其它参考

- `CLAUDE.md` — AI 协作 / 实现风格约束
- `docs/` — 设计文档 / 发布笔记
- `ecosystem.config.cjs` — PM2 服务定义
- `middleware.js` — 受保护路由列表
