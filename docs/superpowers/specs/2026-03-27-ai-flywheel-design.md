# AI 社交内容自动养号飞轮 — 技术设计文档

**日期：** 2026-03-27
**状态：** 已确认
**品牌案例：** FitVille（宽楦鞋，目标人群45-65岁美国消费者）

---

## 一、产品定位

为电商卖家提供 AI 驱动的社交媒体有机获客引擎。Agent 自主决定发什么内容、什么时候发、用什么格式，通过持续的发帖→反馈→学习循环，逐步建立"营销大脑"，最终实现从人工审核到全自主运行的渐进式放权。

### 核心约束

| 维度 | 决定 |
|------|------|
| 平台 | Facebook Page + Instagram Business |
| 反馈深度 | 帖子指标 + 评论语义分析 + Shopify 转化归因（全闭环） |
| 内容决策 | Agent 自主决定（非人配置模板） |
| 知识来源 | 自身历史数据 + 竞品内容 + 行业趋势 + 产品知识库 |
| 自主权模型 | 渐进式放权（trust_score 0→1） |
| 成功指标 | 有机帖子 → Shopify 订单的转化归因 |

### 明确不做（MVP 边界）

| 排除项 | 理由 |
|--------|------|
| Instagram Reels/Stories | Content Publishing API 限制，需额外权限和视频能力 |
| 自动回复评论/DM | 属于互动响应系统，是独立的下一阶段产品 |
| 多品牌支持 | 先跑通 FitVille，数据模型使用现有 `agent_id` 体系但代码不做多租户 |
| Instagram Carousel | Content Publishing API 的 carousel 发布流程复杂（多容器+合并），MVP 只做单图 |
| 视频内容生成 | 需 HeyGen/Creatify 集成，复杂度翻倍 |
| A/B 测试 | 每日发帖量 1-2 条，无统计意义，用 Slow Loop 周维度对比替代 |
| Boost Post 付费推广 | 飞轮是有机引擎，付费走现有 campaign-orchestrator |

---

## 二、架构设计：双循环飞轮

### 总体架构

```
                    ┌─────────────────────────────────┐
                    │        Strategy Store (DB)       │
                    │  content_strategy 表              │
                    │  ┌─────────────────────────────┐ │
                    │  │ audience_insights            │ │
                    │  │ content_pillars[]            │ │
                    │  │ posting_rules{}              │ │
                    │  │ performance_baselines{}      │ │
                    │  │ learned_patterns[]           │ │
                    │  │ trust_score (0→1)            │ │
                    │  └─────────────────────────────┘ │
                    └──────┬──────────────▲────────────┘
                           │              │
                    读取策略│              │更新策略
                           │              │
              ┌────────────▼───┐    ┌─────┴──────────────┐
              │  Fast Loop     │    │  Slow Loop          │
              │  (Daily Cron)  │    │  (Weekly Cron)      │
              │                │    │                     │
              │  Content Agent │    │  Strategy Agent     │
              │  • 选题决策     │    │  • 周数据聚合       │
              │  • 内容生成     │    │  • 竞品对标         │
              │  • 审核/发布    │    │  • 规律提炼         │
              │  • 数据采集     │    │  • 策略迭代         │
              │                │    │  • trust_score 更新  │
              └───────┬────────┘    └─────▲──────────────┘
                      │                   │
                      │   表现数据         │
                      ▼                   │
              ┌───────────────────────────┴───┐
              │        Feedback Store (DB)     │
              │  organic_posts + post_performance │
              └───────────────────────────────┘

外部数据源：
├── Meta Graph API (Insights + Comments)
├── Shopify API (Orders + UTM 归因)
├── Meta Ad Library (竞品内容)
├── Google Trends (行业趋势)
└── Product Knowledge DB (产品知识，已有)
```

### 核心概念

