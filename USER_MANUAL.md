# LeadEngine · 平台租户使用手册

> 适用对象：注册后的 LeadEngine 租户（founder）
> 适用版本：2026-05-17 主干
> 配套：[README.md](README.md)（架构）/ [medici-design.md](medici-design.md)（接待 Agent 设计）/ [ogilvy-design.md](ogilvy-design.md)（投放 Agent 设计）

---

## 0. 平台是什么

LeadEngine 帮你把"**Meta 投放 → WhatsApp 接待 → 线索沉淀**"全链路自动化：

```
你做的:        平台做的:
─────────      ─────────────────────────────────────
连接 Meta  →   Ogilvy 帮你策划 + 生成素材 + 一键投放 CTW 广告
建知识库   →   Medici 在 WhatsApp 上接待客户、抽线索、转人工
看报表     →   AI 自动写日报 / 周报 / 月报
```

平台核心理念：**你只需要做"配置 + 审阅"，对话、抽线索、上线投放全部由 AI 完成。**

---

## 1. 快速上手（首次登录的 10 分钟）

注册成功后，左上角 onboarding 卡片会显示 6 个里程碑——按顺序走完即可：

| 步骤 | 做什么 | 在哪里 |
|---|---|---|
| 1 | 账号已创建 | （注册即完成） |
| 2 | 连接 Meta Business Manager | `/settings/meta-connection` |
| 3 | 创建第一条产品线 | `/product-lines` → 新建 |
| 4 | 配置产品线（字段、价值规则、知识库） | `/product-lines/[id]` |
| 5 | 上传知识库文件 | 产品线详情页 → 知识库 tab |
| 6 | 收到第一条客户 WhatsApp 消息 / AI 自动回复 | （来自客户） |

完成 4 个就可以开始接待真实客户；继续解锁 5、6 是为了让 AI 有内容可答 + 看到第一条 lead。

---

## 2. 连接 Meta Business Manager

**进入**：`/settings/meta-connection`

**为什么**：让平台能读取你的 WABA（WhatsApp Business Account） + 广告账户 + Page；之后所有"接待 / 投放"动作都用这把钥匙。

**流程**：

1. 在 Meta 系统用户面板生成一个 **System User Token**（权限至少含 `whatsapp_business_messaging` / `whatsapp_business_management` / `ads_management` / `business_management` / `pages_show_list` / `pages_messaging`）
2. 在 LeadEngine `/settings/meta-connection` 粘贴 token → 点 "预览"
3. 平台会列出你 BM 下的所有 WABA / 号码 / 广告账户 / Page
4. 确认无误 → 点 "连接"
5. token 会**信封加密**后存进数据库（明文不落库）；平台再做一次健康检查，绿灯就连成功了

**断开 / 重连**：同页面右上角；断开后所有 webhook 入站会被静默丢弃直到重连。

**到期 / 失效**：cron `meta-health-check` 周期跑；token 出问题会在 Banner 上提示。

---

## 3. 建第一条产品线

**概念**：产品线（Product Line）是 LeadEngine 的核心调度单位——一条产品线 = 一个 WhatsApp 号 + 一套知识库 + 一套线索字段 + 一组 AI 行为参数。同一个 Meta BM 下可以挂多条产品线（每条用不同号码）。

**进入**：`/product-lines` → 右上角 "新建"

**新建表单**：

- **产品线 ID（slug）**：英文小写 + 下划线，例 `motorcycles_kenya`
- **产品线名称**：展示用，例 "Kenya 摩托车"
- **绑定 WhatsApp 号码**：从下拉里选——只能选你在 Meta 那边能用的号；同一个号一次只能挂一条产品线

保存后跳到详情页 `/product-lines/[id]`。

---

## 4. 配置产品线

产品线详情页有 4 个 tab：

### 4.1 基本

- 产品线名称
- 描述（可选，主要给你自己看；目前不进 Prompt）

### 4.2 价值判定（business_value_guidance）

