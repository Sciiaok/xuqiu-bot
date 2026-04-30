# overseas-ad-planning skill · 我方改动明细（vs 原版）

> 本文件列出 LeadEngine 自动获客 Agent 引入原版 `overseas-ad-planning` skill 时做的所有改动。**用于交接给原作者参考，并作为日后迭代时双方约定的"差量"基线。**
>
> 本次改动的根本原因：原版 skill 是为 Claude.ai 通用环境设计、覆盖 Meta + Google + LinkedIn + TikTok 多渠道，输出走文件落盘 + Python 脚本运行；而我们的运行宿主是一个**只投 Meta Click-to-WhatsApp、走自动 Graph API 链路、对话内交付**的 B2B 外贸获客系统。两者预设差异巨大，必须做适配。

文档维护责任：
- 原作者 → 维护原版 skill
- 我方（宿主集成方）→ 维护 patch 后的 skill 版本 + 本明细 + [`overseas-ad-planning.CONTRACT.md`](overseas-ad-planning.CONTRACT.md)
- 原版 skill 升级时，我方负责把改动重新合到新版上

---

## 改动分类总览

| 类别 | 范围 | 涉及文件 |
|---|---|---|
| 1. 移除"落盘 + present_files"路径 | 全局 | SKILL.md + 4 个 references |
| 2. 图片生成工具切换 | 阶段四 | SKILL.md, references/meta-creative-specs.md |
| 3. 阶段五双文档语义彻底改造 | 阶段五 | SKILL.md, references/meta-api-template.md |
| 4. CTW 锁定（投放约束）| 阶段三/四/五 全部 | SKILL.md + 3 个 references |
| 5. 策略案非 Meta 章节调整 | 阶段三 | references/strategy-template.md |
| 6. frontmatter description 同步更新 | 元数据 | SKILL.md |

---

## 1. 移除"落盘 + present_files"路径

**原因**：宿主没有文件系统、没有 Python 沙箱、没有 `present_files` 工具。skill 原本要求每阶段产出保存为 `.md` / `.py` / `.csv` 到 `/mnt/user-data/outputs/` 再调 `present_files` 呈现；这条路径在我们这里完全跑不通。

**改法**：所有"保存为文件 + present_files 呈现"的指令一律删除，改为"在对话中直接以完整 markdown / 代码块输出"。同时加反向约束（"不要使用 present_files / 不要落盘 / 本系统没有文件系统"）作为模型护栏。

**具体位置**：
- SKILL.md 系统概述流程图：阶段二/三/四/五的"输出 .md 文件"等措辞改为"在对话中输出"
- SKILL.md 核心原则：增加"对话内交付"的反向约束
- SKILL.md 各阶段的执行步骤：删除 `output_path = Path("/mnt/...")` Python 示例、删除"调用 `present_files`"指令
- SKILL.md 阶段五"文件输出"列表（`Meta_API_投放脚本_xxx.py` / `Meta_批量导入_xxx.csv` / `OpenRouter调用说明_xxx.md`）：删除
- SKILL.md 全流程执行原则总结 #6"文件化交付"→"对话内交付"

---

## 2. 阶段四图片生成工具切换

**原因**：宿主自带专门为 Click-to-WhatsApp B2B 场景调优的图片生成服务（`generate_ad_creative` 工具），有强制参考图、产品保真控制、headline overlay、WA 风格 CTA 按钮等定制行为。让 skill 走 OpenRouter Python 脚本会绕过这些约束，且需要用户自备 OpenRouter API Key 并手动跑脚本，不可行。

**改法**：阶段四从"输出 OpenRouter 调用代码 + 用户跑 Python"切换为"调用宿主 `generate_ad_creative` 工具"。

