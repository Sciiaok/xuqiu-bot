# Meta 平台投放规范

> 适用 dim5 D1:`fb` / `ig`
> 内部统一为 Meta Ads Manager,但策划层区分 FB / IG(数据回流、用户习惯、素材策略不同)
> V_1.0 锁定的广告形式:**CTW(Click-to-WhatsApp)**

---

## 一、Meta 平台账号体系(宿主自动注入)

skill 启动时,宿主在 system prompt 注入以下字段,**严禁向用户询问**:

| 字段 | 类型 | 用途 |
|---|---|---|
| `waba_id` | string | WhatsApp Business Account ID |
| `verified_name` | string | 认证名 |
| `display_number` | string | 显示号码 |
| `phone_number_id` | string | 阶段 6 plan_json 必需 |
| `page_id` | string | Facebook Page ID |
| `instagram_actor_id` | string | Instagram 账号 ID |

绑定多账号时 skill 阶段 1 主动询问选哪个。

---

## 二、5 月真实平台分布数据

### 2.1 渠道分布(您 2026-05 实测)

| 渠道 | 花费 | 展示 | CTR | 对话量 | CPA | 花费占比 |
|---|---|---|---|---|---|---|
| **Facebook ★** | $766.92 | 365,620 | **3.77%** | 1,170 | $0.66 | **73%** |
| Instagram | $284.34 | 109,263 | 1.29% | 138 | $2.06 | 27% |
| WhatsApp Status | $0.27 | 275 | 0.73% | 0 | -- | 0.03% |

**洞察**:
- FB 是绝对主力,73% 花费 / 89% 对话 / CTR 高出 IG 2.9 倍
- IG 性价比偏低,CPA $2.06 是 FB 的 3.1 倍
- WhatsApp Status 几乎无量,可关闭

### 2.2 版位分布(您 5 月实测,降序)

| 渠道 | 版位 | 花费 | CTR | 对话量 | CPA |
|---|---|---|---|---|---|
| **FB Feed ★** | feed | $513.79 | **4.62%** | 825 | $0.62 |
| **FB Reels** | facebook_reels | $207.60 | 2.05% | 281 | $0.74 |
| IG Reels | instagram_reels | $126.12 | 1.13% | 72 | $1.75 |
| IG Feed | feed | $113.08 | 1.56% | 52 | $2.17 |
| IG Stories | instagram_stories | $44.85 | 1.99% | 14 | $3.20 |
| FB Reels Overlay | facebook_reels_overlay | $13.80 | 0.83% | 11 | $1.25 |
| FB Stories | facebook_stories | $13.33 | **3.42%** | 20 | $0.67 |
| **FB Marketplace** | marketplace | $6.70 | 1.27% | 15 | **$0.45** |

**关键发现**:
- **FB Feed = 金牌版位**(49% 花费 / 63% 对话 / CTR 4.62% 最高)
- **FB Reels = 性价比扩量首选**(20% 花费 / 21% 对话 / CPA $0.74)
- **FB Marketplace = CPA 最低**($0.45),可加预算放量
- **IG Stories CPA 最贵**($3.20),建议暂停或单独测试
- **IG Reels 转化贵**($1.75),需审查 IG 素材

### 2.3 设备分布(您 5 月实测)

| 设备 | 花费 | 展示 | CTR | 对话量 | CPA | 占比 |
|---|---|---|---|---|---|---|
| **Android Smartphone ★** | $846.41 | 414,532 | 3.08% | 1,139 | $0.74 | 80.5% |
| iPhone | $203.07 | 59,920 | **4.03%** | 167 | $1.22 | 19.3% |
| Android Tablet | $1.67 | 624 | 3.37% | 1 | $1.67 | 0.16% |
| iPad | $0.38 | 81 | 2.47% | 1 | $0.38 | 0.04% |
| other | $0 | 1 | -- | 0 | -- | 0% |