- **Strategy Store** 是飞轮的"大脑记忆"——结构化存储 agent 学到的所有规律
- **`trust_score`** 是渐进放权的关键：0=全人工审核，1=完全自主，由 Slow Loop 根据历史表现自动调整
- Fast Loop 是"手"（执行），Slow Loop 是"脑"（思考），通过 Strategy Store 和 Feedback Store 通信，不共享 LLM context

---

## 三、数据模型

### 新增 3 张表

#### 3.1 content_strategy（飞轮大脑）

```sql
CREATE TABLE content_strategy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,  -- 与现有 agents 表一致
  platform text NOT NULL,
  version int NOT NULL,

  audience_insights jsonb,
  content_pillars jsonb,
  posting_rules jsonb,
  performance_baselines jsonb,
  learned_patterns text[],

  trust_score float DEFAULT 0,
  approval_mode text DEFAULT 'manual',

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX idx_strategy_agent_platform_version
  ON content_strategy(agent_id, platform, version);
```

**字段说明：**

- `version`：每次 Slow Loop 迭代 +1，旧策略不删除，可回溯演进过程
- `audience_insights`：受众画像，agent 自主学习更新
  ```json
  {
    "core_demo": "45-65岁，有足部问题",
    "peak_hours": ["08:00", "20:00"],
    "high_engagement_topics": ["diabetic_foot", "arch_support"],
    "low_engagement_topics": ["brand_history"]
  }
  ```
- `content_pillars`：内容支柱及权重，agent 自主调整
  ```json
  [
    { "name": "foot_health_education", "weight": 0.35, "avg_engagement": 0.023 },
    { "name": "product_showcase", "weight": 0.20, "avg_engagement": 0.011 },
    { "name": "customer_stories", "weight": 0.25, "avg_engagement": 0.031 },
    { "name": "lifestyle_comfort", "weight": 0.20, "avg_engagement": 0.018 }
  ]
  ```
- `posting_rules`：发帖规则
  ```json
  {
    "frequency": { "facebook": 5, "instagram": 4 },
    "best_times": { "facebook": ["08:00","12:30","20:00"], "instagram": ["07:00","18:00"] },
    "format_mix": { "image": 0.6, "text_only": 0.2, "link": 0.2 }
  }
  ```
- `performance_baselines`：表现基线，用于判断好坏
  ```json
  { "engagement_rate": 0.015, "click_rate": 0.008, "conversion_rate": 0.001 }
  ```
- `learned_patterns`：自然语言规律，Content Agent 可直接理解
  ```
  ["带足部X光对比图的帖子互动率是普通产品图的3倍",
   "周二早8点发教育内容效果最好",
   "CTA用'了解更多'比'立即购买'点击率高40%"]
  ```
- `approval_mode`：`manual` | `auto_low_risk` | `full_auto`

#### 3.2 organic_posts（执行日志）

```sql
CREATE TABLE organic_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  platform text NOT NULL,
  platform_post_id text,

  content_pillar text,
  topic text,
  caption text,
  media_urls text[],
  cta_type text,
  cta_url text,

  original_caption text,        -- AI 原始生成的文案（人审修改前）
  decision_reasoning text,
  risk_level text DEFAULT 'low',
  risk_factors text[],

  status text DEFAULT 'draft',
  scheduled_at timestamptz,
  published_at timestamptz,

  strategy_version int,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_posts_agent_status ON organic_posts(agent_id, status);
CREATE INDEX idx_posts_published ON organic_posts(agent_id, published_at DESC);
```

**字段说明：**

- `original_caption`：AI 原始生成的文案。人审修改后 `caption` 更新为修改版，`original_caption` 保留原版。Slow Loop 对比两者的 diff 来学习人审偏好
- `decision_reasoning`：agent 选这个内容的理由，渐进放权的审计依据
- `risk_level`：`low` | `medium` | `high`，决定是否需要人审
- `risk_factors`：`["contains_price", "medical_claim", "competitor_mention"]`
- `status`：`draft` → `pending_review` → `approved` → `published`（或 `rejected`）
- `strategy_version`：发帖时使用的策略版本快照

