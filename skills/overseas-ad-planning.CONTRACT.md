# overseas-ad-planning skill · 接口契约（与 LeadEngine 宿主系统）

> 本文件定义 LeadEngine 自动获客 Agent（"宿主"）对 `overseas-ad-planning` skill bundle 的接口约束。**skill 作者迭代时必须遵守，否则宿主端集成会断裂。**
>
> 本契约的存在前提是：skill 包是可热替换资产（解包后的目录落到 `skills/<name>/`），宿主代码与 skill 内容物理隔离。只要契约不破，skill 作者可以自由迭代内容；契约破了，宿主端要同步改代码或拒绝加载。
>
> 文档版本：v1.2（2026-05-14，bundle 形态由 zip 改为目录）

---

## 第一部分：bundle 文件结构

### 1.1 命名与位置

skill 包必须以目录形态落地为 `skills/overseas-ad-planning/`，**目录名严格等于 skill 名**。

```
skills/overseas-ad-planning/
├── SKILL.md               # 必须，主文档
└── references/            # 可选，按需添加
    ├── data-sources.md
    ├── strategy-template.md
    ├── meta-creative-specs.md
    └── meta-api-template.md
```

### 1.2 SKILL.md 必须存在

主文档必须命名为 `SKILL.md`（大小写敏感），位于顶级目录根。宿主 loader 找不到这个文件会启动失败。

### 1.3 references/ 是可选目录

如果存在，必须命名为 `references/`，仅包含 `.md` 文件。宿主 loader 会扫描该目录下所有 `.md` 文件，按"去掉路径与 `.md` 后缀的 basename"作为 key 索引。

例如 `references/strategy-template.md` 会被索引为 `strategy-template`。模型用 `read_skill_reference({ name: "strategy-template" })` 工具按需取用。

**约束**：
- 不要使用子目录（如 `references/meta/foo.md`）；宿主 loader 行为对子目录文件的 key 命名不保证稳定
- 所有 reference 文件名 basename 必须唯一
- 不允许放非 `.md` 文件

### 1.4 不允许的内容

- 任何二进制资源（图片、PDF、字体等）—— 宿主不解析这些
- `package.json` / `requirements.txt` / `Dockerfile` 等运行时声明 —— 宿主不会执行任何 skill 提供的代码
- 任何 `.py` / `.js` / `.sh` 脚本 —— 同上

---

## 第二部分：SKILL.md frontmatter 规范

### 2.1 必须字段

```yaml
---
name: overseas-ad-planning           # 必须等于目录名 skills/overseas-ad-planning/
description: >
  一句话或一段话，描述这个 skill 做什么、何时被触发。
  支持 YAML 块标量 `>` 折叠多行（loader 会拼成一行）。
---
```

宿主 loader 校验 `frontmatter.name` 必须严格等于"加载时传入的 skill 名"（即 `overseas-ad-planning`）；不匹配会拒绝加载并抛错。这是为了防止你不小心把另一个 skill 的内容塞到这个槽位里。

### 2.2 不要使用其它 frontmatter 字段

宿主 loader 只读 `name` 和 `description`，其它字段会被忽略。如果未来需要添加（如 `version`、`min_host_version`），请先与宿主集成方沟通。

### 2.3 frontmatter 必须用 `---` 包裹，不要用 TOML 或 JSON 格式

loader 用一个简化的 YAML 解析器：
- 支持 `key: value` 单行
- 支持 `key: >` 块折叠多行
- 不支持嵌套 / 数组 / 锚点 / 复杂 YAML 特性

---

## 第三部分：宿主运行环境约束

skill 必须假设运行在以下环境（与 Anthropic Claude.ai 通用环境**有重大差异**）：

### 3.1 没有文件系统

- 模型**不能**写文件到 `/mnt/user-data/outputs/` 或任何路径
- 模型**没有** `Write` / `Bash` / `present_files` 等文件操作工具
- 任何让模型"保存为文件再呈现给用户"的指令都会失败

**正确做法**：所有产出在对话中直接以 markdown / 代码块形式输出。