**洞察**:
- Android 是绝对主投设备(80.5% 花费)
- **iPhone CTR 4.03% 高出 Android 31%,CPA $1.22 高出 65%**:iPhone 用户互动强但成本贵,值得分组测试
- Tablet/iPad 量极小(<0.2%),可关闭或合并

### 2.4 跨维度组合(FB × iPhone)

**FB × iPhone CTR 高达 5.94%**(全表最高组合),CPA $0.91。建议作为单独 ad_set 测试加量。

---

## 三、D2 资源位 → Meta 版位映射

策划层用 D2 资源位,plan_json 输出阶段自动展开:

| 策划层 D2 | Meta API placement |
|---|---|
| `fb-feed` | `facebook_positions: ["feed"]` |
| `fb-non-feed` | `facebook_positions: ["marketplace", "right_hand_column", "facebook_reels", "facebook_stories", "instream_video", "search"]` |
| `ig-feed` | `instagram_positions: ["stream"]` |
| `ig-reels` | `instagram_positions: ["reels", "story", "explore"]` |
| `advantage-placement` | `publisher_platforms: ["facebook", "instagram"]` + 不指定 positions |

**注意**:`advantage-placement` 模式下,Meta 自动选位,在 plan_json 中不指定 facebook_positions / instagram_positions 字段。

---

## 四、D3 设备 → Meta 字段映射

| D3 抽象 | Meta API 字段 |
|---|---|
| mobile-ios | `device_platforms: ["mobile"]` + `user_os: ["iOS"]` |
| mobile-android | `device_platforms: ["mobile"]` + `user_os: ["Android"]` |
| tablet | `device_platforms: ["mobile"]` + `user_device: ["tablet"]`(Meta 把 tablet 归入 mobile) |
| desktop | `device_platforms: ["desktop"]` |
| other | 不指定 device 限制 |

---

## 五、Meta CTW 锁定字段(★ **本节内容仅阶段 6 使用,阶段 2-5 严禁据此预设**)

> **★ 强约束(SKILL.md §9.1)**:本节字段是**阶段 6 输出 plan_json 时**必须使用的锁定值——
> LeadEngine V_1.0 host 只能 launch CTW,所以最终 plan_json 必须长这样。
>
> **阶段 2-5 读到此节请只取背景理解,不要据此预设广告形式 / 不要把字段名拿到对话产出
> / 不要在阶段 3 模板里硬编码 "CTW 投放生态" / 不要在阶段 4 KPI 里硬编码 CPQL**。
> 违反 = 重大违规。
>
> 阶段 2-5 应根据目标市场实际可行性推荐路径,可能是 Lead Form / Web Conv / Google UAC /
> TikTok 等。详见 SKILL.md §0.3、§4、§8.1。
>
> 阶段 2 用户已在 §4.3 Case B/C 拍板,**阶段 6 不再二次问 a/b/c**,直接按拍板结果出
> lose 清单 + plan_json(详见 SKILL.md §8.1 Case C)。

### 5.1 必须使用的锁定值

| Meta API 字段 | 锁定值 | 说明 |
|---|---|---|
| `campaign.objective` | `WHATSAPP_CONVERSATIONS` | CTW 必需(宿主锁定值) |
| `campaign.special_ad_categories` | `[]` | 汽车不属特殊类别 |
| `campaign.buying_type` | `AUCTION` | 标准竞价 |
| `campaign.campaign_budget_optimization` | `true` | 启用 CBO |
| `adset.optimization_goal` | `CONVERSATIONS` | 对话优化 |
| `adset.billing_event` | `IMPRESSIONS` | 按展示计费 |
| `adset.destination_type` | `WHATSAPP` | CTW 必需 |
| `adset.promoted_object` | `{ page_id, whatsapp_phone_number }` | 来自宿主注入 |
| `adset.targeting.targeting_automation.advantage_audience` | `0` | 关闭智能扩展 |
| `creative.link_data.link` | `https://api.whatsapp.com/send` | CTW 跳转 |
| `creative.link_data.call_to_action.type` | `WHATSAPP_MESSAGE` | CTA 类型 |
| `creative.link_data.call_to_action.value.app_destination` | `WHATSAPP` | -- |