#### 3.3 post_performance（反馈数据）

```sql
CREATE TABLE post_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid REFERENCES organic_posts(id) ON DELETE CASCADE,

  impressions int DEFAULT 0,
  reach int DEFAULT 0,
  likes int DEFAULT 0,
  comments_count int DEFAULT 0,
  shares int DEFAULT 0,
  saves int DEFAULT 0,
  engagement_rate float,

  comments_analyzed jsonb,
  sentiment_summary jsonb,

  utm_clicks int DEFAULT 0,
  add_to_carts int DEFAULT 0,
  orders int DEFAULT 0,
  revenue_attributed decimal(10,2) DEFAULT 0,

  measured_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX idx_perf_post ON post_performance(post_id);
```

**字段说明：**

- `comments_analyzed`：评论语义分析结果
  ```json
  [
    { "text": "这鞋适合扁平足吗", "sentiment": "interested", "intent": "purchase_inquiry" },
    { "text": "穿了3个月很舒服", "sentiment": "positive", "intent": "testimonial" }
  ]
  ```
- `sentiment_summary`：情感聚合
  ```json
  { "positive": 0.6, "neutral": 0.3, "negative": 0.1, "purchase_intent": 0.25 }
  ```
- `measured_at`：最后拉取时间，使用 UPSERT 语义（`INSERT ... ON CONFLICT (post_id) DO UPDATE`）持续覆盖为最新快照。只保留最新指标，不做时序追踪——Slow Loop 的周聚合基于发布后 7 天的最终快照即可

### 与现有表的关系

```
product_documents (已有)
product_specs (已有)          ──► Content Agent 读取产品知识
product_embeddings (已有)

campaign_briefs (已有)        ──► 冷启动时提取品牌/产品/受众信息

content_strategy (新)         ──► 飞轮大脑
organic_posts (新)            ──► 执行日志
post_performance (新)         ──► 反馈数据
```

---

## 四、Fast Loop（每日内容 Agent）

### 触发

Cron Job，每天执行 2 次（早 8 点、晚 8 点 EST）。

**频率控制逻辑：** Cron 每天触发 2 次 = 每周 14 次，但 `posting_rules.frequency` 目标为 FB 5 条 + IG 4 条 = 9 条/周。Content Agent 在 Step 2 选题前先检查本周已发帖数，如果目标平台已达本周频率上限则跳过本次执行（只执行 Step 1 反馈采集）。这样 Cron 频率 > 发帖频率，保证不漏发且有弹性。

### 执行流程

#### Step 1: 采集反馈（Observe）

```
├── Meta Graph API: 拉取过去 24h 所有帖子的 Insights
│   GET /{page_id}/posts?fields=insights.metric(post_impressions,post_engaged_users,...)
│   GET /{post_id}/comments?fields=message,created_time
│
├── Shopify API: 查询过去 24h 订单的 UTM 归因
│   GET /admin/api/2024-01/orders.json?created_at_min=...&status=any
│   归因逻辑（Shopify 不支持直接按 UTM 过滤，需客户端匹配）：
│   1. 遍历订单的 `landing_site` 和 `referring_site` 字段
│   2. 解析 URL 参数提取 utm_source / utm_content
│   3. 匹配 utm_content={post_id} → 关联到 organic_posts
│   4. 补充归因：如果无 UTM 匹配，检查订单创建时间是否在
│      某帖子发布后 7 天内 + referring_site 含 facebook.com/instagram.com
│      → 标记为"时间窗口归因"（弱归因，仅供参考）
│   注意：这是全新集成，需要 Shopify Private App token 或 Custom App
│
└── 写入 post_performance 表（UPSERT 语义）
```

#### Step 2: 选题决策（Think）

**第一次 LLM 调用（Sonnet）**

输入：
- `content_strategy` 当前版本（pillars + rules + patterns + baselines）
- 近 7 天发帖记录（避免重复话题）
- 产品知识（product_embeddings 语义搜索，基于选定 pillar）
- 外部信号（Google Trends 足部健康关键词、季节性主题）