### 3.2 没有 Python 沙箱

- 模型**不能**执行 Python 代码
- skill 不要让用户"复制保存为本地 .py 文件并运行"——这一步用户做不到（或者就算做了也跟实际投放无关）
- 不要在 skill 中输出可执行 Python 脚本作为交付物

### 3.3 没有 OpenRouter / 其它外部 API 密钥

- 模型不应假设用户有 OpenRouter / Meta / Google API Key
- 所有图片生成、外部数据访问必须通过宿主提供的工具完成
- 不要让用户"自己去 https://openrouter.ai/keys 获取 API Key"

---

## 第四部分：工具白名单

skill 在运行时，模型可以调用的工具**只有以下 5 个**，其它一律不可用。任何 skill 内文要求模型调用其它工具的指令都会导致工具调用失败。

| 工具 | 何时调 | 输入 | 输出 |
|---|---|---|---|
| `web_search` | skill 阶段二需要联网取最新数据时 | `{ query: string }` | `{ results: [{ title, url, snippet }, ...] }` 最多 5 条 |
| `read_webpage` | 配合 web_search，深读单一来源 | `{ url: string }` | `{ content: string }` 最多 ~6000 字 |
| ~~`read_skill_reference`~~ | **已移除（2026-05-13）**：所有 references 现由宿主直接内联到 system prompt 末尾，模型无需调用工具即可读到，命中 Anthropic prompt cache 后单次代价 ≈ 0.1× 输入价 | — | — |
| `generate_ad_creative` | 阶段四生成广告图，每素材调一次 | 见下方 4.1 | 见下方 4.1 |
| `draft_ad_plan` | 阶段六（CTW 收口提交） | 见下方 4.2 | 见下方 4.2 |

### 4.1 `generate_ad_creative` 工具签名

```
generate_ad_creative({
  product_name:        string,        // 必填
  product_description: string,        // 必填，50-200 字卖点 + 视觉描述
  headline:            string,        // 必填，会被渲染到图上的标题（≤40 字符）
  reference_image_ids: number[],      // 必填，1-based 序号数组，引用用户已上传的产品图
  target_countries?:   string[],      // 可选，ISO-2 码
  language?:           string,        // 可选，默认 "English"
})
→ 成功: { url: string, model: string }
→ 失败: { error: string, message: string }
```

工具内部已注入：1080×1080 PNG 输出、studio-grade 商业摄影风格、产品保真控制、headline 文字 overlay、WhatsApp 风格绿色 CTA 按钮、≤20% 文字占比。**不要在 product_description 里重复约束这些**。

参考图强制：用户没上传产品图时，工具返回 `{ error: 'no_reference_images' }`，skill 必须停下来提示用户上传，不要继续阶段四。

详见现版本 `references/meta-creative-specs.md` 第 6 节（这是该工具规范的权威文档；后续工具签名变更会同步更新该节）。

### 4.2 `draft_ad_plan` 工具签名

```
draft_ad_plan({
  summary:           string,
  whatsapp:          { phone_number_id: string },
  estimated_metrics: { ... },
  campaigns:         [...],         // 长度严格 = 1
})
→ 成功: { ok: true, plan_summary, campaigns_count: 1 }
→ 失败: { error: string, message: string, ... }
```

详细 schema 见宿主 `src/agents/ogilvy/index.js` 中 `TOOLS` 数组对应条目。schema 变更会通过本契约文档版本升级通知 skill 作者。

**Sanity check**：宿主会拒绝在"会话历史里没出现过成功的 `generate_ad_creative` 调用"时调用 `draft_ad_plan`。这是反 shortcut 保护——skill 必须先跑完阶段四生图，才能在阶段六提交方案。

> **与独立调用的协调说明(v1.1 新增)**:第七部分 7.1 节允许五阶段独立调用,但本 sanity check 仍然有效。也就是说:
>
> - 独立调用允许从任意阶段进入(如直接跑阶段四单独生图,或直接跑阶段三只做策划案)
> - 但若调用链最终走到 `draft_ad_plan`(阶段六由宿主补丁触发),仍必须在同一会话内有过成功的 `generate_ad_creative` 调用
> - **实际效果**:阶段五可独立调用,但要让 `draft_ad_plan` 真正落地 plan_json,会话历史中必须存在阶段四生图记录(plan_json 中的 `image_url` 必须来自真实工具调用,不能伪造)