### 5.2 禁用字段(plan_json 不允许出现)

- `objective`:`OUTCOME_LEADS` / `OUTCOME_TRAFFIC` / `OUTCOME_AWARENESS` / `OUTCOME_SALES` / `OUTCOME_APP_PROMOTION`
- `optimization_goal`:`LEAD_GENERATION` / `LANDING_PAGE_VIEWS` / `LINK_CLICKS` / `OFFSITE_CONVERSIONS` / `REACH`
- `CTA type`:`LEARN_MORE` / `GET_QUOTE` / `SIGN_UP` / `CONTACT_US` / `SHOP_NOW` / `SUBSCRIBE` / `BOOK_TRAVEL` / `WATCH_MORE`
- 任何 Lead Form 配置
- 任何指向落地页的 link(必须是 `https://api.whatsapp.com/send`)

### 5.3 单 campaign 约束

- `campaigns.length === 1`
- 多市场用同 campaign 下多 ad_set 按 `targeting.countries` 切分

### 5.4 welcome_message 字段

- 纯文本,第一人称
- 必含产品名 + 一个开放式问题
- 按目标市场使用当地语言或英语
- **字符上限动态**:每次执行时 web_search 拉取 Meta API 当前 welcome_message 限制(过往实测撞过 `(#100)` 拒绝),内部锁定到 `platform_country_rules`

---

## 六、Meta 各广告形式(阶段 2 路径选择参考)

阶段 2 推荐时,**真正按市场+业务模式选最合适的形式**,不预设 CTW:

| 广告形式 | objective | optimization_goal | destination_type | 何时推荐 | V_1.0 可落库? |
|---|---|---|---|---|---|
| **CTW** | WHATSAPP_CONVERSATIONS | CONVERSATIONS | WHATSAPP | 价敏新兴 / 中东 / 拉美 / 东南亚 B2B | ✅ |
| CTM(Click-to-Messenger) | MESSAGES | CONVERSATIONS | MESSENGER | 客户偏好 Messenger 沟通 | ❌(等 V_2.0) |
| Instant Form(Lead Form) | OUTCOME_LEADS | LEAD_GENERATION | -- | EU / 英美 B2B 主流;GDPR consent 内置 | ❌(等 V_2.0) |
| Website Conversions | OUTCOME_SALES | OFFSITE_CONVERSIONS | -- | 有落地页 + Pixel;转化追踪完整 | ❌(等 V_2.0) |
| App Install | OUTCOME_APP_PROMOTION | APP_INSTALLS | -- | App 推广 | ❌(等 V_2.0) |
| DPA | OUTCOME_SALES | OFFSITE_CONVERSIONS | -- | 商品目录电商 | ❌(等 V_2.0) |
| Awareness | OUTCOME_AWARENESS | REACH | -- | 品牌曝光 | ❌(等 V_2.0) |

### 6.1 形式 × 市场可行性矩阵(阶段 2 推荐**起点**,不是直接答案)

| 市场分类 | CTW 推荐度 | Lead Form 推荐度 | Web Conv 推荐度 | 推荐起点 |
|---|---|---|---|---|
| 价敏新兴(IQ/NG/EG/MX/PE 等) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | **CTW** |
| 中产成长(PH/VN/TH/ID/KZ/UZ) | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | **CTW** |
| 中东石油 / 高 AOV(SA/AE/JO) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | **CTW + Lead Form A/B** |
| 欧洲发达(DE/FR/UK/IT/ES) | ⭐⭐(GDPR 受限) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **Lead Form** |
| 英美澳(US/CA/AU) | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **Web Conv** |
| 日韩(JP/KR) | ⭐⭐(WhatsApp 渗透低) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **Lead Form / Web Conv** |

