# 阶段五:plan_json schema + 后台操作手册模板 + 全量合规校验

本文件为阶段五的执行参考。**阶段五必须同时输出**:

- **plan_json**(作为 ` ```json ` 代码块直接输出在对话中)— 阶段六由宿主接续提交给 `draft_ad_plan` 工具
- **后台操作手册**(完整 markdown 输出)— 给运营人员手填 Meta Ads Manager 用
- **全量合规校验报告**(checklist 形式)

> **不输出**:Python 脚本、Shell 脚本、CSV 文件——这些在宿主环境中无法执行/无法保存(契约 3.1 / 3.2)。

---

## 1. plan_json 顶层结构

```json
{
  "summary": "...",
  "whatsapp": {
    "phone_number_id": "..."
  },
  "estimated_metrics": {
    "...": "..."
  },
  "campaigns": [
    {
      "...": "..."
    }
  ]
}
```

### 1.1 顶层字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `summary` | string | 是 | 1-2 句话方案摘要(供宿主展示给用户确认) |
| `whatsapp.phone_number_id` | string | 是 | 客户提供的 Meta WhatsApp 配置(阶段一收集) |
| `estimated_metrics` | object | 是 | KPI 预测,引用阶段三第 16 章数据 |
| `campaigns` | array | 是 | **长度严格 = 1**(契约 6.3) |

### 1.2 estimated_metrics 字段建议

```json
"estimated_metrics": {
  "total_budget_usd": 100000,
  "duration_months": 6,
  "expected_impressions": 5000000,
  "expected_clicks": 75000,
  "expected_ctr_pct": 1.5,
  "expected_conversations": 48000,
  "expected_cost_per_conversation_usd": 2.08,
  "expected_hot_leads": 16800,
  "expected_cost_per_hot_lead_usd": 5.95,
  "data_source_note": "Based on data-sources.md Section 7, validated via web_search 2026-05"
}
```

---

## 2. campaigns 数组结构(长度 = 1)

```json
"campaigns": [
  {
    "name": "BYD_Seal_CTW_20260601",
    "objective": "OUTCOME_ENGAGEMENT",
    "status": "PAUSED",
    "special_ad_categories": [],
    "buying_type": "AUCTION",
    "campaign_budget_optimization": true,
    "daily_budget_cents": 50000,
    "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
    "ad_sets": [
      ...
    ]
  }
]
```

### 2.1 Campaign 字段映射(契约 6.1 锁定)

| 字段 | 必填 | 锁定值 | 说明 |
|---|---|---|---|
| `name` | 是 | `{Brand}_{Model}_CTW_{YYYYMMDD}` | 单一命名格式 |
| `objective` | 是 | **`OUTCOME_ENGAGEMENT`** | 契约锁定,不可改 |
| `status` | 是 | `PAUSED` | 默认暂停,人工审核后启用 |
| `special_ad_categories` | 是 | `[]` | 汽车不属特殊类别 |
| `buying_type` | 是 | `AUCTION` | 契约锁定 |
| `campaign_budget_optimization` | 是 | `true` | 契约锁定(等同启用 ACB) |
| `daily_budget_cents` | 视情况 | 单位:分/美分 | 总预算 / 总天数 |
| `bid_strategy` | 否 | `LOWEST_COST_WITHOUT_CAP` 推荐 | 测试期默认 |

### 2.2 禁用字段(不要出现在 plan_json)

- ❌ `objective`:`OUTCOME_LEADS` / `OUTCOME_TRAFFIC` / `OUTCOME_AWARENESS` / `OUTCOME_SALES` / `OUTCOME_APP_PROMOTION`
- ❌ `smart_promotion_type`(v25+ 已废弃)
- ❌ `existing_customer_budget_percentage`(v25 移除)

---

## 3. ad_sets 数组结构(单 campaign 下多个 ad_set)

```json
"ad_sets": [
  {
    "name": "DE_TIER1_FAMILY",
    "optimization_goal": "CONVERSATIONS",
    "billing_event": "IMPRESSIONS",
    "destination_type": "WHATSAPP",
    "promoted_object": {
      "page_id": "<品牌 Facebook Page ID>",
      "whatsapp_phone_number": "<E.164 国际格式>"
    },
    "targeting": {
      "geo_locations": { "countries": ["DE"] },
      "age_min": 36,
      "age_max": 50,
      "interest_keywords": ["Family", "Sport utility vehicle", "Road trip"],
      "behavior_keywords": ["In-market for new vehicle", "Parents (children 4-12)"],
      "publisher_platforms": ["facebook", "instagram"],
      "facebook_positions": ["feed"],
      "instagram_positions": ["stream", "reels", "story"],
      "device_platforms": ["mobile", "desktop"],
      "targeting_automation": { "advantage_audience": 0 }
    },
    "start_time": "2026-06-01T00:00:00+0000",
    "end_time": "2026-11-30T23:59:59+0000",
    "status": "PAUSED",
    "ads": [
      ...
    ]
  }
]
```

### 3.1 Ad Set 字段映射(契约 6.1 锁定)

| 字段 | 必填 | 锁定值 | 说明 |
|---|---|---|---|
| `name` | 是 | `{Country}_{Tier}_{Audience}` | 来自策划案附录 E |
| `optimization_goal` | 是 | **`CONVERSATIONS`** | 契约锁定 |
| `billing_event` | 是 | `IMPRESSIONS` | 契约锁定 |
| `destination_type` | 是 | **`WHATSAPP`** | 契约锁定 |
| `promoted_object.page_id` | 是 | 客户 Facebook Page ID | 阶段一收集 |
| `promoted_object.whatsapp_phone_number` | 是 | E.164 格式(如 `+4915123456789`) | 阶段一收集 |
| `targeting.targeting_automation.advantage_audience` | 是 | **`0`** | 契约锁定(关闭智能扩展) |
| `targeting.interest_keywords` | 否 | 关键词数组 | **关键词,不是 ID**;ID 转换由宿主处理 |
| `targeting.behavior_keywords` | 否 | 关键词数组 | 同上 |
| `start_time` / `end_time` | 是 | ISO 8601 格式 | 阶段一周期 |
| `status` | 是 | `PAUSED` | 默认暂停 |

### 3.2 关键说明:targeting interest/behavior 输出关键词,不输出 ID

- skill 工具白名单内**没有** `targetingsearch`,无法实时查询 Meta 兴趣 / 行为 ID
- 因此 plan_json 中 `interest_keywords` 与 `behavior_keywords` 是**关键词数组**,不是 ID
- 宿主 `draft_ad_plan` 工具内部会负责把关键词转换为 Meta API 实际接受的 ID
- 如果某关键词在 Meta 找不到对应定向选项,宿主会返回错误或自动剔除

### 3.3 禁用字段

- ❌ `optimization_goal`:`LEAD_GENERATION` / `LANDING_PAGE_VIEWS` / `LINK_CLICKS` / `OFFSITE_CONVERSIONS` / `IMPRESSIONS` / `REACH`
- ❌ `genders: [0]`(改为省略字段或 `[1, 2]`)
- ❌ Lead Form ID 配置

---

## 4. ads 数组结构(每个 ad set 下多个 ad)

```json
"ads": [
  {
    "name": "DE_TIER1_FAMILY_CR-001",
    "status": "PAUSED",
    "creative": {
      "name": "BYD_Seal_CR-001",
      "image_url": "<generate_ad_creative 工具返回的 url>",
      "object_story_spec": {
        "page_id": "<品牌 Facebook Page ID>",
        "instagram_actor_id": "<品牌 Instagram 账号 ID>",
        "link_data": {
          "link": "https://api.whatsapp.com/send",
          "message": "Erleben Sie die Zukunft des Fahrens...",
          "name": "Bis zu 600 km Reichweite (WLTP)",
          "description": "Gespräch starten",
          "call_to_action": {
            "type": "WHATSAPP_MESSAGE",
            "value": {
              "app_destination": "WHATSAPP"
            }
          }
        }
      }
    },
    "welcome_message": "Hallo! Ich freue mich, dass Sie sich für den BYD Seal interessieren. Welche Funktion ist Ihnen am wichtigsten – Reichweite, Innenraum oder Preis?"
  }
]
```

### 4.1 Ad 字段映射(契约 6.1 / 6.4 锁定)

| 字段 | 必填 | 锁定值 | 说明 |
|---|---|---|---|
| `name` | 是 | `{AdSetName}_{CreativeID}` | 来自附录 E 命名规范 |
| `status` | 是 | `PAUSED` | 默认暂停 |
| `creative.image_url` | 是 | `generate_ad_creative` 工具返回的 url | 阶段四产出 |
| `creative.link_data.link` | 是 | **`https://api.whatsapp.com/send`** | 契约锁定 |
| `creative.link_data.message` | 是 | Meta Primary Text(≤125) | 阶段四产出 |
| `creative.link_data.name` | 是 | Meta Headline(≤40) | 阶段四产出 |
| `creative.link_data.description` | 否 | Meta Description(≤30) | 阶段四产出 |
| `creative.link_data.call_to_action.type` | 是 | **`WHATSAPP_MESSAGE`** | 契约锁定 |
| `creative.link_data.call_to_action.value.app_destination` | 是 | **`WHATSAPP`** | 契约锁定 |
| `welcome_message` | 是 | 本地化纯文本,含产品名 + 开放式问题 | **契约 6.4 必填** |

### 4.2 禁用字段

- ❌ CTA `type`:`LEARN_MORE` / `GET_QUOTE` / `SIGN_UP` / `CONTACT_US` / `SHOP_NOW` / `SUBSCRIBE` / `BOOK_TRAVEL` / `WATCH_MORE`
- ❌ 任何指向落地页的 `link`(必须是 `https://api.whatsapp.com/send`)
- ❌ Lead Form 配置

---

## 5. 完整 plan_json 示例(单 campaign,2 个 ad set,每个 ad set 含 2 个 ad)

```json
{
  "summary": "BYD Seal 在德国与英国 6 个月 CTW 投放方案,总预算 100,000 USD,目标获取 48,000 条 WhatsApp 对话与 16,800 条 hot lead。",
  "whatsapp": {
    "phone_number_id": "123456789012345"
  },
  "estimated_metrics": {
    "total_budget_usd": 100000,
    "duration_months": 6,
    "expected_conversations": 48000,
    "expected_cost_per_conversation_usd": 2.08,
    "expected_hot_leads": 16800,
    "data_source_note": "data-sources.md §7, web_search validated 2026-05"
  },
  "campaigns": [
    {
      "name": "BYD_Seal_CTW_20260601",
      "objective": "OUTCOME_ENGAGEMENT",
      "status": "PAUSED",
      "special_ad_categories": [],
      "buying_type": "AUCTION",
      "campaign_budget_optimization": true,
      "daily_budget_cents": 55555,
      "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
      "ad_sets": [
        {
          "name": "DE_TIER1_FAMILY",
          "optimization_goal": "CONVERSATIONS",
          "billing_event": "IMPRESSIONS",
          "destination_type": "WHATSAPP",
          "promoted_object": {
            "page_id": "100000000000001",
            "whatsapp_phone_number": "+4915123456789"
          },
          "targeting": {
            "geo_locations": { "countries": ["DE"] },
            "age_min": 36,
            "age_max": 50,
            "interest_keywords": ["Family", "Sport utility vehicle", "Road trip"],
            "behavior_keywords": ["In-market for new vehicle", "Parents (children 4-12)"],
            "publisher_platforms": ["facebook", "instagram"],
            "facebook_positions": ["feed"],
            "instagram_positions": ["stream", "reels", "story"],
            "device_platforms": ["mobile", "desktop"],
            "targeting_automation": { "advantage_audience": 0 }
          },
          "start_time": "2026-06-01T00:00:00+0000",
          "end_time": "2026-11-30T23:59:59+0000",
          "status": "PAUSED",
          "ads": [
            {
              "name": "DE_TIER1_FAMILY_CR-001",
              "status": "PAUSED",
              "creative": {
                "name": "BYD_Seal_CR-001",
                "image_url": "https://storage.example.com/CR-001.png",
                "object_story_spec": {
                  "page_id": "100000000000001",
                  "instagram_actor_id": "200000000000002",
                  "link_data": {
                    "link": "https://api.whatsapp.com/send",
                    "message": "Erleben Sie die Zukunft des Fahrens. Modernste E-Mobilität mit großzügiger Reichweite.",
                    "name": "Bis zu 600 km Reichweite (WLTP)",
                    "description": "Gespräch starten",
                    "call_to_action": {
                      "type": "WHATSAPP_MESSAGE",
                      "value": { "app_destination": "WHATSAPP" }
                    }
                  }
                }
              },
              "welcome_message": "Hallo! Ich freue mich, dass Sie sich für den BYD Seal interessieren. Welche Funktion ist Ihnen am wichtigsten – Reichweite, Innenraum oder Preis?"
            },
            {
              "name": "DE_TIER1_FAMILY_CR-002",
              "status": "PAUSED",
              "creative": {
                "name": "BYD_Seal_CR-002",
                "image_url": "https://storage.example.com/CR-002.png",
                "object_story_spec": {
                  "page_id": "100000000000001",
                  "instagram_actor_id": "200000000000002",
                  "link_data": {
                    "link": "https://api.whatsapp.com/send",
                    "message": "Smart, sicher und nachhaltig. Der neue BYD Seal für Ihre Familie.",
                    "name": "BYD Seal — Familie zuerst",
                    "description": "Jetzt mehr erfahren",
                    "call_to_action": {
                      "type": "WHATSAPP_MESSAGE",
                      "value": { "app_destination": "WHATSAPP" }
                    }
                  }
                }
              },
              "welcome_message": "Hallo! Schön, dass Sie sich für den BYD Seal interessieren. Wann möchten Sie die nächste Probefahrt machen?"
            }
          ]
        },
        {
          "name": "UK_TIER1_TECH",
          "optimization_goal": "CONVERSATIONS",
          "billing_event": "IMPRESSIONS",
          "destination_type": "WHATSAPP",
          "promoted_object": {
            "page_id": "100000000000001",
            "whatsapp_phone_number": "+447700900123"
          },
          "targeting": {
            "geo_locations": { "countries": ["GB"] },
            "age_min": 28,
            "age_max": 45,
            "interest_keywords": ["Electric vehicle", "Sustainable energy", "Smart car technology"],
            "behavior_keywords": ["In-market for new vehicle", "Premium brand auto buyers"],
            "publisher_platforms": ["facebook", "instagram"],
            "facebook_positions": ["feed"],
            "instagram_positions": ["stream", "reels", "story"],
            "device_platforms": ["mobile", "desktop"],
            "targeting_automation": { "advantage_audience": 0 }
          },
          "start_time": "2026-06-01T00:00:00+0000",
          "end_time": "2026-11-30T23:59:59+0000",
          "status": "PAUSED",
          "ads": [
            {
              "name": "UK_TIER1_TECH_CR-003",
              "status": "PAUSED",
              "creative": {
                "name": "BYD_Seal_CR-003",
                "image_url": "https://storage.example.com/CR-003.png",
                "object_story_spec": {
                  "page_id": "100000000000001",
                  "instagram_actor_id": "200000000000002",
                  "link_data": {
                    "link": "https://api.whatsapp.com/send",
                    "message": "The future of driving — premium electric performance with up to 600 km range.",
                    "name": "Up to 600 km WLTP Range",
                    "description": "Start a chat",
                    "call_to_action": {
                      "type": "WHATSAPP_MESSAGE",
                      "value": { "app_destination": "WHATSAPP" }
                    }
                  }
                }
              },
              "welcome_message": "Hi there! I'm glad you're interested in the BYD Seal. What matters most to you — range, interior space or price?"
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 6. 后台操作手册模板(给运营人员手填 Meta Ads Manager 用)

阶段五除了 plan_json,还要在对话内输出以下 markdown 内容:

```markdown
# {Brand} {Model} CTW 后台操作手册

## 一、投放总览卡

| 项目 | 内容 |
|---|---|
| 品牌/车型 | XXX |
| 目标市场 | XXX |
| 投放周期 | YYYY-MM-DD ~ YYYY-MM-DD |
| 总预算 | XXX USD |
| Marketing API 版本 | v25.0(执行时校验最新版本) |
| Campaign 数量 | **1**(契约锁定) |
| Ad Set 数量 | X 个(按市场切分) |
| Ad 数量 | X 个 |
| WhatsApp 配置 | phone_number_id: XXX |

## 二、Meta 后台填写指引(逐字段)

### 2.1 创建广告系列(单个,Engagement → CTW)

操作路径:Meta Ads Manager → 创建 → 选择目标 → Engagement → Messaging Apps

| Meta 后台字段(中文) | 字段(英文) | 应填入的值 | 说明 |
|---|---|---|---|
| 营销目标 | Campaign Objective | 互动量(Engagement)→ Click to Message | 契约锁定 OUTCOME_ENGAGEMENT |
| 广告系列名称 | Campaign Name | BYD_Seal_CTW_20260601 | 命名规范 |
| 特殊广告类别 | Special Ad Categories | 无 / None | 汽车不属特殊类别 |
| 单日预算 | Daily Budget | 555.55 USD | 总预算 / 总天数 |
| 广告系列预算优化 | Campaign Budget Optimization | 开启 | 契约锁定 true |
| 出价策略 | Bid Strategy | 最低费用(Lowest Cost) | 测试期默认 |
| 状态 | Status | 暂停(PAUSED) | 默认 PAUSED 待人工审核 |

### 2.2 创建广告组(每个 Ad Set 都列出)

操作路径:在 Campaign 下点击「创建广告组」

#### Ad Set 1:DE_TIER1_FAMILY

| 字段 | 应填入的值 |
|---|---|
| 广告组名称 | DE_TIER1_FAMILY |
| 优化目标 | 对话(Conversations) |
| 计费方式 | 展示量(Impressions) |
| 转化目标 | WhatsApp(消息应用) |
| 关联 WhatsApp 账号 | +4915123456789 |
| 受众-地区 | 德国 |
| 受众-年龄 | 36 - 50 |
| 受众-性别 | 全部 |
| 受众-语言 | 德语 / 英语 |
| 受众-兴趣 | Family, Sport utility vehicle, Road trip(由 Meta 后台搜索匹配) |
| 受众-行为 | In-market for new vehicle, Parents (children 4-12) |
| **Advantage+ Audience** | **关闭**(契约锁定 advantage_audience: 0) |
| 版位 | 手动:Instagram Feed/Reels/Story + Facebook Feed |
| 投放排期 | 2026-06-01 ~ 2026-11-30 |
| 状态 | 暂停 |

#### Ad Set 2:UK_TIER1_TECH(相同结构,字段值不同)

### 2.3 创建广告(每个 Ad 都列出)

#### Ad 1:DE_TIER1_FAMILY_CR-001

| 字段 | 应填入的值 |
|---|---|
| 广告名称 | DE_TIER1_FAMILY_CR-001 |
| Facebook 主页 | <品牌主页> |
| Instagram 账号 | <品牌 IG> |
| 媒体类型 | 单图 |
| 创意素材 | 上传 CR-001.png(来自阶段四,1080×1080) |
| 主标题 | Bis zu 600 km Reichweite (WLTP) |
| 主要文字 | Erleben Sie die Zukunft... |
| 描述 | Gespräch starten |
| 行动号召按钮 | 发送 WhatsApp 消息(WHATSAPP_MESSAGE) |
| 着陆链接 | https://api.whatsapp.com/send(契约锁定) |
| **欢迎消息** | (粘贴 welcome_message 完整内容) |
| 状态 | 暂停 |

## 三、投放前检查清单

- [ ] WhatsApp Business 账号已绑定 Meta Business Manager
- [ ] phone_number_id 已验证可接收消息(Test Message)
- [ ] 客服 / 销售已就位,能在 SLA 内响应(详见策划案 13 章)
- [ ] welcome_message 已经过当地母语者审核
- [ ] 24h 模板消息已配置(用于超 24h 跟进)
- [ ] 预算告警已配置
- [ ] 所有素材已通过合规检查(参见 meta-creative-specs.md 第 7 节)
- [ ] **所有广告默认 PAUSED,待人工审核启用**

## 四、合规检查报告

(详见下方第七部分全量合规校验清单)
```

---

## 7. 全量合规校验清单(阶段五必输出)

### 7.1 CTW 锁定字段校验

- [ ] `campaigns.length === 1`
- [ ] `campaign.objective === "OUTCOME_ENGAGEMENT"`
- [ ] `campaign.special_ad_categories === []`
- [ ] `campaign.buying_type === "AUCTION"`
- [ ] `campaign.campaign_budget_optimization === true`
- [ ] **所有** ad_set 的 `optimization_goal === "CONVERSATIONS"`
- [ ] **所有** ad_set 的 `billing_event === "IMPRESSIONS"`
- [ ] **所有** ad_set 的 `destination_type === "WHATSAPP"`
- [ ] **所有** ad_set 的 `promoted_object` 含 `page_id` 和 `whatsapp_phone_number`
- [ ] **所有** ad_set 的 `targeting.targeting_automation.advantage_audience === 0`
- [ ] **所有** ad 的 `creative.link_data.link === "https://api.whatsapp.com/send"`
- [ ] **所有** ad 的 `creative.link_data.call_to_action.type === "WHATSAPP_MESSAGE"`
- [ ] **所有** ad 的 `creative.link_data.call_to_action.value.app_destination === "WHATSAPP"`

### 7.2 禁用枚举校验(以下值不应出现)

- [ ] 没有 objective:`OUTCOME_LEADS` / `OUTCOME_TRAFFIC` / `OUTCOME_AWARENESS` / `OUTCOME_SALES` / `OUTCOME_APP_PROMOTION`
- [ ] 没有 optimization_goal:`LEAD_GENERATION` / `LANDING_PAGE_VIEWS` / `LINK_CLICKS` / `OFFSITE_CONVERSIONS` / `IMPRESSIONS`(作为 optimization_goal)/ `REACH`
- [ ] 没有 CTA type:`LEARN_MORE` / `GET_QUOTE` / `SIGN_UP` / `CONTACT_US` / `SHOP_NOW` / `SUBSCRIBE` / `BOOK_TRAVEL` / `WATCH_MORE`
- [ ] 没有 Lead Form ID 配置
- [ ] 没有指向落地页的 link(必须是 `https://api.whatsapp.com/send`)
- [ ] 没有废弃字段:`smart_promotion_type` / `existing_customer_budget_percentage`
- [ ] 没有 `genders: [0]`(改为省略或 `[1, 2]`)

### 7.3 必填字段校验

- [ ] `whatsapp.phone_number_id` 已填
- [ ] `summary` 已填
- [ ] `estimated_metrics` 已填且引用 data-sources.md
- [ ] **每条 ad** 的 `welcome_message` 字段已填(契约 6.4)
- [ ] welcome_message 含产品名 + 开放式问题
- [ ] welcome_message 已本地化到 ad_set 的 country 对应语言

### 7.4 命名与状态校验

- [ ] Campaign / AdSet / Ad / Creative 命名全局一致(英文 snake_case)
- [ ] **所有 status 默认 `PAUSED`**

### 7.5 目标市场合规(逐市场,详见 meta-creative-specs.md 第 4 节)

- [ ] 德国:续航标 WLTP / 价格标 ab / 客服 GDPR 提示
- [ ] 法国:含三条强制语之一 / CO₂ 排放可见
- [ ] 英国:ASA CAP Code / 续航标 WLTP / 加速标测试条件
- [ ] 欧盟:DSA 广告原因披露 / GDPR 同意条款
- [ ] 美国:FTC #ad / EPA MPGe / Starting at
- [ ] 中东:文化禁忌检查 / VAT 标注 / 阿拉伯语母语审核
- [ ] 东南亚:本地语言审核 / 文化适配

### 7.6 文档完整性

- [ ] plan_json 完整输出在对话中(代码块)
- [ ] 后台操作手册完整输出在对话中(markdown)
- [ ] 全量合规校验报告完整输出在对话中(checklist)
- [ ] 阶段四生成的每个 image_url 已正确填入 plan_json 对应 ad

---

## 8. 投放执行说明(给客户/运营看)

### 8.1 后续步骤说明(放在阶段五输出末尾)

> 上述 plan_json 是 LeadEngine 的标准输入格式,系统会自动接续完成 CTW 投放方案的提交。
>
> 同时,后台操作手册可供运营人员在 Meta Ads Manager 中手动核验或调整。
>
> 投放前请务必完成「投放前检查清单」中的全部事项,确保 WhatsApp 客服已就位、母语审核已通过。

> ⚠️ **不要写**"流程到此结束""感谢使用"等收尾语——契约 7.3 明确,阶段五完成后宿主 host-patch 会接续调用 `draft_ad_plan`,需要平稳过渡。

---

## 9. 与未来扩展能力的接口预留(契约第九部分)

如果后续宿主升级,以下能力可能开放(由宿主集成方决定):

| 能力 | 当前状态 | plan_json 影响 |
|---|---|---|
| 多尺寸图片(4:5 / 9:16) | 仅 1:1 | 无影响,creative.image_url 不变 |
| 视频素材 | 不支持 | 需新增 `creative.video_url` 字段 |
| 多 campaign | 锁定 1 个 | `campaigns.length` 上限解锁 |
| 非 CTW 投放(Lead Gen) | 不支持 | 涉及全字段重构,**本 skill 不在此场景使用** |
| Pixel / CAPI 配置 | 不集成 | 需新增 `pixel_id` / `tracking` 字段 |