一段自然语言描述，告诉 Medici **如何判断客户 `business_value` 是 LOW / AVERAGE / HIGH**。例：

```
- HIGH: 客户提到 >20 辆订单 / 公司是经销商 / 提到稳定的月采购需求
- AVERAGE: 5-20 辆 / 个人购买为打工或租赁车队
- LOW: 1-2 辆 / 个人自用 / 仅询价没有明确数量
```

这段会进 Medici 的动态 system prompt（per-line cache 段）。

### 4.3 字段表（lead_fields）

这是 Medici **抽线索的 schema**。每行一个字段：

| 列 | 含义 |
|---|---|
| key | 程序键（snake_case，例 `destination_country`） |
| label | 展示名（"目的国家"） |
| description | 给 AI 看的说明（怎么识别 / 例子） |
| type | text / number / enum / boolean / array |
| required_for | 必填 tier：`GOOD` / `QUALIFY` / `PROOF` / 留空（永不必填） |
| display_order | 显示顺序 |

**Tier 含义**（决定 `inquiry_quality`）：

- **GOOD**：客户表达了明确意图，需要的最小字段集（一般是"产品名 + 目的国"）
- **QUALIFY**：商务有效线索，需要的字段集（一般是 "公司 + 数量 + 时间预算"）
- **PROOF**：可下单的字段集（一般是 "已确认型号 + 商务条款 + 付款意向"）

**报价闸口**：Medici 在 KB 工具层有一道硬闸——**没到 QUALIFY 的客户看不到价格**。这一条由字段表 + tier 自动驱动，不用单独配置。

### 4.4 知识库（KB）

详见下一节。

---

## 5. 知识库（最重要的功能）

知识库是 Medici **能答好客户问题**的根基。结构 4 层：

```
kb_documents（原始文件，比如一份 Excel SKU 报价单）
    │
    ├─► kb_products（结构化产品行）
    ├─► kb_shipping_routes（运费 / 时效行）
    ├─► kb_knowledge_points（原子 Q&A 知识点）
    ├─► kb_assets（图 / 文档 / 资料）
    └─► kb_pricing_rules（动态计价规则）
```

外加：

- `kb_qa_snippets`：你自己手写的 Q&A 片段（带 embedding，回答常见问题最快）
- `kb_knowledge_gaps`：客户问过但 KB 答不上来的问题清单
- `kb_corrections`：你审核 AI 回复后的纠正
- `kb_pending_review`：抽取出来与既有数据冲突 / 不确定的内容，等你审批

### 5.1 上传文件

进知识库 tab → 拖入或点上传：

- 支持：PDF / Word / Excel / 图片 / 文本
- 上限单文件几十 MB（具体看 `next.config.js` `proxyClientMaxBodySize`）

上传流程是**流式 + 异步**的：

1. 文件落 storage、写 `kb_documents` (status=pending)，UI 立刻看到一行
2. 服务端后台跑解析（Excel 走 80 行/片 chunked LLM 抽取；其它格式单次 600K 字符上限）
3. 抽出来的内容入库；状态变化通过 SSE 实时推到 UI

**`status` 解读**：

- `pending`：刚上传，未开始处理
- `processing`：解析中
- `indexed`：成功
- `partial`：内容截断（超过 600K 字符上限） — 列表里会显示，点 "重新解析" 可重试
- `failed`：错；hover 看 `error_message`

### 5.2 查看抽取结果

- 文档列表：每行展示 `knowledge_points_count`、`layer`、状态
- 点单个文档 → 看抽出来的产品 / 路线 / 知识点列表
- 不准确？点 "纠正" → 写一条 `kb_corrections`，下次答这个问题用你写的版本

### 5.3 QA Snippets（最快路径）

`/knowledge/qa-snippets` 是手写的"问 → 答"片段。Medici 接到客户消息时会**优先**做 QA 语义搜索；命中就直接用 snippet 答（不走 LLM 重组）。