输出（forced tool call `submit_content_plan`）：
```json
{
  "platform": "facebook",
  "content_pillar": "foot_health_education",
  "topic": "扁平足vs高弓足：如何判断自己的足型",
  "reasoning": "过去7天教育类内容只发了1条，低于策略权重0.35。扁平足话题在Google Trends上升12%。",
  "format": "image",
  "cta_type": "learn_more",
  "target_time": "2026-03-28T08:00:00Z",
  "risk_level": "low",
  "risk_factors": []
}
```

#### Step 3: 内容生成（Create）

**第二次 LLM 调用（Sonnet）**

输入：
- 选题决策输出
- 品牌语气指南
- 产品知识（针对选定 topic 的 product specs）
- 过去高表现帖子的文案样本（top 3 by engagement_rate）

输出：
```json
{
  "caption": "你知道吗？全球约30%的人有不同程度的扁平足...",
  "hashtags": ["#FlatFeet", "#ArchSupport", "#FitVille", "#WideShoes"],
  "media_prompt": "对比图：左侧正常足弓，右侧扁平足，底部FitVille鞋垫特写",
  "alt_text": "Flat foot vs normal arch comparison with FitVille insole"
}
```

如需 AI 图片 → 调用现有 `aigc.service.generateAdImage()`

#### Step 4: 审核门控（Gate）

```
trust_score < 0.3   → status='pending_review'，等人审
trust_score 0.3-0.7 → 低风险(risk_level='low')自动发，其余人审
trust_score > 0.7   → 全部自动发布
```

#### Step 5: 发布（Act）

```
Facebook:
  POST /{page_id}/feed { message, link, scheduled_publish_time }
  POST /{page_id}/photos (带图)

Instagram:
  POST /{ig_user_id}/media (创建容器)
  POST /{ig_user_id}/media_publish (发布)

UTM 链接格式:
  https://fitville.com/collections/wide-shoes
  ?utm_source=organic_facebook
  &utm_medium=social
  &utm_campaign=flywheel
  &utm_content={post_id}
```

发布后更新 `organic_posts.status='published'`，写入 `platform_post_id`。

### Content Agent Tool 定义

```
fetch_post_insights(post_ids[])       — 拉 Meta Insights
fetch_comments(post_id)               — 拉评论
fetch_shopify_orders(utm_filter)      — 查 UTM 归因订单
search_product_knowledge(query)       — 产品知识语义搜索
search_trends(keywords[])             — Google Trends
get_recent_posts(days, platform)      — 查近期已发帖子
submit_content_plan(plan)             — 提交选题决策（forced）
generate_post_content(topic, specs)   — 生成文案 + 图片 prompt
schedule_post(platform, content, time)— 发布/排期
update_performance(post_id, metrics)  — 写入表现数据
```

---

## 五、Slow Loop（每周策略 Agent）

### 触发

Cron Job，每周一凌晨 3:00 EST 执行

### 执行流程

#### Step 1: 数据聚合（Aggregate）

从 `post_performance + organic_posts` 聚合过去 7 天数据：

```
按维度聚合:
├── 按 content_pillar: 帖数、平均互动率、订单数、收入
├── 按 format: 各格式的平均互动率
├── 按 posting_time: 各时段的平均触达量
├── 按 cta_type: 各 CTA 的点击率和转化率
└── 评论语义聚合: 高频问题、购买意向占比、负面主题
```

#### Step 2: 竞品对标（Benchmark）

竞品内容抓取（不复用 `conductResearch()` 全流程，直接调用其内部的 `fetchMetaAdLibrary()` 函数）：
- Meta Ad Library：竞品过去 7 天新广告（文案主题、视觉风格、CTA 类型）
- 竞品主页公开帖子（Graph API 可读公开 Page）
- 原因：`conductResearch(brief)` 需要完整 brief 对象且产出大量无关内容（市场规模、平台推荐等），周度竞品扫描只需广告和帖子数据

