# 阶段三:10 章 CTW 投放策划案详细模板

本文件为阶段三的输出标准。**10 章框架由契约 v1.1 第 7.4 节锁定**,章节编号与标题不允许新增、删除、重命名。每章具体内容(模板、表格、举例)由本 reference 提供,可灵活迭代。

## 与契约 v1.0 17 章版本的关系

v1.1 章节数从 17 章压缩为 10 章。压缩后保留所有 CTW 投放执行直接相关的内容,删除装饰性框架与不属于 Meta CTW 的章节。详细对照见 SKILL.md 6.2 节速查表与契约 v1.1 7.4 节附表。

## 与阶段二的关系

涉及调研的章节(04 / 05)直接引用阶段二报告对应部分,**不重复展开**。

## 瘦身原则

- 删除装饰性框架(SMART / SWOT / Brand Story 详细展开)
- 删除非 Meta CTW 内容(多渠道分配、落地页 CRO、SEO/KOL)
- 数据具体化,严禁"较多""较高"等模糊表达
- 来源可查,所有外部数据需注明来源
- 涉及投放参数严格按契约 6.1 锁定值

---

## 目录

1. [执行摘要](#01-执行摘要)
2. [项目目标](#02-项目目标)
3. [产品卖点](#03-产品卖点)
4. [竞品 Meta 打法 + 我方应对](#04-竞品-meta-打法--我方应对)
5. [受众分组与 Meta 定向配置](#05-受众分组与-meta-定向配置)
6. [漏斗与版位规划](#06-漏斗与版位规划)
7. [素材规划与 A/B 测试](#07-素材规划与-ab-测试)
8. [数据埋点 Pixel/CAPI + UTM](#08-数据埋点-pixelcapi--utm)
9. [排期 + KPI 预测 + ROI 测算](#09-排期--kpi-预测--roi-测算)
10. [附录](#10-附录)

---

## 01 执行摘要

1 页内说清以下内容:

- 项目名称、客户、车型
- 核心投放目标(1 句话):"6 个月内在 [国家] 通过 Meta CTW 获取 [X] 条 WhatsApp 对话,转化为 [Y] 条 hot lead"
- 总预算与投放周期(明确数字)
- 核心 KPI:cost per conversation 目标值、conversation → hot lead 转化率目标值
- 预期 ROI / ROAS
- 关键里程碑(3-5 个)

> 不写战略层面的废话(如"打造行业领先品牌")。直接给数字与目标。

---

## 02 项目目标

**1 段话即可**:

> 在 [国家] 通过 Meta CTW 投放,在 [时间范围] 内获取 [X] 条 WhatsApp 对话,
> Cost per Conversation 不超过 [Y USD],对话→hot lead 转化率 ≥ [Z%],
> 转化为试驾 [N] 个,转化为订单 [M] 个,目标 ROAS 为 [R]。

**不写 SMART 五个英文字母的解释**——直接落数字即可。

---

## 03 产品卖点

**3 行交代清楚**:

| 项 | 内容 |
|---|---|
| 3 个核心卖点(客户原话) | 1) ... 2) ... 3) ... |
| 起售价 | XX,XXX [当地货币] |
| 竞品对标价 | 竞品 A: XX,XXX / 竞品 B: XX,XXX(高/低 X%) |

> 不做 USP 矩阵、不做差异化叙事框架。卖点就是卖点,价格就是价格。

---

## 04 竞品 Meta 打法 + 我方应对

> **数据来源**:本章基于阶段二报告第【2】部分「竞品 CTW 打法」推导。竞品调研详情请参阅阶段二报告,**本章不重复列出**。

### 4.1 关键洞察提炼(3-5 条)

示例:

- **洞察 1**:竞品 X 90% 创意仍用传统 Lead Form CTA,只 10% 用 CTW → 我方主打 CTW 体验差异化
- **洞察 2**:竞品 Y 在 Reels 投放占比仅 15%,但 CTW 在 Reels 转化率最高 → 我方版位机会
- **洞察 3**:竞品 welcome_message 普遍生硬,缺乏个性化 → 我方首响差异化

### 4.2 我方应对策略(单表)

| 洞察 | 我方应对 | 落地动作(对应 plan_json 字段) |
|---|---|---|
| 洞察 1 | 主打 CTW 即时沟通体验 | 所有 ad 用 `WHATSAPP_MESSAGE` CTA + 高转化 welcome_message |
| 洞察 2 | 抢占 Reels 版位 | `instagram_positions: ["reels"]` 占比 35% |
| 洞察 3 | welcome_message 个性化 | 每市场单独设计,体现卖点 + 开放式问题 |

### 4.3 核心传播主线

**一句话核心传播主线**(不写 Brand Story 详细框架):

示例:"以家庭场景的安心与续航为核心,传递 [品牌] 是欧洲家庭出行最值得信赖的智能伙伴。"

3-5 个支撑信息:

- 支撑 1:[卖点 1 数据化表述]
- 支撑 2:[卖点 2 数据化表述]
- 支撑 3:[卖点 3 数据化表述]

> 不另起独立"品牌定位章节"——核心主线一句话即可,后续在 welcome_message 与素材文案中体现。

---

## 05 受众分组方向 + 关键词候选(v2.0:不写预算/Meta ID)

> **数据来源**:本章基于阶段二报告第【3】部分「受众洞察」。本章聚焦「广告组拆分逻辑 + targeting 关键词方向」。
>
> **v2.0 重要变化**:**预算分配 + Meta 参数移到阶段 5**(执行方案集中输出)。本章只输出方向和关键词候选,**不输出**:
> - 各市场预算占比 / 预算金额
> - Targeting 关键词的 yaml 完整配置
> - advantage_audience 等 Meta 参数

### 5.1 业务模式分支(v2.0 新增,按 SKILL.md §4.A.2 已识别的模式)

| 模式倾向 | 受众分组方向 | 关键词候选方向 |
|---|---|---|
| **B2C 终端零售** | 按用户画像分组(家庭 / 科技青年 / 高净值) | family / SUV buyer / new car shopper / EV interest |
| **B2B 跨境批发** | 按经销商类型分组(进口商 / 批发商 / 车队采购) | importer / wholesaler / commercial vehicle dealer / fleet purchase |
| **品牌官方混合** | 综合分组,分流型受众 | 综合 |
| **自定义模式** | 按用户在 §4.A.2 的描述自定义 | 按用户描述抽取 |

**禁忌词检查**(必须):
- B2C 模式下,关键词候选**严禁出现** FOB / MOQ / OEM 等术语错位词
- B2B 模式下,关键词候选可灵活使用

### 5.2 受众分组策略(广告组拆分方向)

按业务模式输出广告组拆分方向(不写具体预算占比,预算归阶段 5):

**B2C 模式示例**:

| 广告组名 | 来源 Persona | 关键词方向 |
|---|---|---|
| DE_TIER1_FAMILY | 中产家庭 | Family / SUV / Road trip |
| DE_TIER1_TECH | 科技青年 | EV technology / smart mobility |
| DE_TIER1_LUXURY | 高净值 | Luxury cars / premium |

**B2B 模式示例**:

| 广告组名 | 来源 Persona | 关键词方向 |
|---|---|---|
| AE_B2B_DEALERS | 阿联酋汽车经销商 | car dealer / automotive dealership / importer |
| AE_B2B_TRADERS | 阿联酋贸易商 | trading company / wholesaler / commercial vehicle distributor |
| AE_FLEET_BUYERS | 阿联酋车队采购 | fleet management / logistics company purchasing |

### 5.3 自定义受众与 Lookalike(可选,方向)

- 网站访客 / 过往 WhatsApp 对话用户 / CRM 客户
- Lookalike 创建顺序方向:1% → 2% → 5%

### 5.4 不做的事

- ❌ 不输出 Meta 兴趣 / 行为 ID(skill 不能查 ID,由宿主处理)
- ❌ 不默认绑定竞品品牌名(如 Tesla / BMW)作为兴趣词
- ❌ 不写 Persona 故事化画像(姓名/生活方式等)
- ❌ 不做 Tier 1/2/3 评分(那是市场进入决策,与 CTW 投放执行无关)
- ❌ **(v2.0)不输出预算分配**(归阶段 5)
- ❌ **(v2.0)不输出完整 targeting yaml 配置**(归阶段 5)
- ❌ **(v2.0,B2C 模式)不出现 FOB/MOQ/OEM 等术语错位词**

### 5.5 进入节奏方向

- **M1-M2**:全市场小预算并行测试,识别 CPM/CPC 最优市场
- **M3-M4**:winner 市场加预算,underperformer 市场关停或缩量
- **M5-M6**:精细化运营,集中预算到 top 3 ad_sets

> 注意:具体节奏数字会因预算/周期不同而调整,本节给方向,具体配置在阶段 5。

---

## 06 漏斗结构与关键转化节点(v2.0:按业务模式分支)

> **v2.0 重要变化**:版位预算分配移到阶段 5。本章只输出**漏斗结构方向**和**关键转化节点**。

### 6.0 业务模式选漏斗(v2.0 新增)

按 SKILL.md §4.A.2 已识别的业务模式倾向输出对应漏斗:

| 业务模式 | 漏斗结构 |
|---|---|
| **B2C 终端零售** | 广告 → WhatsApp 询盘 → 试驾邀请 → 订单 |
| **B2B 跨境批发** | 广告 → WhatsApp 询价 → 报价单(FOB/MOQ)→ 样车订单 / 签约 |
| **品牌官方混合** | 广告 → WhatsApp → 询盘资质判定 → B2B 走批发后段 / B2C 分发到经销商 |
| **自定义模式** | 按用户在 §4.A.2 的描述自定义 |

### 6.1 CTW 漏斗结构(无落地页)

#### 6.1.A B2C 模式漏斗

| 漏斗阶段 | 目标 | 关键动作 | KPI |
|---|---|---|---|
| TOFU(认知) | 看到广告 | 高频曝光 | CPM / 覆盖人数 |
| MOFU(点击) | 点击 CTA | 创意吸引点击 | CTR / CPC |
| **WhatsApp 首响** | 开始对话 | welcome_message 留人 | Click → 首响率 |
| BOFU(对话深入) | 索取详情 / 询价 | 客服话术、试驾邀请 | Conversation → Hot Lead |
| 转化 | 试驾 / 订单 | 销售跟进 | 试驾率、订单率 |

#### 6.1.B B2B 模式漏斗(v2.0 新增)

| 漏斗阶段 | 目标 | 关键动作 | KPI |
|---|---|---|---|
| TOFU(认知) | 触达海外经销商 / 进口商 | 商务调性曝光 | CPM / 覆盖经销商人数 |
| MOFU(点击) | 点击 CTA | 创意吸引点击 | CTR / CPC |
| **WhatsApp 首响** | 开始询价对话 | welcome_message(经销商口吻) | Click → 首响率 |
| BOFU(询价深入) | 索取 FOB 报价 / MOQ / OEM 资料 | 销售提供报价单 + OEM 支持说明 | Conversation → Hot Lead(询价) |
| 转化 | 样车订单 / 签约意向 | 销售推进合同流程 | 样车订单率、合同签约率 |

### 6.2 版位预算分配(v2.0:移到阶段 5)

> **v2.0 重要**:本节已移到 SKILL.md §8 阶段 5。本章不再展开。

### 6.3 WhatsApp 首响策略

#### 6.3.1 welcome_message 设计要求

详见 `read_skill_reference({ name: "meta-creative-specs" })` §2。

**v2.0 关键约束**:
- 字符上限按 SKILL.md §4.C 锁定的平台规则(不写死 300)
- 按业务模式倾向调整口吻(B2B 经销商口吻 / B2C 消费者口吻)
- **严禁出现具体 FOB 价格**(让客服在对话中沟通)

#### 6.3.2 客服响应 SLA(按业务模式分支)

**B2C 模式**:

| 时间窗口 | 响应要求 |
|---|---|
| **首响**(welcome_message 后用户回复) | ≤ 5 分钟(理想)/ ≤ 30 分钟(可接受) |
| 报价回复 | ≤ 30 分钟 |
| 试驾预约确认 | ≤ 2 小时 |
| 周末 / 非工作时段 | 自动回复 + 工作日首小时人工跟进 |

**B2B 模式**(经销商耐受度较高,工作时段必须当日响应):

| 时间窗口 | 响应要求 |
|---|---|
| **首响**(welcome_message 后用户回复) | ≤ 2 小时(工作时段) |
| 报价回复 | ≤ 24 小时(报价单需准备 PDF/Excel) |
| 样车订单 / 合同流程 | ≤ 48 小时 |
| 周末 / 非工作时段 | 自动回复 + 下一工作日人工跟进 |

> **注意**:实际项目中常配置 AI 客服 + 人工客服。若用户已配置 AI 客服,本节作为人工接力的兜底要求即可,不必再向用户询问客服响应配置。

#### 6.3.3 对话脚本骨架(按业务模式分支)

**B2C 模式**:

| 阶段 | 销售动作 | 目标 |
|---|---|---|
| T+0(welcome_message) | 系统自动 | 留住用户 |
| T+5min(用户回复后) | 销售人工首响 | 建立信任 |
| T+10min | 询问关键决策因素(预算 / 用途 / 时间) | 资格判定 |
| T+30min | 提供个性化报价 / 试驾邀请 | 推进 |
| T+24h(若未约试驾) | 跟进询问 + 提供促销信息 | 二次激活 |

**B2B 模式**(v2.0 新增):

| 阶段 | 销售动作 | 目标 |
|---|---|---|
| T+0(welcome_message) | 系统自动 | 留住经销商 |
| T+2h(用户回复后) | 销售人工首响 | 建立信任,询问目标市场+采购规模 |
| T+24h | 提供 FOB 报价单 + OEM 支持说明 + 进口指南 | 提供决策依据 |
| T+48h | 跟进询问采购计划 + 样车安排 | 推进 |
| T+7d(若未签约) | 跟进询问障碍 + 提供促销条件 | 二次激活 |

#### 6.3.4 隐私合规

- WhatsApp 商业消息政策:用户首次主动联系后 24 小时内可自由回复;超 24 小时需用 Meta 批准的模板消息
- GDPR(欧盟):对话内不要主动收集敏感个人信息
- 客户原话保留权:重要承诺(报价、交付时间)需文字化留底

> 注:本 skill **没有落地页 / Lead 表单**——CTW 唯一转化路径是 WhatsApp 对话。

---

## 07 素材规划与 A/B 测试

### 7.1 素材清单概览

| 维度 | 数量 |
|---|---|
| 创意方向 | 3 套(详见阶段四清单) |
| A/B 变体 | 每个 ad_set 至少 2 个 |
| 本地化语言 | 按目标市场对应 |
| 素材尺寸 | 全部 1080×1080(`generate_ad_creative` 工具固定) |

详细任务清单在阶段四生成。

### 7.2 A/B 测试框架

| 测试维度 | 测试变量 | 显著性判定 |
|---|---|---|
| 创意 | 卖点 / 场景 / 色调 | 单组 ≥ 1000 次曝光,CTR 差异 ≥ 20% |
| Headline | 简短 vs 详细 / 数字化 vs 故事化 | 单组 ≥ 1000 次曝光,CTR 差异 ≥ 15% |
| **welcome_message** | **首句问题不同** / **语气差异**(必测) | 单组 ≥ 100 条对话,首响率差异 ≥ 15% |
| 受众 | 兴趣组合 / 年龄段 | 至少 7 天数据,cost per conversation 差异 ≥ 25% |

### 7.3 优化决策流程

- 测试期(M1-M2):多变量同跑,小预算
- 显著性达标:关停 loser,winner 加预算
- 放大期(M3-M4):winner 复制扩展受众
- 优化期(M5-M6):再营销 + LTV 提升

### 7.4 Meta CTW 投放执行细节(原 11 章融入)

> **契约 6.6**:本节仅 Meta CTW,**不写** Google / LinkedIn / TikTok。

#### 7.4.1 CTW 锁定字段速查(详见 `meta-api-template.md`)

| 字段 | 锁定值 |
|---|---|
| `campaign.objective` | `OUTCOME_ENGAGEMENT` |
| `adset.optimization_goal` | `CONVERSATIONS` |
| `adset.destination_type` | `WHATSAPP` |
| `adset.targeting.targeting_automation` | `{ advantage_audience: 0 }` |
| `creative.link_data.call_to_action.type` | `WHATSAPP_MESSAGE` |

#### 7.4.2 出价策略

- 测试期:`LOWEST_COST_WITHOUT_CAP`(让 Meta 自动找量)
- 放大期:若 cost per conversation 稳定,可考虑 `COST_CAP`

---

## 08 数据埋点 Pixel/CAPI + UTM

### 8.1 仅 Conversation 事件

CTW 投放的核心追踪是 **Conversation Started 事件**(由 Meta 自动追踪 WhatsApp 跳转)。

- ✅ Meta CAPI Conversation 事件(Meta 自动)
- ✅ UTM 参数(用于 ad set / creative 维度回流)

### 8.2 不做的事(契约 6.5)

- ❌ 不写 Pixel 落地页转化事件(没有落地页)
- ❌ 不写 Lead Form 表单提交事件(没有 Lead Form)
- ❌ 不写 GTM / GA4 / 仪表盘(数据团队职能,不是投放执行)

### 8.3 UTM 命名规范

```
utm_source=facebook|instagram
utm_medium=paid_social
utm_campaign={campaign_name}
utm_content={creative_id}
utm_term={ad_set_name}
```

> 但请注意:CTW 的最终 link 是 `https://api.whatsapp.com/send`(契约锁定),UTM 参数附加到此链接的 query string,用于 WhatsApp Business 后台的对话归因。

### 8.4 归因模型

- **推荐**:线性归因(汽车行业典型,跨触点贡献均衡)
- **数据驱动归因**仅在 Meta 数据足够时启用

---

## 09 排期 + KPI 预测 + ROI 测算

### 9.1 三段式排期

| 阶段 | 时间 | 重点 | 关键动作 |
|---|---|---|---|
| 测试期 | M1-M2 | 多创意/多受众小预算测试 | 跑满 A/B 测试矩阵,识别 winner |
| 放大期 | M3-M4 | 复制 winner、扩大预算 | Lookalike 1% → 2%,winner 预算 +50% |
| 优化期 | M5-M6 | 精细化运营、再营销 | 关停 underperformer,集中预算到 top 3 ad_sets |

> 不做 Week by Week 计划——颗粒度过细,实战中无人执行。

### 9.2 CTW 指标预测(基于 `data-sources.md` 第 7 节)

> **执行规则**:阶段三启动时必须先 `web_search` 校验最新 CTW 行业基准。

**示例(德国市场,CTW 投放)**:

| 指标 | 保守 | 中性 | 乐观 | 行业基准 |
|---|---|---|---|---|
| CPM | 22 USD | 18 USD | 14 USD | 8-25 |
| CTR | 1.0% | 1.5% | 2.2% | 1.0%-2.5% |
| CPC | 2.2 | 1.2 | 0.65 | 0.7-2.5 |
| Click → 首响率 | 55% | 65% | 75% | 50%-75% |
| **Cost per Conversation** | **4.0** | **1.8** | **0.85** | **1.5-5.0** |
| Conversation → Hot Lead | 25% | 35% | 45% | 25%-45% |
| Cost per Hot Lead | 16 USD | 5.1 USD | 1.9 USD | 推算 |

### 9.3 ROI 测算

```
总曝光 = 总预算 / CPM × 1000
总点击 = 总曝光 × CTR
总对话 = 总点击 × Click→首响率
Hot Lead 数 = 总对话 × Conversation→Hot Lead
试驾数 = Hot Lead × 试驾率(20%-35%)
订单数 = 试驾数 × 订单率(8%-20%)
总收入 = 订单数 × 客单价
ROAS = 总收入 / 总预算
```

### 9.4 敏感性分析

| 变量 | 下浮 20% | 基准 | 上浮 20% |
|---|---|---|---|
| Cost per Conversation | ROAS = 4.2 | ROAS = 3.5 | ROAS = 2.9 |
| Conversation→Hot Lead | ROAS = 2.8 | ROAS = 3.5 | ROAS = 4.2 |
| 客单价 | ROAS = 2.8 | ROAS = 3.5 | ROAS = 4.2 |

---

## 10 附录

### A. 多语言文案库

按目标市场×版位×A/B 变体输出(包括 Headline / Primary Text / Description / **welcome_message**):

| 字段 | DE | FR | EN | ES |
|---|---|---|---|---|
| Headline | 600 km Reichweite (WLTP) | 600 km d'autonomie | 600 km Range | 600 km de Autonomía |
| Primary Text | ... | ... | ... | ... |
| **welcome_message** | Hallo! Ich freue mich... | Bonjour ! Je suis ravi... | Hi there! I'm glad... | ¡Hola! Me alegra... |

> ⚠️ **本广告文案与 welcome_message 由 AI 生成,投放前必须由当地母语者审核**。审核 checklist:
> - [ ] 语气是否自然(避免直译腔)
> - [ ] 是否触犯文化禁忌
> - [ ] welcome_message 是否符合当地表达习惯
> - [ ] 法规标注是否到位(WLTP / Impressum / 强制语等)

### C. UTM 命名规范

参见第 08 章 8.3 节。

### E. 命名规范

| 层级 | 命名模板 | 示例 |
|---|---|---|
| Campaign(单个) | `{Brand}_{Model}_CTW_{StartDate}` | `BYD_Seal_CTW_20260601` |
| Ad Set | `{Country}_{Tier}_{Audience}` | `DE_TIER1_FAMILY` |
| Ad | `{AdSetName}_{CreativeID}` | `DE_TIER1_FAMILY_CR-001` |
| Creative | `CR-{编号}_{Variant}` | `CR-001_A` |

### F. 风险预案

| 风险 | 预案 |
|---|---|
| 拒登 | 先小预算预审,记录拒登理由 → 修改 → 重提 |
| 客服响应延迟 | 配置自动回复 + 销售排班 + 24h 兜底跟进 |
| WhatsApp 24h 窗口超时 | 准备 Meta 批准的模板消息(MTM)用于追触 |
| 预算超支 | Daily Budget 上限 + Meta 预算告警 + 人工每日复核 |

### G. 数据来源汇总

(策划案中所有外部数据的引用清单,需与阶段二报告保持一致)

---

## 用户角色分支额外产出(写在策划案末尾,简短)

### 品牌方分支:决策记录

简短列出每个关键决策的 why(为什么选这些卖点 / 为什么这样分配预算 / 为什么用这种 welcome_message),5-8 条即可。

### 代理商分支:SCQA 提案大纲

| 字段 | 内容 |
|---|---|
| Situation | 客户当前出海背景 |
| Complication | 当前面临的挑战(如海外认知低、Lead 跟进慢) |
| Question | 关键问题:如何高效获取高质量海外 Lead |
| Answer | 我方 CTW 方案的核心价值主张 |

### 出海平台分支:多品牌批量化建议

简述同模板可复用的部分(策略框架、市场基准、合规清单)+ 各品牌差异化部分(卖点、welcome_message、定向关键词)。

---

## 各章节生成原则

1. **数据具体**:每章必须有数字、百分比、金额
2. **不重复调研**:04 / 05 章节聚焦"如何用阶段二的调研结论制定策略"
3. **来源可查**:所有外部数据需注明来源(汇总在附录 G)
4. **预算明确**:所有预算分配需有明确数字和占比
5. **可执行**:所有建议需可直接落地
6. **本地化**:所有内容需结合具体目标市场的特性
7. **CTW 锁定**:涉及投放参数严格按契约 6.1,清除 6.2 禁用枚举
8. **聚焦 Meta**:不涉及 Google/LinkedIn/TikTok 等其他平台
9. **对话内输出**:所有内容直接以 markdown 出现在 assistant 回复中,不"保存到文件"
10. **10 章框架不可变**:章节编号与标题严格按契约 v1.1 7.4 节锁定