适合：

- 常被问 + 答案稳定的问题（"你们出口资质 / 公司背景 / 售后流程 / 付款方式"）
- 答案要求逐字（合规话术 / 法律免责 / 品牌口径）

### 5.4 资产（图片 / 视频）

`kb_assets` 表里每条资产可以打标签：

- `asset_type`：product_image / spec_sheet / quotation_template / certificate / brochure / other
- `view` / `color` / `scenario`：图片细分维度
- `linked_skus`：这张图对应哪些 SKU
- `is_sendable`：是否允许 Medici 主动发给客户

资产从 KB 文档自动抽取（PDF 图片块 / Excel 嵌入图 / 单独上传），抽完会进**待审批**——你确认 SKU / view / scenario 后再发布。

**客户问"能不能发张图"** → Medici 从 AVAILABLE ASSETS 里挑一个 `asset_id` 挂到回复里，平台自动作为单独 WhatsApp 消息发出去。配置 `linked_skus` 越准，匹配越精确。

### 5.5 知识缺口（Gaps）

`/knowledge/gaps`：客户问了但 KB 答不上的问题汇总。

- AI 工具返回 `not_found` / `needs_human` / `unknown` 时自动记一条
- 同一句问题（按 `question_signature` 归一）会累积 `occurrence_count`
- 处理方式：
  - 点 "教 KB" → 用你的回答写一条 `kb_knowledge_points` 或 `kb_corrections`
  - 标记 "已解决"

这是你长期迭代 KB 的最大入口——**看 Gaps 知道补什么 KB 最值钱**。

### 5.6 待审批（Pending Review）

新抽出来的内容跟既有数据冲突 / 抽取置信度不够时不会直接进知识库，而是先落 `kb_pending_review`：

- 你看到 "新版本 vs 旧版本" 的对比
- 选 "采纳新的"（覆盖） / "保留旧的"（拒收） / "合并" / "另存为新条目"

### 5.7 Medici 模拟器

产品线详情页内嵌一个 chat 面板——直接在 UI 跟 Medici 聊，验证你刚配的字段表 / 价值规则 / 知识库是否符合预期。**所有调用都走和真实 WhatsApp 一样的路径**——同一个 Medici、同一个 KB、同一个 prompt，只是不发出去。

---

## 6. LeadHub（询盘收件箱）

**进入**：`/leadhub`

布局：**左侧询盘列表 + 右侧详情面板（4 tab）**。

### 6.1 列表

每张卡片显示：

- 客户头像 / 名字 / 国家旗
- 最近一条消息预览
- inquiry_quality 角标（BAD / GOOD / QUALIFY / PROOF）
- business_value 角标（LOW / AVG / HIGH）
- 路由状态（CONTINUE / FAQ_END / HUMAN_NOW）

筛选：

- 路由状态
- 询盘质量
- 时间范围
- 产品线

### 6.2 详情：4 个 tab

- **chat**：完整对话流（按天分组）；客户消息 + AI 回复 + 人工接管时你发的消息 + 系统事件
- **notes**：自由备注（CRM 卡片）；增删改全部走 `/api/contacts/[id]/notes`
- **inquiry-details**：抽出来的 lead 字段；可以编辑 / 标审批 / 改质量等级
- **timeline**：所有动作时间线（接管 / 释放 / 同步外部系统 / Feishu 推送等）

### 6.3 人工接管 / 释放

- 点 "接管" → `conversations.is_human_takeover=true`，AI 暂时不再回复；你可以在 chat 里直接输入回复 → 平台调 WhatsApp 出站
- 点 "释放" → AI 立刻接回
- 默认接管 TTL（2 小时）到点自动释放（cron `release-takeovers`）

### 6.4 审批 lead

- 点 lead 卡片上的 "审批" → `leads.approved=true`、`approved_at=now`、`approved_by=<你>`
- 审批后的 lead 会被 `cron sync-leads` 同步到外部 SCM（如果你接入了 REVO 等系统）