#### Step 3: 规律提炼（Learn）

**LLM 调用（Sonnet）**

输入：
- 当前 `content_strategy`（上一版本）
- 本周聚合数据
- 竞品情报
- 历史 `learned_patterns[]`
- 产品知识库概要

核心 prompt 指令：
> "你是 FitVille 的营销策略大脑。回顾本周数据，对比上周策略：
> 1. 哪些策略判断被数据验证了？
> 2. 哪些策略判断被数据否定了？
> 3. 竞品在做什么你没做的？
> 4. 评论里有什么未满足的用户需求？
> 5. 输出更新后的策略。"

输出（forced tool call `submit_strategy_update`）：
```json
{
  "content_pillars": [
    { "name": "foot_health_education", "weight": 0.35,
      "reason": "互动率高但转化率低于 customer_stories" },
    { "name": "customer_stories", "weight": 0.30,
      "reason": "本周转化率最高，评论购买意向占 25%" }
  ],
  "posting_rules_update": {
    "best_times": { "facebook": ["08:00", "20:00"] },
    "format_mix": { "image": 0.6, "text_only": 0.2, "link": 0.2 }
  },
  "new_patterns": [
    "carousel 格式互动率是单图的 1.7 倍（0.031 vs 0.018）",
    "评论高频问题'有大码吗'→ 下周应专门做一条 46-50 码产品介绍"
  ],
  "retired_patterns": [
    "12:30 发帖效果好 → 否定，连续 2 周 reach 最低"
  ],
  "trust_score_delta": 0.05,
  "trust_reasoning": "本周 7 条帖子中 5 条无需修改直接发布，人审通过率 71%"
}
```

#### Step 4: 策略持久化（Persist）

```
INSERT content_strategy (version = prev + 1)
├── 合并 content_pillars（新权重）
├── 合并 posting_rules（新时间/格式）
├── 追加 new_patterns 到 learned_patterns[]
├── 移除 retired_patterns
├── 更新 performance_baselines（滚动平均）
├── trust_score = min(1.0, prev + delta)
└── 更新 approval_mode:
    trust < 0.3  → 'manual'
    trust 0.3-0.7 → 'auto_low_risk'
    trust > 0.7  → 'full_auto'
```

### Trust Score 演进规则

```
人审通过率 > 80%     → +0.05
人审通过率 50-80%    → +0.00（维持）
人审通过率 < 50%     → -0.10（降权）
任何帖子被人工删除    → -0.15
周转化率连续上升      → +0.03（奖励）
出现负面 PR/投诉     → -0.20（紧急降权）
```

预期时间线：
```
Week 0:   trust=0.00  approval=manual
Week 4:   trust≈0.20  approval=manual
Week 6:   trust≈0.35  approval=auto_low_risk（教育类自动发）
Week 8:   trust≈0.50  approval=auto_low_risk
Week 12:  trust≈0.70  approval=full_auto
```

### Strategy Agent Tool 定义

```
aggregate_weekly_performance(agent_id) — 聚合周数据
fetch_competitor_content(keywords[])   — 竞品内容抓取（直接调 fetchMetaAdLibrary）
search_trends(keywords[])             — Google Trends
get_current_strategy(agent_id)         — 读取当前策略版本
get_product_catalog_summary(agent_id)  — 产品线概要
submit_strategy_update(strategy)       — 提交新策略（forced）
calculate_trust_delta(approval_stats)  — 计算 trust 变化
```

---

## 六、冷启动方案

### Phase 0: 种子策略生成（执行一次）

输入：
- `campaign_briefs` 已有数据（FitVille 品牌/产品/受众）
- `product_knowledge` 已有数据（产品 specs/卖点）
- Meta Ad Library 竞品广告（research-agent 已有能力）
- FitVille 现有 FB/IG 历史帖子（Graph API 拉取最近 100 条）

