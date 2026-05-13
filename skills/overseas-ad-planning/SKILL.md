---
name: overseas-ad-planning
description: >
  汽车出海 Meta CTW（Click-to-WhatsApp）广告投放专属 SOP。聚焦 Facebook/Instagram
  导流 WhatsApp 对话的全流程方案输出。当用户提出汽车海外广告投放、汽车出海 CTW
  广告策划、新能源车海外营销、汽车 WhatsApp 引流广告、Meta 汽车广告等需求时调用。
  五阶段独立调用,按依赖关系校验:需求对接 → 市场分析 → 10 章策划案 → CTW 素材生成(必须先上传产品图)
  → Meta CTW 投放方案。所有产出在对话中直接输出。
---

# 汽车出海 Meta CTW 广告投放 SOP

## 1. 运行环境硬约束(必须遵守)

本 skill 运行在 LeadEngine 宿主环境内,**不是** Claude.ai 通用环境。以下能力**不存在**,任何提及它们的指令都会失败:

- ❌ 没有文件系统:不能"保存到 outputs/"、不能 `present_files`、不能 `Write`/`Edit`
- ❌ 没有 Python 沙箱:不能"运行下面的脚本"
- ❌ 没有 OpenRouter / Meta API 直连:不能让用户"自备 API Key"
- ❌ 没有 Bash / Shell:不能"运行命令"

### 1.1 输出形式硬规则

- **所有产出物**(市场分析、10 章策划案、素材清单、Meta 方案)以**完整 markdown 内容**直接出现在 assistant 回复里
- **禁止**说"已保存到 xxx.md,请查收附件"——用户看不到任何附件
- **禁止**说"详细内容因篇幅省略"——必须输出完整内容
- 长内容用标准三反引号包裹

### 1.2 工具白名单(只有 5 个)