---

## 7. Ogilvy（广告策划与一键投放）

**进入**：`/ogilvy`

### 7.1 前置条件

进页面会先做一个"WhatsApp Gate"检查：

| 状态 | 含义 | 你要做的 |
|---|---|---|
| `ok` | 至少有 1 个可用号码 | 直接开聊 |
| `only_test_or_unverified` | 只有测试号 / 未验证号 | 去 Meta 升级正式号 |
| `no_phone` | BM 下没号 | 去 Meta 加号 |
| `not_configured` | 还没连 BM | 回 `/settings/meta-connection` |

### 7.2 新建会话

点 "新建" → 选 product_line（必须是已绑定 WA 号的）→ 进入 chat。

### 7.3 对话流程

用中文跟 Ogilvy 说你的需求，例：

```
我要把我们 50cc 的农用摩托卖到肯尼亚，预算 $50/天，目标客户是小农户。
帮我做个 Meta CTW 的投放方案。
```

Ogilvy 会按 6 个阶段推进：

| 阶段 | 你看到的 | 你要做的 |
|---|---|---|
| 1.0 需求收集 | AI 问你产品 / 市场 / 预算 / 区域细节 | 老老实实回答（不确定就说不确定） |
| 1.5 决策辅助 | AI 调 web_search / read_webpage 做调研后给你建议 | 看完认可 / 调整方向 |
| §4.C 规则查询 | AI 查 Meta 当前对目标市场的合规约束（禁词、年龄、预算上下限） | 看 |
| 2 市场分析 | 10 章左右的市场报告（TAM/SAM/竞品） | 看 / 留 / 改 |
| 3 广告策略 | 受众画像 + 创意切角 + 文案 pillars | 看 / 改 |
| 4 素材生成 | 上传你的产品图 → AI 同时画 N 张广告图 + headline | 看 / 重生成 |
| 5 执行方案 | plan_json 雏形 + 完整操作手册 | 看 |
| 6 蒸馏 | 你说 "确认方案" → AI 蒸馏成单 CTW campaign | 点 "启动投放" |

中间任何节点都可以打断、改方向；长产出会被自动归档到右侧"已存档产出"时间线，省 context 又方便回看。

### 7.4 上传产品图

阶段 4 开始前必须上传至少一张产品参考图（用来做生成图的视觉锚）。点输入框旁的回形针图标。

### 7.5 一键投放

点方案卡上的 **"启动投放"** 按钮：

1. **stage 阶段**（创建，全部 **PAUSED**）：
   - 创建 campaign（CBO，daily_budget 你设定的）
   - 按 targeting.countries 切多个 ad_set
   - 上传素材图到 Meta
   - 创建 ad creative + ad
2. **activate 阶段**（自顶向下 PATCH **ACTIVE**）：
   - 先 campaign，再 adset，再 ad

中间出错会保持 PAUSED 状态——你可以到 Meta 后台手动启或修。

成功后：

- 会话 status=`launched`
- `autopilot_sessions.meta_campaign_ids` 落下所有创建的对象 ID
- 客户从此广告点进来的 WhatsApp 会话，**自动由 Medici 接待**
- 客户点击进来的会话 `conversations.meta_ad_id` 会落下广告 ID，做归因

### 7.6 看花了多少钱

会话顶端 "UsageBadge" 显示当前会话累计 LLM token / 成本。
全平台口径在 `/admin/llm-usage`（仅 founder）。
广告花费看 Campaign Studio（下一节）。

---

## 8. Campaign Studio（广告数据）

**进入**：`/campaign-studio`

只读看板，从 Meta Graph API 实时拉广告 / adset / ad 的花费、展示、点击、对话发起数。

- 按 campaign 聚合：花费、点击、CTR、CPM、对话发起、CPL
- 时间范围筛选（1d / 7d / 30d / 365d / 自定义）
- 单条广告点开 AdPreviewModal 看素材 + 表现
- 归因到对应产品线 / Medici 会话