**具体位置**：
- SKILL.md 阶段四目标：从"三类内容"减为"两类内容 + 调工具生图"
- SKILL.md 阶段四核心强制规则 #2：从"适配 OpenRouter 模型"→"通过宿主 `generate_ad_creative` 工具"
- SKILL.md 阶段四输入要求 #5："OpenRouter API Key"删除，改为"用户上传的产品参考图"（工具强制要求）
- SKILL.md 阶段四步骤 3：从"生成 OpenRouter Python 脚本"重写为"为每个素材并行调一次 `generate_ad_creative`"
- references/meta-creative-specs.md 第 6 节：约 110 行的"OpenRouter API 调用模板"整段替换为"`generate_ad_creative` 工具调用规范"，含工具签名、调用约定、A/B 差异化要求、错误处理

**新增的工具规范要点**（references/meta-creative-specs.md 第 6 节）：
- 工具签名：`generate_ad_creative({ product_name, product_description, headline, reference_image_ids, target_countries?, language? })` → `{ url, model } | { error, message }`
- 调用约定：每素材调一次；同轮并行；A/B 变体的 headline / product_description 必须显著差异化
- 强制参考图：用户没上传产品图就停下来提示
- 输出固定 1080×1080 PNG，自动 overlay headline 文字 + WhatsApp 风格绿色 CTA 按钮
- 在 product_description 里**不要**重复约束："1080×1080" / "studio-grade lighting" / "no text overlays" / "preserve product fidelity"——这些工具内部已强制注入

---

## 3. 阶段五双文档语义彻底改造

**原因**：原版 skill 阶段五输出"文档 A：让运营人员手填 Meta 后台" + "文档 B：技术人员跑 Python 脚本 / 导 CSV"。这两条路径**都不是我们的实际投放方式**——宿主有自己的 `meta-launch.service.js` 自动化投放链路，用户只需在 UI 点一次"启动投放"按钮，零手工操作。

**改法**：双文档**保留两份输出**这个结构（用户对系统将做什么有透明度），但**重新定义语义**：

| 文档 | 原版语义 | 我方语义 |
|---|---|---|
| 文档 A | Meta 后台填写指引（运营人员照做）| **投放配置预览**（客户审核系统将自动配置的参数）|
| 文档 B | API 技术文档：Python 脚本 + CSV + 配置说明（技术人员执行）| **API 字段映射参考**（技术评审看系统将向 Meta API 发什么字段；纯 markdown，无 Python，无 CSV）|

**核心立场转换**：从"教用户怎么操作"→"向用户透明展示系统将做什么"。

**具体位置**：
- SKILL.md 阶段五目标段：重写"对接到 Meta 后台"→"向用户透明展示宿主系统即将自动部署的 Meta 投放配置"
- SKILL.md 阶段五新增"CTW 锁定"段（详见类别 4）
- SKILL.md 阶段五核心强制规则 #8：从"输出 Python + CSV"→"纯 markdown 字段映射，禁止输出 Python/CSV"
- SKILL.md 阶段五文档 A intro：重写"让运营人员逐字段填写"→"向客户展示系统将自动配置的全貌"
- SKILL.md 阶段五文档 B intro + 必含部分：从"Python 脚本必含部分（8 项）"→"字段映射表必含板块（5 个表）"
- SKILL.md 阶段五执行流程 #6/#7/#8：调整为对话内输出 + 不调用 present_files
- references/meta-api-template.md 第二部分（文档 A 模板）：重写为"投放配置预览"模板，含投放总览 + Campaign/AdSet/Ad 字段表 + 上线前检查清单 + 合规报告 + 上线后监控指南
- references/meta-api-template.md 第三部分（文档 B 模板）：约 165 行的 Python 脚本 + CSV 模板**整段删除**，替换为约 85 行的 markdown 字段映射模板（Campaign / Ad Set / Creative / Ad / 上线流程 6 个区块）
- references/meta-api-template.md 第六部分（投放执行操作指南）：删除"运行 python xxx.py" / "导入 CSV" / "后台手工填写"三个分步流程；替换为"系统自动完成投放"说明 + 用户视角操作

---

## 4. CTW 锁定（贯穿 skill）