流程：
1. 抓取 FitVille 历史帖子（如有），分析话题分布和表现
2. 竞品内容分析（New Balance Fresh Foam、Orthofeet、Dr. Comfort）
3. LLM 生成初始策略 → `content_strategy` version=1，trust_score=0.0

### Phase 1: 有监督运行（Week 1-4）

- trust_score = 0.0，全人工审核
- Fast Loop 每天生成内容 → 全部 `pending_review`
- 人在 Campaign Studio 审核，通过/修改/拒绝
- **人审修改是最有价值的学习信号**：agent 写了 A，人改成了 B，这个 diff 喂给 Slow Loop
- Week 1 结束第一个 Slow Loop，数据量少但主要学习人审偏好

### Phase 2: 半自主（Week 5-8）

- trust_score ≈ 0.30-0.50，approval_mode = `auto_low_risk`
- 低风险内容（education, lifestyle）自动发布
- 高风险内容（含价格/促销/医疗声明）仍需人审

### Phase 3: 全自主（Week 9+）

- trust_score > 0.70，approval_mode = `full_auto`
- 所有内容自动发布
- 紧急刹车机制：
  - 帖子被人工删除 → trust -0.15，降回 auto_low_risk
  - 24h 内 3+ 条负面评论 → 自动暂停，通知人类
  - 人类随时可在 UI 上把 approval_mode 改回 manual

---

## 七、技术集成

### 复用现有服务

| 现有服务 | 飞轮中的用途 | 集成方式 |
|---------|-------------|---------|
| `src/llm-client.js` | Content Agent / Strategy Agent 的 LLM 调用 | 直接复用 |
| `src/research-agent.service.js` | 冷启动竞品分析 + Slow Loop 周度竞品对标 | 冷启动复用 `conductResearch()`；周度扫描直接调内部 `fetchMetaAdLibrary()` |
| `src/product-knowledge.service.js` | Content Agent 选题时搜索产品知识 | 直接复用 |
| `src/product-search.service.js` | 语义搜索产品信息 | 复用 `searchProducts(query, agentId, topK)` |
| `src/aigc.service.js` | Content Agent 生成配图 | 复用 `generateAdImage()` |
| `src/campaign-intake.service.js` | 冷启动读取 brief 提取品牌信息 | 只读 |

### 不复用

| 现有服务 | 原因 |
|---------|------|
| `src/meta-ads-mcp-client.js` | MCP 管理付费广告，飞轮发有机帖子走 Graph API 直接调用 |
| `src/execution-agent.service.js` | 执行付费广告创建，与有机发帖无关 |

### 新增文件

```
src/
├── content-agent.service.js        Fast Loop 核心逻辑
├── strategy-loop.service.js        Slow Loop 核心逻辑
├── flywheel-scheduler.service.js   Cron 调度 + 执行协调
├── meta-organic.service.js         FB/IG 有机帖子发布 API 封装
├── shopify-attribution.service.js  Shopify UTM 订单归因查询
└── comment-analyzer.service.js     评论语义分析（LLM 批量分析）

lib/repositories/
└── flywheel.repository.js          3 张新表 CRUD

app/api/flywheel/
├── strategy/route.js               GET 当前策略 / POST 手动触发 Slow Loop
├── posts/route.js                  GET 帖子列表 / POST 审核操作
├── dashboard/route.js              GET 表现看板数据
└── emergency-stop/route.js         POST 紧急停止

app/dashboard/campaign-studio/components/
├── ContentQueue.js                 待审帖子列表
└── FlywheelDashboard.js            Trust Score + 表现看板

supabase/migrations/
└── 2026-03-27-flywheel.sql         3 张新表 DDL
```

### API 权限需求