这个页面**不写** Meta，只读。要改广告策略请通过 Ogilvy 或直接到 Meta 后台。

---

## 9. Reports & Analytics

### 9.1 Reports（AI 报告）

**进入**：`/reports`

- 列表：所有已生成的报告（type = daily / weekly / monthly / manual）
- 点开看详情：AI 写的总结 + KPI 截图
- 自动生成：cron `generate-reports` 每天跑一次
- 手动触发：点 "新建" 选 type + 日期范围 → 流式生成（SSE，看着字一个个出来）
- 失败的报告会有重试按钮

### 9.2 Analytics（询盘看板）

**进入**：`/analytics`

KPI 卡片 + 多张图表：

- 询盘量 / 质量分布 / 价值分布
- 各产品线对比
- 广告归因（meta_ad_id ↔ 询盘漏斗）

可选时间：1d / 7d / 30d / 365d / 自定义。

页面下方有 "AI 摘要" 面板：调一次 LLM 写一段对当前数据的分析，结果缓存 7 天（避免重复花钱）。

---

## 10. 设置

### 10.1 Meta 连接

已在 §2 描述。

### 10.2 通知（Feishu webhook）

**进入**：`/settings/notifications`

填一个 Feishu / 飞书 自定义机器人 webhook URL。**当 Medici 把会话路由到 HUMAN_NOW** 时，平台会推一条富文本消息到这个机器人，含：

- 客户名 / 国家 / 公司
- 询盘质量 / 价值
- AI 给销售的总结（`handoff_summary`）
- 直达 LeadHub 该会话的链接

URL 在 DB 里**信封加密**（明文不落库）。可以点 "测试" 发一条测试消息。

### 10.3 通知去重

同一次接管周期内只通知一次（`conversations.feishu_notified_at`）——客户后续再发消息不会重复推。

---

## 11. 报价闸口（重要）

LeadEngine 的最大业务红线之一：**未到 QUALIFY 客户看不到价格**。

实现方式（你不用做任何配置，自动生效）：

- 客户的 lead 没集齐你字段表里 `required_for=QUALIFY` 的字段时 → KB 工具返回里**剥掉**所有价格字段
- 客户没把 SKU 收敛到单一型号（lookup_product 返回 >1 行）时 → 同样剥掉
- 客户硬推"先来个数 / 大概 / approximate / ballpark" → 自动转人工

要让 Medici 给报价，你要保证：

1. 字段表的 `QUALIFY` 必填集合配得合理
2. `kb_products` / `kb_pricing_rules` 里有这个 SKU 的价格
3. 客户已经填全了 QUALIFY 字段 + 选定单一 SKU

---

## 12. 数据导出 / 同步

### 12.1 报告导出

`/reports/[id]` → 导出按钮（CSV / Markdown）

### 12.2 外部 SCM 同步

如果你接入了 REVO SCM（或其它兼容系统）：

- cron `sync-leads` 每隔一段时间把 `approved=true` 且 `synced_at IS NULL` 的 lead 推过去
- 同步状态见 `lead_sync_logs` 表（暂无 UI，可以在 dev-tools 查）

### 12.3 dev-tools / SQL（founder 专用）

`/dev-tools/sql`：

- 只读 SQL（SELECT 限定），10s 超时
- 支持写 SQL，也可以输入自然语言让 AI 帮你写 SQL（`/api/dev-tools/ai-sql`）
- 适合：查"过去 30 天每个产品线的 lead 转化漏斗" 这类临时数据

---

## 13. 常见问题

### Q: 客户发来消息但 AI 不回？

按概率从高到低排：