### 4.3 不可调用的工具（清单非穷尽）

以下工具在宿主环境中**不存在**，skill 不要假设它们可用：

- `present_files` / 任何文件呈现工具
- `Write` / `Edit` / `Read` / 任何文件 I/O
- `Bash` / 任何 shell / 命令执行
- Python 代码执行 / Jupyter 单元
- 用户授权的第三方 API（OpenRouter / Anthropic 直连 / Meta Graph 等）—— 这些只能由宿主代码间接使用

---

## 第五部分：输出形式约束

### 5.1 所有交付物在对话中直接输出

每阶段的产出（市场分析报告、10 章策划案、素材清单、双文档）必须以**完整 markdown 内容**直接出现在 assistant 消息中。

**禁止**：
- "已保存到 outputs/xxx.md，请见附件"——用户看不到任何附件
- "请运行下面的 Python 脚本"——用户运行不了
- "请下载 CSV 并导入"——同上
- 占位句"（详细内容因篇幅省略，见生成的文件）"——必须输出完整内容

### 5.2 长内容用代码块包裹时，使用 markdown 标准三反引号

例如 Python 代码用 ` ```python`，CSV 用 ` ```csv`，但 **本系统不需要 Python / CSV 产出**（详见第六部分 CTW 锁定）。

### 5.3 references 内文档自身也是模板

skill 内文中的 `references/xxx.md` 模板会被宿主索引；模型在阶段二/三/四/五会用 `read_skill_reference` 工具按需读取。所以 references 自身**也必须**遵守"对话内输出"的产出约束（不能在 reference 里写"保存为文件"指令）。

---

## 第六部分：CTW（Click-to-WhatsApp）投放锁定

宿主只投 **Meta Click-to-WhatsApp** 一种广告形式。skill 必须在阶段三/四/五的所有投放参数描述中遵守以下锁定值，**禁止**列出其它选项让模型选择。

### 6.1 锁定字段（不可改）

| Meta API 字段 | 锁定值 |
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
| `creative.object_story_spec.link_data.link` | `https://api.whatsapp.com/send` |
| `creative.object_story_spec.link_data.call_to_action.type` | `WHATSAPP_MESSAGE` |
| `creative.object_story_spec.link_data.call_to_action.value.app_destination` | `WHATSAPP` |

### 6.2 禁用枚举（必须从 skill 内文中清除，并加反向约束）

- objective: `OUTCOME_LEADS` / `OUTCOME_TRAFFIC` / `OUTCOME_AWARENESS` / `OUTCOME_SALES` / `OUTCOME_APP_PROMOTION`
- optimization_goal: `LEAD_GENERATION` / `LANDING_PAGE_VIEWS` / `LINK_CLICKS` / `OFFSITE_CONVERSIONS` / `IMPRESSIONS` / `REACH`
- CTA type: `LEARN_MORE` / `GET_QUOTE` / `SIGN_UP` / `CONTACT_US` / `SHOP_NOW` / `SUBSCRIBE` / `BOOK_TRAVEL` / `WATCH_MORE`
- 任何 Lead Form 配置、任何指向落地页的 link

### 6.3 单 campaign 约束

- `plan_json.campaigns.length` 严格 = 1
- 多市场用同一 campaign 下的多个 ad_sets 切分（按 `targeting.countries` 分组），不要拆多 campaign

### 6.4 每条 ad 必填 `welcome_message`

- 纯文本第一人称，含产品名 + 一个开放式问题
- 按目标市场使用当地语言或英语
- skill 阶段三 / 四的 ad 模板必须显式要求生成此字段

### 6.5 落地页 / Lead 表单不可用

skill 不要在任何阶段产出"落地页设计 / Lead 表单字段 / 站内转化漏斗"内容。CTW 唯一转化路径是 WhatsApp 对话。如果通用海外广告策划框架包含落地页章节（如原版第 13 章），请改写为"WhatsApp 首响策略"。