**原因**：宿主只投 Meta Click-to-WhatsApp 一种广告形式。Meta API 字段必须严格锁定一组特定枚举值，模型在阶段三/四/五里不能选其它值。这是宿主的硬约束，必须显式写在 skill 内文中（光靠 host-patch 兜底不够强，模型容易被原 skill 的多目标语境带偏）。

**锁定字段速查表**：

| Meta API 字段 | 锁定值 |
|---|---|
| `campaign.objective` | `OUTCOME_ENGAGEMENT` |
| `campaign.special_ad_categories` | `[]` |
| `campaign.buying_type` | `AUCTION` |
| `campaign.campaign_budget_optimization` | `true`（CBO 开启） |
| `adset.optimization_goal` | `CONVERSATIONS` |
| `adset.billing_event` | `IMPRESSIONS` |
| `adset.destination_type` | `WHATSAPP` |
| `adset.promoted_object` | `{ page_id, whatsapp_phone_number }` |
| `adset.targeting.targeting_automation` | `{ advantage_audience: 0 }` |
| `creative.object_story_spec.link_data.link` | `https://api.whatsapp.com/send` |
| `creative.object_story_spec.link_data.call_to_action.type` | `WHATSAPP_MESSAGE` |
| `creative.object_story_spec.link_data.call_to_action.value.app_destination` | `WHATSAPP` |
| 每条 ad 必填 | `welcome_message`（WA 开场白纯文本）|

**禁用枚举**（这些原版 skill 里出现过，全部清除并加反向约束）：
- objective: `OUTCOME_LEADS` / `OUTCOME_TRAFFIC` / `OUTCOME_AWARENESS` / `OUTCOME_SALES` / `OUTCOME_APP_PROMOTION`
- optimization_goal: `LEAD_GENERATION` / `LANDING_PAGE_VIEWS` / `LINK_CLICKS`
- CTA type: `LEARN_MORE` / `GET_QUOTE` / `SIGN_UP` / `CONTACT_US` / `SHOP_NOW` / `SUBSCRIBE` / `BOOK_TRAVEL` / `WATCH_MORE`
- 任何指向落地页的 link、任何 Lead Form 配置

**具体位置**：
- SKILL.md 阶段五新增"CTW 锁定"段（约 20 行表格 + 禁用列表）
- SKILL.md 阶段五"投放总览卡"模板：广告系列数量明确为"1 个（CTW 锁定为单 campaign）"
- SKILL.md 阶段四 CTA 选择：从"5+ 种枚举可选"→"WHATSAPP_MESSAGE，不要选其它"
- references/meta-api-template.md 顶部新增"CTW 锁定速查表"（13 个字段）
- references/meta-api-template.md 第一部分 Campaign / Ad Set / Ad / Creative 字段表：每个字段从"通用 ODAX 多选"改为"CTW 锁定值 / 系统将填入的内容"两列
- references/meta-api-template.md 第四部分自动补全规则：把"按用户投放目标自动匹配 ODAX"改为"CTW 锁定不依赖用户选择"
- references/meta-api-template.md 第五部分合规清单：12 项检查全部 CTW 化
- references/meta-creative-specs.md 第 2 节 CTA 枚举表：8 种枚举压成 1 种 `WHATSAPP_MESSAGE` + 反向约束
- references/meta-creative-specs.md 第 5 节单素材输出标准例子：CTA 字段从 `GET_QUOTE` + 落地页 URL 改为 `WHATSAPP_MESSAGE` + WA 跳转协议 + welcome_message 范例
- references/strategy-template.md 7.1 受众分组表：optimization_goal 列从 `LEAD_GENERATION` 改为 `CONVERSATIONS（CTW 锁定）`

---

## 5. 策略案章节调整（references/strategy-template.md）

**原因**：原版 17 章节策划案是覆盖 Meta + Google + LinkedIn + TikTok + 落地页 的通用框架。我们只投 Meta CTW，部分章节内容会**主动误导用户**——读完阶段三策略案以为下一步会投 Google + 部署落地页，但实际只有 Meta CTW。