> 阶段 2 推荐时,**先用本矩阵定起点,再用 web_search 验证后才能表态**(SKILL.md §4.1 Step 2/3)。
> 直接套本矩阵跳过 web_search = 重大违规。
> **不是无脑给 CTW**;不是无脑套用本表。详细背景见 [`compliance.md §2.6`](../compliance.md)。

> ⚠️ V_1.0 host 只支持 CTW 落地,推非 CTW 路径时:
> - **阶段 2 让用户在 a/b/c 拍板**(SKILL.md §4.3 Case C)
> - **阶段 6 按拍板结果蒸馏 + 出 lose 清单**(SKILL.md §8.1 Case C,不再二次问)

---

## 七、Meta 后台操作手册模板

### 7.1 创建广告系列(Engagement → Messaging Apps)

操作路径:**Meta Ads Manager → 创建 → 互动量 → Click to Message**

| Meta 后台字段(中文) | 应填值 |
|---|---|
| 营销目标 | 互动量(Engagement)→ Click to Message |
| 广告系列名称 | {Brand}_{Model}_CTW_{YYYYMMDD} |
| 特殊广告类别 | 无 |
| 单日预算 | $XX(总预算 / 总天数) |
| 广告系列预算优化 | 开启 |
| 出价策略 | 最低费用(Lowest Cost) |
| 状态 | 暂停(待审核后启用) |

### 7.2 创建广告组

| Meta 字段 | 应填值 |
|---|---|
| 广告组名称 | {Country}_{D1}_{Audience}_{D3} |
| 优化目标 | 对话(Conversations) |
| 计费方式 | 展示量(Impressions) |
| 转化目标 | WhatsApp(消息应用) |
| 关联 WhatsApp 账号 | (宿主注入的 phone_number_id 对应号码) |
| 受众-地区 | (目标国 ISO-2) |
| 受众-语言 | (本地语言 + 英语) |
| 受众-兴趣关键词 | (skill 输出的关键词,Meta 后台模糊匹配) |
| Advantage+ Audience | **关闭** |
| 版位 | (按 D2 选,详见 §3 映射) |
| 设备 | (按 D3 选,详见 §4 映射) |
| 状态 | 暂停 |

### 7.3 创建广告

| Meta 字段 | 应填值 |
|---|---|
| 广告名称 | {AdSet}_{CR-编号} |
| Facebook 主页 | (宿主注入 page_id 对应主页) |
| Instagram 账号 | (宿主注入 instagram_actor_id) |
| 媒体类型 | 单图 |
| 创意素材 | 上传 CR-XXX.png(来自阶段 5) |
| 主标题(Headline) | (阶段 5 产出,≤40 字符) |
| 主要文字(Primary Text) | (阶段 5 产出,≤125 字符) |
| 描述(Description) | (阶段 5 产出,≤30 字符) |
| 行动号召按钮 | 发送 WhatsApp 消息 |
| 着陆链接 | https://api.whatsapp.com/send(锁定) |
| 欢迎消息 | (阶段 5 产出的 welcome_message) |
| 状态 | 暂停 |

### 7.4 投放前检查清单

- WhatsApp 账号已绑 Meta Business Manager
- phone_number_id 可接收消息(Test Message)
- 客服/销售已就位(B2B 现货建议 ≤ 2 小时 SLA)
- welcome_message 已经过当地母语者审核
- 24h 模板消息已配置(超 24h 跟进用)
- 预算告警已配置
- 所有素材通过合规检查
- **所有广告默认 PAUSED,人工审核后启用**

---

## 八、plan_json 完整示例(单 campaign × 2 ad_set × 4 ad)