### 6.6 跨渠道章节限定为 Meta

skill 不要在任何阶段产出 Google Ads / LinkedIn / TikTok 相关执行细节。如果通用框架包含多渠道章节（如原版第 9 / 11 章），请只保留 Meta 部分。

---

## 第七部分：阶段框架约束

### 7.1 必须保留的核心结构

- **五阶段框架**:需求对接 → 市场分析 → 策略生成 → 素材生成 → Meta 投放方案
- **五阶段独立调用**(v1.1 调整):五阶段**不强制顺序执行**,允许按用户场景从任意阶段进入。每阶段开始前按下表所列「输入契约」校验前置产出是否完整,缺失则:
  - 缺失项较少 → 直接提问补全
  - 缺失项较多 → 走「快速通道」,用最简输入启动该阶段,缺失字段标 `[待客户补充]` 继续

  | 阶段 | 输入契约 | 缺失时处理 |
  |---|---|---|
  | 阶段一 | 用户对话或 brief 文件 | 直接进入,启动收集 |
  | 阶段二 | 阶段一产出(品牌/车型/目标国家/预算/周期等 8 必填字段) | 缺失任一必填字段 → 先调阶段一(快速模式) |
  | 阶段三 | 阶段一产出 + 阶段二的市场分析结论 | 缺失则先补对应阶段 |
  | 阶段四 | 阶段一产出 + 阶段三的素材规划要点 + **用户已上传产品图** | 缺失则先补对应阶段;无产品图必须先提示上传 |
  | 阶段五 | 阶段三产出 + 阶段四产出(含真实素材 url) | 缺失则先补对应阶段 |

  > 详见 4.2 节 sanity check 与独立调用的协调说明:走到 `draft_ad_plan` 仍必须有真实 `generate_ad_creative` 调用记录。
- 每阶段产出由用户确认后再进入下一阶段(无论顺序执行还是独立调用,该确认机制都保留)
- 阶段三的 **10 章节框架**(章节标题与编号,详见本契约 7.4 节附表)

### 7.2 灵活迭代的部分

- 各阶段内的具体输出格式细节、表格列、举例
- 数据源清单（references/data-sources.md）的来源新增/失效更新
- 素材规格表的 Meta 平台规范同步更新
- 各阶段执行步骤的措辞优化

### 7.3 必须新增"阶段六：CTW 收口"的协作约定

宿主端在 host-patch 中追加了"阶段六：CTW 收口提交"指令（让模型完成阶段五后调 `draft_ad_plan`）。**这一步由宿主补丁负责，skill 内文不需要包含**。但 skill 阶段五的最后一句话应该平稳过渡到这一步，不要写"流程到此结束"等收尾语。

### 7.4 阶段三 10 章节框架(v1.1 锁定)

下表为阶段三策划案的章节编号与标题。skill 内文必须严格使用本表的编号与标题,**不允许新增章节、删除章节或重命名**。每章具体内容(模板、表格、举例)由 skill 作者自行设计,属于灵活迭代部分(7.2 节)。

| 章节 | 标题 | 与原 17 章版本的对应 / 处理 |
|---|---|---|
| 01 | 执行摘要 | 对应原 01,保留 |
| 02 | 项目目标 | 对应原 02「项目背景与目标」,保留(瘦身去 SMART 框架展开) |
| 03 | 产品卖点 | 对应原 03「产品/服务分析」,瘦身 |
| 04 | 竞品 Meta 打法 + 我方应对 | 合并原 04「竞争策略推导」(瘦身去 SWOT 展开) |
| 05 | 受众分组与 Meta 定向配置 | 合并原 07「受众分组」+ 部分原 05「市场预算分配」 |
| 06 | 漏斗与版位规划 | 合并原 08「用户旅程」+ 原 09 中 Meta CTW 部分(限定为 CTW 漏斗:广告 → WhatsApp 首响 → 跟进 → 试驾) |
| 07 | 素材规划与 A/B 测试 | 对应原 12「广告素材规划」,保留 |
| 08 | 数据埋点 Pixel/CAPI + UTM | 对应原 10「广告追踪与数据埋点」(瘦身去 GTM/GA4/仪表盘,仅保留 CTW 必需的 Conversation 事件 + UTM) |
| 09 | 排期 + KPI 预测 + ROI 测算 | 合并原 15「6 个月排期」+ 原 16「KPI 预测与 ROI 测算」 |
| 10 | 附录 | 对应原 17,保留多语言文案 / UTM / 命名 / 风险预案 / 数据来源 |