**改法**：保留 17 章节的完整框架（保证策略全面性、不破坏 skill 整体结构），但对受 CTW 约束影响的章节加 CTW collar 注释或重写。

**具体位置**：
- 顶部新增"宿主系统专属约束（CTW 锁定）"段，明确列出哪些章节因 CTW 约束需要按规则改写
- **第 09 章 渠道策略**：删除 Google / TikTok / LinkedIn 行；预算分配表改为 Meta 内部市场×版位×漏斗维度
- **第 10 章 广告追踪**：明确 CTW 主转化由 Meta 平台自动归因 + WA 闭环捕获到 conversations 表，不依赖 Pixel 自定义事件；GTM/GA4 跨渠道部分简写
- **第 11 章 各渠道执行细节**：删除 Google Ads / LinkedIn / TikTok 三个子节，只写 Meta CTW 投放细节（含完整 CTW 锁定字段）
- **第 13 章**：标题从"落地页优化方案（CRO）"改为"WhatsApp 首响策略（替代落地页）"，全部内容重写为开场白文案规范、客服 SLA、转化漏斗、质量监控
- 7.3 自定义受众：第一方数据源从"Lead 表单提交者 / Pixel 访客"改为"WhatsApp 询盘人（来自 conversations 表）"

---

## 6. frontmatter description 同步更新

**原因**：原版 description 提到"OpenRouter 图片生成 Prompt"和"Meta 后台可视化操作文档"，跟改造后的实际产出不一致。

**改法**：
```diff
- 输出包含市场分析报告、17 章节投放策划案、素材任务清单与 OpenRouter 图片生成 Prompt、
- Meta 后台可视化操作文档与 API 技术文档。
+ 输出包含市场分析报告、17 章节投放策划案、素材任务清单与图片视觉描述、
+ Meta 后台可视化操作文档与 API 技术文档。所有产出在对话中直接以 markdown / 代码块形式呈现，
+ 图片通过宿主提供的 generate_ad_creative 工具生成。
```

---

## 文件大小对比（改前 → 改后）

| 文件 | 改前 | 改后 | 变化 |
|---|---|---|---|
| SKILL.md | ~14000 字节 | ~12500 字节 | -1500（删 present_files / Python 示例 / 17 章节描述简化）|
| references/meta-creative-specs.md | 13066 字节 | 8429 字节 | -4637（删 OpenRouter Python 模板 110 行）|
| references/meta-api-template.md | 22719 字节 | 15670 字节 | -7049（删 Python 脚本 165 行 + CSV + 手工填写指南）|
| references/strategy-template.md | 11233 字节 | 7449 字节 | -3784（删多渠道执行细节 + 重写第 13 章）|
| references/data-sources.md | 1902 字节 | 1902 字节 | 0（未改动）|
| **整体 zip** | 33KB | 33KB | 持平 |

整体内容净减少约 17KB，对话中 token 消耗显著下降，且模型不再被多渠道 / Lead Gen 语境带偏。

---

## 没动的部分

- 阶段一：六维度需求收集流程（CTW 适用，未改）
- 阶段二：海外广告市场分析的 7 部分固定输出结构 + data-sources.md 数据源清单（CTW 通用，未改）
- 阶段三 17 章节框架本身（章节列表保留，仅对受 CTW 影响的章节注释/改写）
- references/data-sources.md（汽车行业数据源清单，CTW 通用）
- skill 整体的"五阶段顺序执行 + 每阶段产出是下阶段输入"的核心 SOP 设计

---

## 后续协作模式

- 本明细随 skill bundle 一起在我方仓库版本管理（路径 `skills/overseas-ad-planning.CHANGES.md`）
- 原作者发布新版后，我方对照本明细重新合并改动到新版
- 改动应符合 [`overseas-ad-planning.CONTRACT.md`](overseas-ad-planning.CONTRACT.md) 里的接口约束；如新版需要打破某条约束，请提前与我方沟通