```json
{
  "channel": "fb_ig",
  "ad_format": "ctw",
  "summary": "Foton AUMARK 6 国 B2B 现货 CTW 投放,3 个月 $5,000,预期 70-120 个高价值询盘",
  "whatsapp": {
    "phone_number_id": "(宿主注入)"
  },
  "estimated_metrics": {
    "total_budget_usd": 5000,
    "duration_months": 3,
    "expected_conversations": 1250,
    "expected_qualified_leads": 70,
    "expected_cpql_usd": 15,
    "data_source_note": "Based on user's 5-month real data + industry benchmarks"
  },
  "campaigns": [
    {
      "name": "Foton_AUMARK_CTW_20260601",
      "objective": "WHATSAPP_CONVERSATIONS",
      "status": "PAUSED",
      "special_ad_categories": [],
      "buying_type": "AUCTION",
      "campaign_budget_optimization": true,
      "daily_budget_cents": 5556,
      "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
      "ad_sets": [
        {
          "name": "FB_IQ_B2B_DEALERS_MOBILE_ANDROID",
          "optimization_goal": "CONVERSATIONS",
          "billing_event": "IMPRESSIONS",
          "destination_type": "WHATSAPP",
          "promoted_object": {
            "page_id": "(宿主注入)",
            "whatsapp_phone_number": "(宿主注入)"
          },
          "targeting": {
            "geo_locations": { "countries": ["IQ"] },
            "age_min": 28,
            "age_max": 55,
            "interest_keywords": ["importer", "car dealer", "commercial vehicle"],
            "publisher_platforms": ["facebook"],
            "facebook_positions": ["feed"],
            "device_platforms": ["mobile"],
            "user_os": ["Android"],
            "targeting_automation": { "advantage_audience": 0 }
          },
          "start_time": "2026-06-01T00:00:00+0000",
          "end_time": "2026-08-31T23:59:59+0000",
          "status": "PAUSED",
          "ads": [
            {
              "name": "FB_IQ_B2B_DEALERS_MOBILE_ANDROID_CR-001",
              "status": "PAUSED",
              "creative_typology_id": "#1-inventory-yard",
              "creative": {
                "name": "Foton_AUMARK_CR-001",
                "image_url": "(阶段 5 工具返回 url)",
                "object_story_spec": {
                  "page_id": "(宿主注入)",
                  "instagram_actor_id": "(宿主注入)",
                  "link_data": {
                    "link": "https://api.whatsapp.com/send",
                    "message": "Ready-stock Foton AUMARK light trucks at our Tianjin warehouse. Bulk supply available.",
                    "name": "Ready Stock Today",
                    "description": "Chat for stock list",
                    "call_to_action": {
                      "type": "WHATSAPP_MESSAGE",
                      "value": { "app_destination": "WHATSAPP" }
                    }
                  }
                }
              },
              "welcome_message": "We have ready-to-ship Foton AUMARK inventory at our warehouse. Which models and quantity are you looking for, and what's your target port?",
              "first_contact_binding": "spot-inventory-confirm"
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 九、CTW 平台规则速查

| 规则 | 限制 |
|---|---|
| welcome_message 字符上限 | 动态(每次执行 web_search 查最新,过往撞过 #100 拒绝)|
| 单 campaign ad_set 数量 | Meta 无硬限制,实操建议 ≤ 10 个 |
| 单 ad_set ad 数量 | 建议 2-4 个 A/B 变体 |
| 频次阈值 | 2.5-3.0 后需换素材(建议 2-3 周轮换)|
| 24h 模板消息 | 用户首次主动联系后 24 小时内自由回复;超 24h 需 Meta 批准模板消息 |

---

## 十、自动查规则(skill 阶段 2 调用)

skill 阶段 2 用 `web_search` 自动查询(每会话执行 1 次,缓存 7 天):

| 查询主题 | 关键词模板 |
|---|---|
| Meta CTW 政策 | `Meta CTW Click-to-WhatsApp ad policy {当前年月}` |
| welcome_message 限制 | `WhatsApp Business welcome message character limit format {当前年月}` |
| 目标国广告法 | `{country} advertising law automotive ads {当前年月}` |
| 车型进口限制 | `{country} import restrictions {vehicle type} {当前年月}` |
| 文化禁忌 | `{country} advertising cultural taboo` |

结果存内部 `platform_country_rules`,后续阶段引用。