**v1.1 已删除的原章节**(skill 内文不应再包含独立章节):

- 原 06「品牌定位与传播主线」(品牌咨询职能,关键传播主线一句话融入第 04 章应对策略)
- 原 09「渠道策略与预算矩阵」(限定 Meta CTW 后,无多渠道分配,合并到第 06 章)
- 原 11「各渠道执行细节」(同上,Meta CTW 执行规范融入第 07 章)
- 原 13「落地页优化方案」(CTW 无落地页,WhatsApp 首响策略融入第 06 章)
- 原 14「内容营销配套」(SEO/KOL 不属于 CTW 投放执行)

> **业务理由**:章节数从 17 → 10 是基于业务反馈"输出过多"的结构性瘦身。10 章每章必须有具体数字与可执行内容,严禁"较多""较高"等模糊表达。

---

## 第八部分：升级流程

### 8.1 我方迭代发布流程

1. skill 作者交付新版 bundle（目录或 zip 均可，最终落地形态是目录）
2. 我方（宿主集成方）拿到新版后：
   - 在本地用宿主的 loader smoke test 加载校验
   - 覆盖 `skills/overseas-ad-planning/` 目录内容
   - 重启 next.js 服务（loader 模块级缓存只在进程内存活）
3. 跑一次端到端会话验证

### 8.2 skill 作者本地校验（建议）

skill 作者可在本地用以下方式快速验证 bundle 结构合法：

```bash
# 检查目录结构
ls skills/overseas-ad-planning/
ls skills/overseas-ad-planning/references/

# 应看到：
#   SKILL.md
#   references/  (内含 *.md)
```

frontmatter 必须能被简化 YAML 解析器读懂（用 Python 的 `yaml.safe_load` 解析顶部 `---` 块通过即可）。

### 8.3 破坏性变更协调

如果 skill 新版需要打破本契约的任何约束（例如：新增第六阶段、改 frontmatter 格式、要求新工具支持），请**提前**与宿主集成方沟通，由双方共同评估并升级宿主代码。

---

## 第九部分：宿主预留的扩展位

以下是宿主目前**没有**但**可以扩展**的能力。如果 skill 迭代需要，请提案：

| 能力 | 现状 | 扩展成本 |
|---|---|---|
| 多尺寸图片生成（4:5 / 9:16） | 工具固定 1:1 | 中等（需测试模型对非 1:1 的稳定性）|
| 视频素材生成 | 不支持 | 大（需新工具 + 新存储 + 新 Meta 上传链路）|
| 素材外部 URL 引用（不上传产品图）| 不支持 | 小（关 reference_image_ids 强制即可） |
| 多 campaign | 锁定 1 个 | 大（涉及 plan_json schema 改造）|
| 非 CTW 投放（Lead Gen / Traffic 等） | 不支持 | 极大（meta-launch 全套链路改造）|
| Meta Pixel / Conversion API 配置 | 不集成 | 中等 |

---

## 第十部分：联系与反馈

- skill 内容问题、迭代建议：联系原作者
- 宿主集成问题、契约更新、扩展提案：联系 LeadEngine 集成方（即本仓库维护者）
- 紧急 bug（skill 加载失败、模型行为偏离严重）：双方协商，必要时通过 git 回滚 `skills/overseas-ad-planning/` 目录到上一版

---

> 本契约 v1.2 (2026-05-14) 起，skill bundle 形态由 zip 改为目录；不再以 sha256 配套号锚定版本，改用 git 提交历史追踪。