```
Meta Graph API（追加权限）:
├── pages_manage_posts        — 发布/管理 Page 帖子
├── pages_read_engagement     — 读取帖子互动数据
├── pages_read_user_content   — 读取评论内容
├── instagram_basic           — IG 基本信息
├── instagram_content_publish — IG 发帖
├── instagram_manage_insights — IG 数据分析
└── read_insights             — Page Insights

Shopify API（全新集成，需新增配置）:
├── read_orders               — 读取订单（UTM 归因）
└── read_analytics            — 读取流量来源数据
需新增环境变量:
├── SHOPIFY_STORE_DOMAIN       — e.g. fitville.myshopify.com
├── SHOPIFY_ACCESS_TOKEN       — Private/Custom App token
└── SHOPIFY_API_VERSION        — e.g. 2024-01

已有可复用:
├── META_ACCESS_TOKEN          — 现有 system token
├── SERPAPI_KEY                — Google Trends（~$50/月，约 60 次/月调用量可承受）
└── Supabase                   — 数据库
```

### RLS 策略

3 张新表需要添加 RLS 策略，与现有表保持一致：

```sql
ALTER TABLE content_strategy ENABLE ROW LEVEL SECURITY;
ALTER TABLE organic_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_performance ENABLE ROW LEVEL SECURITY;

-- 服务端通过 service_role key 访问，跳过 RLS
-- 如需前端直接访问，需按 agent_id 或 auth.uid() 添加 policy
CREATE POLICY "service_role_all" ON content_strategy FOR ALL
  USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON organic_posts FOR ALL
  USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON post_performance FOR ALL
  USING (true) WITH CHECK (true);
```

### Cron 调度

```
Fast Loop:     '0 13,1 * * *'   UTC (= 08:00, 20:00 EST)
Slow Loop:     '0 8 * * 1'      UTC (= 03:00 EST 每周一)
Feedback Cron: '0 */6 * * *'    每 6 小时拉取 Insights 更新
```

**注意：** UTC 固定 cron 在美国夏令时（EDT, 3月-11月）期间会偏移 1 小时（变成 09:00/21:00 EDT）。MVP 阶段可接受，后续可改用 timezone-aware scheduler。

**Feedback Cron 职责边界：** Feedback Cron 是独立进程，只负责拉取 Meta Insights 和 Shopify 订单数据并 UPSERT 到 `post_performance`。Fast Loop Step 1 不再重复拉取，只从 `post_performance` 表读取已有数据。避免两个进程并发写入同一行。

### 紧急停止

```
POST /api/flywheel/emergency-stop
```

功能：
- 将当前 `content_strategy.approval_mode` 设为 `manual`
- 取消所有 `status='approved'` 且未发布的排期帖子（改为 `pending_review`）
- 返回被暂停的帖子数量
- UI 上在 FlywheelDashboard 提供一键触发按钮

---

## 八、一周生命周期示例

```
Mon 03:00  Slow Loop → 生成本周策略 v(N)
Mon 08:00  Fast Loop #1 → 读策略 v(N) → 选题 → 生成 → 审核 → 发布
Mon 14:00  Feedback Cron → 拉取周末帖子最新 Insights
Mon 20:00  Fast Loop #2 → 选题 → 生成 → 审核 → 发布
Tue 08:00  Fast Loop #3 → 先采集 Mon 帖子 24h 数据 → 再选题发帖
...
Fri 20:00  Fast Loop #10 → 本周最后一条帖子
Sat-Sun    Feedback Cron → 持续拉取数据更新
Mon 03:00  Slow Loop → 聚合本周数据 → 对比策略 v(N) → 生成 v(N+1)
           ↑ 飞轮完成一整圈
```

---

## 九、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Meta API 权限审核慢 | 无法发帖 | 先用 Page token 测试，正式上线前提交 App Review |
| AI 生成内容含医疗声明 | FTC 合规风险 | risk_factors 检测 `medical_claim`，强制人审 |
| 帖子效果差导致主页权重降低 | 有机触达越来越低 | trust_score 刹车机制 + 最低互动率阈值告警 |
| Shopify UTM 归因不准 | 无法证明转化 | 多重归因：UTM + 时间窗口（帖子发布后 7 天内的订单） |
| 评论中出现品牌危机 | 负面扩散 | 24h 负面评论阈值触发暂停 + 人工通知 |