1. 产品线没绑 WhatsApp 号（看 `/product-lines/[id]` → 基本 tab）
2. 你正在人工接管中（`conversations.is_human_takeover=true`）→ 点 "释放"
3. Meta 连接出问题 → 看 `/settings/meta-connection` Banner / cron meta-health-check
4. 客户消息进了 message_queue 但 process_after 没到（等 2-5s）
5. 当前 `inquiry_quality=BAD` 且 `route=FAQ_END`——AI 已经发了 FAQ 答完结，不会再回

### Q: AI 答了错的内容怎么办？

去 `/leadhub`，找到那条 AI 回复 → 点 "纠正" → 写正确答案 → 落 `kb_corrections`。下次同样问题用你的版本。也可以去 KB → Gaps，找到该问题，"教 KB"。

### Q: AI 总是问相同问题不推进？

很可能是你字段表的 `required_for` 设得太严——必填字段太多，客户给完 5 个还差 3 个。建议：

- 把"客户主动告诉你的关键字段"放 GOOD（如产品 + 国家）
- 把"商务推进需要的字段"放 QUALIFY（如数量 + 公司）
- 其它字段不必填（留空 `required_for`）

### Q: Ogilvy 卡在某个阶段不走了？

通常是上一阶段产出过长但你又没确认。直接说 "继续 / 进入下一阶段" 即可。或者明确说"跳到阶段 4"。

### Q: 上传文件后 KB 文档卡在 processing？

cron `recover-stale-kb-docs` 周期跑会重试卡住的文档。也可以在文档列表手动点 "重新解析"。

### Q: 价格不对，KB 改了没生效？

KB 改完几秒内生效（Medici 每次调 KB 工具都现查）。但 Medici 的产品线 config 缓存 60s（包括字段表）——所以字段表改完最多等 1 分钟。

### Q: 怎么知道平台花了我多少 LLM 钱？

- 单会话：Ogilvy 顶部 UsageBadge / Medici 会话进 `/admin/llm-usage`
- 全局：`/admin/llm-usage`（按 call_site / 模型 / 产品线分组）

### Q: 数据安全？

- **多租户隔离**：Postgres RLS 强制；每个查询都过 `getTenantContext()`
- **Meta token**：信封加密（AES-256-GCM），密钥从环境变量取
- **Feishu webhook URL**：同上加密
- **删除会话**：Ogilvy 是软删除（`deleted_at`）；conversations / leads 物理保留（用于审计 / 历史回看）
- **审计日志**：管理性动作（注册 / Meta 连接 / 邀请等）写 `audit_log`

---

## 14. 名词表（速查）

| 词 | 含义 |
|---|---|
| **Tenant** | 你的工作空间（一个 founder） |
| **Product Line** | 产品线 = 一个 WA 号 + 一套 KB + 一套字段表 |
| **Inquiry / Lead** | UI 叫"询盘"、DB 叫 lead；同一个东西 |
| **Inquiry Quality** | BAD / GOOD / QUALIFY / PROOF |
| **Business Value** | LOW / AVERAGE / HIGH |
| **Route** | CONTINUE（继续 AI 谈）/ FAQ_END（FAQ 答完结）/ HUMAN_NOW（转人工） |
| **Takeover** | 人工接管，AI 暂停自动回复 |
| **Medici** | 接待 Agent（用 WhatsApp 接客户） |
| **Ogilvy** | 投放 Agent（策划广告） |
| **KB / 知识库** | 4 层结构：documents → products / routes / knowledge_points + qa_snippets + assets + pricing_rules |
| **Gap** | KB 答不上的客户问题 |
| **CTW** | Click-to-WhatsApp，Meta 广告形态：用户点广告跳到 WhatsApp 对话 |
| **WABA** | WhatsApp Business Account |
| **BM** | Meta Business Manager |
| **Founder** | tenant 的唯一所有者 |

---

## 15. 求助

- 平台问题 / bug：邮件给运营
- 想要新功能：提需求时附上具体场景（不要只描述方案）
- AI 答得不准：先看是不是 KB / 字段表问题；改完仍不准再反馈 + 附会话 ID

祝你跑出第一条 PROOF 级 lead。