| 工具 | 调用时机 |
|---|---|
| `web_search` | 阶段二取最新数据(Meta 政策、竞品广告库等) |
| `read_webpage` | 配合 web_search 深读单一来源 |
| `read_skill_reference` | 按需读取 references/*.md(详见各阶段说明) |
| `generate_ad_creative` | **仅阶段四**生成广告图,每素材调一次 |
| `draft_ad_plan` | **由宿主 host-patch 负责调用**,skill 内文不写 |

**禁止**调用任何其他工具(file I/O、shell、Python、第三方 API 直连等都不存在)。

---

## 2. 产品锁定:Meta CTW(Click-to-WhatsApp)

本 skill 只支持一种广告形式:**Meta Click-to-WhatsApp**(用户点击广告 → 跳转 WhatsApp 对话)。

### 2.1 锁定字段(plan_json 中必须严格使用,不允许其他枚举)

| Meta 字段 | 锁定值 |
|---|---|
| `campaign.objective` | `OUTCOME_ENGAGEMENT` |
| `campaign.special_ad_categories` | `[]` |
| `campaign.buying_type` | `AUCTION` |
| `campaign.campaign_budget_optimization` | `true` |
| `adset.optimization_goal` | `CONVERSATIONS` |
| `adset.billing_event` | `IMPRESSIONS` |
| `adset.destination_type` | `WHATSAPP` |
| `adset.promoted_object` | `{ page_id, whatsapp_phone_number }` |
| `adset.targeting.targeting_automation` | `{ advantage_audience: 0 }` |
| `creative.link_data.link` | `https://api.whatsapp.com/send` |
| `creative.link_data.call_to_action.type` | `WHATSAPP_MESSAGE` |
| `creative.link_data.call_to_action.value.app_destination` | `WHATSAPP` |
| `campaigns.length`(数组长度) | **严格 = 1**(多市场用同 campaign 下多个 ad_sets 按 `targeting.countries` 切分) |

### 2.2 禁用清单(不要在任何阶段提及作为可选项)

- **禁用 objective**:`OUTCOME_LEADS` / `OUTCOME_TRAFFIC` / `OUTCOME_AWARENESS` / `OUTCOME_SALES` / `OUTCOME_APP_PROMOTION`
- **禁用 optimization_goal**:`LEAD_GENERATION` / `LANDING_PAGE_VIEWS` / `LINK_CLICKS` / `OFFSITE_CONVERSIONS` / `IMPRESSIONS` / `REACH`
- **禁用 CTA type**:`LEARN_MORE` / `GET_QUOTE` / `SIGN_UP` / `CONTACT_US` / `SHOP_NOW` / `SUBSCRIBE` / `BOOK_TRAVEL` / `WATCH_MORE`
- **禁用**:任何 Lead Form 配置、任何指向落地页的 link、Pixel 落地页转化事件、CRO 章节

### 2.3 不在范围内

| 项 | 状态 |
|---|---|
| 视频素材 | 不支持(generate_ad_creative 仅出 1:1 静态图,需扩展时由宿主升级) |
| 多平台(Google / LinkedIn / TikTok) | 不支持(走对应平台 skill) |
| Lead Generation / Traffic 等非 CTW 投放 | 不支持(由宿主整体设计决定) |
| 投放后数据回流分析 | 由独立 skill 处理 |
| 多 campaign | 锁定为 1 个 |

---

## 3. 阶段框架(独立调用 + 依赖校验)

```
阶段一:需求对接
    ↕
阶段二:Meta 平台市场分析(联网取数)
    ↕                                依赖关系(自上而下递进)
阶段三:10 章 CTW 投放策划案
    ↕
阶段四:CTW 素材生成(必须先确认用户已上传产品图)
    ↕
阶段五:Meta CTW 投放方案(plan_json + 后台操作手册)
```

### 3.1 五阶段独立调用规则(v1.1)

五阶段**不强制顺序执行**,允许按用户场景从任意阶段进入。但阶段间有**依赖关系**——每阶段开始前按下表「输入契约」校验前置产出:

| 当前阶段 | 输入契约(必须有) | 缺失时处理 |
|---|---|---|
| 阶段一 | 用户对话或 brief 文件 | 直接进入,启动收集 |
| 阶段二 | 阶段一产出(8 必填字段) | 缺失任一必填字段 → 先调阶段一(快速模式) |
| 阶段三 | 阶段一产出 + 阶段二的市场分析结论 | 缺失则先补对应阶段(快速模式可现场调研补足关键结论) |
| 阶段四 | 阶段一产出 + 阶段三的素材规划要点 + **用户已上传产品图** | 无产品图必须先提示上传;策划要点缺失则先补阶段三 |
| 阶段五 | 阶段三产出 + 阶段四产出(**含真实素材 url**) | 缺失则先补对应阶段 |

### 3.2 缺失处理两档

- **缺失项较少**(1-3 个字段):直接对话提问补全,然后继续当前阶段
- **缺失项较多**(>3 个字段或整个前置阶段缺失):走「快速通道」,用最简输入启动该阶段,所有缺失字段标 `[待客户补充]` 继续输出。**不要回退到前置阶段强制重跑**

### 3.3 sanity check 仍然生效(关键)

宿主有反 shortcut 保护:走到 `draft_ad_plan`(阶段六由宿主补丁触发)**仍必须有**真实 `generate_ad_creative` 调用记录。也就是说:

- ✅ 用户独立调用阶段三、阶段四 — 没问题,自然结束
- ✅ 用户独立调用阶段五,但同会话内**已有过**阶段四 generate_ad_creative 调用记录(比如多轮迭代,先单跑了阶段四) — 没问题
- ❌ 用户跳过阶段四,直接尝试阶段五出 plan_json — 即使 skill 输出了 plan_json,宿主在调 draft_ad_plan 时会**拦截**(因为 plan_json 中 image_url 必须来自真实工具调用,不能伪造)

**实际行为**:阶段五开头校验输入契约时,如果发现"无 generate_ad_creative 调用记录"且"用户没提供已有 image_url",必须**拦截并提示用户先跑阶段四**,不要硬出 plan_json。

### 3.4 必须保留的机制

- 阶段间**依赖关系不变**(虽然不强制顺序执行,但依赖链如上表)
- 每阶段产出后**简要复述核心要点并询问用户是否需要调整**,确认后再继续
- 阶段五完成后**不要写"流程到此结束"**等收尾语;宿主会接续调用 `draft_ad_plan` 完成 CTW 收口提交

---

## 4. 阶段一:需求对接

### 4.1 用户角色识别(对话开场第一问)

| 选项 | 后续差异 |
|---|---|
| 品牌方(车厂/经销商) | 标准产出 + 简明决策记录段落 |
| 代理商(4A/数字代理) | 标准产出 + 提案大纲(SCQA 结构) |
| 第三方出海平台 | 标准产出 + 多品牌批量化建议段落 |

### 4.2 需求收集

按以下维度对话式收集(不一次抛全部问题)。详细维度清单调用 `read_skill_reference({ name: "strategy-template" })` 第 02 章。

### 4.3 必填字段(8 项,缺一不启动后续阶段)

1. **品牌**(中英文)
2. **车型**(中英文)
3. **车辆类型**(纯电 SUV / 混动轿车 / 燃油性能车 / 家用 MPV / 等)
4. **核心卖点**(3 个,客户原话)
5. **目标国家**(具体 ISO-2 国家代码;多国时按预算占比说明)
6. **投放周期**(开始日期 + 结束日期)
7. **总预算**(金额 + 货币)
8. **WhatsApp 配置**(phone_number_id + Meta 主页 ID)

### 4.4 选填字段(可标注 `[待客户补充]` 继续)

- 当地销售网络与维修设施
- 当地主要竞争对手(若不填则阶段二自动调研)
- 客户语气偏好(影响 welcome_message 措辞)
- 已有素材资产(产品图除外——产品图必须在阶段四开始前上传)

### 4.5 阶段一产出(在对话内输出)

- **需求清单**(markdown 格式,1 页内)
- **遗漏项提示**(若有 `[待客户补充]` 字段)

输出后简要复述,询问是否调整,确认后进入阶段二。

---

## 5. 阶段二:Meta 平台市场分析(4 部分)

### 5.1 核心原则

- 仅产出"会进入 plan_json 字段或影响素材内容"的信息,**不做市场进入决策、不做品牌战略调研**
- 所有数据必须**联网搜索获取近 12 个月最新值**(用 `web_search` + `read_webpage`)
- 所有数据标注**来源 + 时间**(示例:"根据 Statista 2026-03 数据")
- 数据源清单调用 `read_skill_reference({ name: "data-sources" })`

### 5.2 输出结构(4 部分)

| 部分 | 内容 | 后续阶段如何使用 |
|---|---|---|
| **【1】CTW 平台环境** | 该市场近 12 月 Meta CTW 类广告 CPM/CTR/Conversation cost 基准、用户活跃高峰 | 阶段三 16 章 KPI 预测 |
| **【2】竞品 CTW 打法** | Meta Ads Library 上同价位竞品的 CTA 是否使用 WhatsApp Message、卖点占比、创意风格 | 阶段三 04 章应对策略 |
| **【3】受众配置关键词** | 兴趣**关键词**(不是 ID)、行为关键词、年龄/性别/地区/语言 | 阶段五 plan_json 的 targeting 字段 |
| **【4】合规红线** | Meta 平台政策 + 当地法规(德国 Impressum / 法国汽车广告强制语 / 中东文化禁忌等)+ 汽车行业禁词 | 阶段四素材合规检查、阶段五合规校验 |

> ⚠️ 不再做:6 维度市场评分 / Tier 1/2/3 分层 / 竞品产品参数对比表 / SWOT / Persona 故事化画像 / 借势节日。这些不进入 plan_json,与 CTW 投放无关。

### 5.3 受众配置:不允许硬编码 ID

阶段二只输出**关键词清单**,不输出 Meta 兴趣/行为 ID。原因:

- skill 工具白名单内**没有** `targetingsearch`,无法实时查询 ID
- Meta v24+ 持续合并/废弃定向选项,旧 ID 容易投放报错
- ID 转换由宿主 `draft_ad_plan` 内部处理

### 5.4 阶段二产出(在对话内输出完整 markdown)

包含 4 部分内容,每部分至少 1 张表 / 1 段总结。每条数据必须标注来源 + 时间。

输出后简要复述结论,询问是否调整,确认后进入阶段三。

---

## 6. 阶段三:10 章 CTW 投放策划案

### 6.1 核心原则

- **10 章框架**(契约 v1.1 7.4 节锁定):章节编号与标题严格按 6.2 节速查表,不允许新增、删除、重命名
- 每章已聚焦 CTW 投放执行直接相关的内容,删除装饰性框架(SMART / SWOT / Brand Story 详细展开)
- 涉及调研的章节(04 / 05)直接引用阶段二报告对应部分,不重复展开
- 每章必须有具体数字,严禁"较多""较高"等模糊表达
- 章节详细模板调用 `read_skill_reference({ name: "strategy-template" })`

### 6.2 10 章速查(详细模板见 reference)

| 章节 | 标题 | 核心内容(瘦身要点) |
|---|---|---|
| 01 | 执行摘要 | 1 页,核心 KPI + 总预算 + 周期 + 预期 ROI |
| 02 | 项目目标 | 1 段,直接落数字,不展开 SMART |
| 03 | 产品卖点 | 3 行,3 卖点 + 起售价 + 竞品对标价 |
| 04 | 竞品 Meta 打法 + 我方应对 | 引用阶段二【2】,单表(竞品弱点 → 我方动作);**核心传播主线一句话融入此章**,不另起品牌定位章节 |
| 05 | 受众分组与 Meta 定向配置 | 引用阶段二【3】,广告组拆分 + targeting 关键词 + 各市场预算占比 |
| 06 | 漏斗与版位规划 | **CTW 漏斗:广告 → WhatsApp 首响 → 跟进 → 试驾**(无落地页);版位预算分配;**WhatsApp 首响策略要点**(welcome_message 设计 + 客服 SLA + 对话脚本)融入此章 |
| 07 | 素材规划与 A/B 测试 | 素材清单概览 + A/B 测试框架(变量 / 样本量 / 显著性判定);**Meta CTW 执行规范**(advantage_audience: 0、出价策略、版位选择)融入此章 |
| 08 | 数据埋点 Pixel/CAPI + UTM | **仅 CAPI Conversation 事件**(不写 Pixel 落地页转化、不写 GTM/GA4);UTM 命名规范 |
| 09 | 排期 + KPI 预测 + ROI 测算 | 三段式排期(测试 / 放大 / 优化)+ **CTW 指标预测**(CPM / CTR / cost per conversation / conversation→hot lead 率)+ ROI 敏感性分析 |
| 10 | 附录 | 多语言文案(含 welcome_message 各市场版本)/ UTM 规范 / 命名 / 风险预案 / 数据来源 |

> v1.1 已删除独立章节(融入其他章节或不再适用):原 06 品牌定位、09 多渠道策略、11 多渠道执行、13 落地页优化、14 SEO/KOL 内容营销。详见契约 v1.1 第 7.4 节。

### 6.3 用户角色分支额外产出(写在策划案末尾,简短即可)

- **品牌方**:简明决策记录段(每个关键决策的 why)
- **代理商**:SCQA 提案大纲段(Situation / Complication / Question / Answer)
- **出海平台**:多品牌批量化建议段(同模板可复用要点 + 各品牌差异化要点)

### 6.4 阶段三产出(在对话内输出完整 markdown)

按 10 章顺序输出。每章必须有内容,不允许"详情见后"占位。

输出后简要复述,询问是否调整,确认后进入阶段四。

---

## 7. 阶段四:CTW 素材生成

### 7.1 开始前必须校验:用户是否已上传产品图

`generate_ad_creative` 工具**强制要求** `reference_image_ids`(用户上传的产品图序号)。如果用户尚未上传:

> "阶段四需要您先上传车型产品图(透明背景或干净背景的官方图最佳)。
> 请上传后告诉我,我会基于您的产品图生成 Meta CTW 广告图。"

**不要**用工具直接尝试,会返回 `{ error: 'no_reference_images' }` 后中断。

### 7.2 工具规格(已注入,不要在 prompt 里重复)

`generate_ad_creative` 工具内部已自动注入以下属性,**禁止**在 `product_description` 里重复约束:

- 输出尺寸:1080×1080 PNG
- 风格:studio-grade 商业摄影
- 产品保真控制(基于参考图)
- Headline 文字 overlay(由 `headline` 字段渲染)
- WhatsApp 风格绿色 CTA 按钮(由工具自动加)
- 文字占比 ≤20%(工具内部硬约束)

### 7.3 工具签名

```
generate_ad_creative({
  product_name:        string,        // 必填
  product_description: string,        // 必填,50-200 字卖点 + 视觉描述
  headline:            string,        // 必填,会被渲染到图上的标题(≤40 字符)
  reference_image_ids: number[],      // 必填,1-based,引用用户已上传的产品图
  target_countries?:   string[],      // 可选,ISO-2 码
  language?:           string,        // 可选,默认 "English"
})
→ 成功: { url, model }
→ 失败: { error, message }  // 包括 'no_reference_images'
```

### 7.4 三步流程

#### 步骤 1:输出素材任务清单

按版位×创意方向×A/B 变体×市场语言交叉,在对话中输出 markdown 表格。注意所有素材**仅 1080×1080**(工具固定),版位说明仅作 Meta 后台投放参考。

| 素材编号 | 创意方向 | A/B 变体 | 主打卖点 | 目标市场/语言 | 对应广告组 |
|---|---|---|---|---|---|
| CR-001 | 科技感 | 变体 A | 长续航 | DE/德语 | DE_TIER1_FAMILY |
| ... | ... | ... | ... | ... | ... |

#### 步骤 2:针对每个素材调用 `generate_ad_creative`

每个素材一次调用。`product_description` 要写**卖点 + 视觉氛围 + 场景**,**不要**写"高分辨率""商业风格""绿色按钮"等被工具内部已处理的属性。

`headline` 要本地化(目标市场语言),≤40 字符。

工具调用成功后,在对话内呈现:

- 素材编号 + 工具返回的 `url`
- 配套 Meta 文案(Primary Text ≤125 / Description ≤30)
- **welcome_message**(本地化,纯文本第一人称,含产品名 + 一个开放式问题,详见 7.5)
- 合规检查清单(参照 reference 第 4 节当地市场规则)

#### 步骤 3:全部素材生成完毕后,输出汇总表

| 素材编号 | url | headline | welcome_message 摘要 | 合规检查 | 状态 |
|---|---|---|---|---|---|

### 7.5 welcome_message 设计要求(契约 6.4 必填)

每条 ad **必须**有 welcome_message,作为用户点击广告进入 WhatsApp 后看到的第一句话。

**强制规则**:

- 纯文本,**第一人称**(以品牌或销售身份说话)
- **必须包含产品名**(车型)
- **必须含一个开放式问题**(引导用户回复)
- 语言匹配目标市场(德国 → 德语 / 法国 → 法语 / 中东英语市场 → 英语)
- 经过母语者审核(产出物附 ⚠️ 审核提示)

**示例(德语,BYD Seal)**:

> Hallo! Ich freue mich, dass Sie sich für den BYD Seal interessieren.
> Welche Funktion ist Ihnen am wichtigsten – Reichweite, Innenraum oder Preis?

### 7.6 阶段四产出(在对话内输出)

- 素材任务清单表
- 每个素材的 url(由工具返回)+ Meta 文案 + welcome_message + 合规检查
- 全素材汇总表

输出后简要复述,询问是否调整,确认后进入阶段五。

详细规格调用 `read_skill_reference({ name: "meta-creative-specs" })`。

---

## 8. 阶段五:Meta CTW 投放方案

### 8.1 双产物

| 产物 | 用途 |
|---|---|
| **plan_json**(以 ` ```json ` 代码块输出) | 阶段六由宿主接续提交给 `draft_ad_plan` 工具的输入 |
| **后台操作手册**(markdown) | 给运营人员手填 Meta Ads Manager 用 |

### 8.2 plan_json 严格要求

- `campaigns` 数组**长度严格 = 1**
- `campaign.objective` = `OUTCOME_ENGAGEMENT`
- `adset.optimization_goal` = `CONVERSATIONS`
- `adset.destination_type` = `WHATSAPP`
- `adset.promoted_object` = `{ page_id, whatsapp_phone_number }`
- `adset.targeting.targeting_automation` = `{ advantage_audience: 0 }`
- `creative.link_data.call_to_action.type` = `WHATSAPP_MESSAGE`
- 多市场用同 campaign 下多个 ad_sets,按 `targeting.countries` 切分
- **每条 ad 必须包含** `welcome_message` 字段(契约 6.4)
- 详细 schema 调用 `read_skill_reference({ name: "meta-api-template" })`

### 8.3 后台操作手册结构

1. 投放总览卡(品牌/车型/市场/周期/预算/CTW 配置)
2. Meta 后台填写指引(逐字段表)
3. 投放前检查清单(WhatsApp Business 已绑定 / 客服已就位 / 母语审核已完成 等)
4. 全量合规校验报告(覆盖 CTW 锁定字段、各市场合规、文案禁词)

### 8.4 阶段五产出(在对话内完整输出)

```
1. plan_json(完整 JSON,代码块)
2. 后台操作手册(markdown,完整内容)
3. 全量合规校验报告(checklist 形式)
```

输出完成后**不写**"流程到此结束""感谢使用"等收尾语——宿主会接续 `draft_ad_plan` 调用完成 CTW 收口。

---

## 9. 全 Skill 执行原则

1. **CTW 锁定**:所有阶段产出涉及 Meta 投放参数时严格使用第 2.1 锁定值,清除第 2.2 禁用枚举
2. **独立调用 + 依赖校验**:五阶段不强制顺序,但每阶段开始前按 3.1 节输入契约校验前置产出;走到 `draft_ad_plan` 仍需有真实 generate_ad_creative 调用记录
3. **对话内输出**:所有产出在 assistant 回复中以完整 markdown 直接呈现
4. **联网取数**:阶段二所有市场数据通过 `web_search` + `read_webpage` 获取最新值
5. **关键词不 ID**:targeting 字段输出关键词,不输出 Meta ID(skill 不能查 ID)
6. **产品图前置**:阶段四开始前必须确认用户已上传产品图
7. **welcome_message 必填**:阶段四 / 五的每条 ad 都必须有
8. **不写阶段六**:阶段五结尾不收尾,宿主接续

---

## 10. 参考文件索引(用 `read_skill_reference` 工具调用)

| 文件 | 调用名 | 作用 |
|---|---|---|
| `references/data-sources.md` | `data-sources` | 阶段二数据源清单 + CTW 行业 KPI 基准 |
| `references/strategy-template.md` | `strategy-template` | 阶段三 10 章详细模板(契约 v1.1 7.4 节锁定) |
| `references/meta-creative-specs.md` | `meta-creative-specs` | 阶段四 generate_ad_creative 工具用法 + 各市场合规 + welcome_message 模板 |
| `references/meta-api-template.md` | `meta-api-template` | 阶段五 plan_json schema + 后台手册模板 + 全量合规校验清单 |
