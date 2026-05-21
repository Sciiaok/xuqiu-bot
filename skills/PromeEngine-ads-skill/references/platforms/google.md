# Google Ads 平台投放规范

> 适用 dim5 D1:`google`
> V_1.0 状态:**留作扩展,主投平台为 Meta**。本文件提供 Google 投放的基础规范,实战未深度验证。

---

## 一、Google Ads 账号体系(宿主自动注入)

| 字段 | 类型 | 用途 |
|---|---|---|
| `google_ads_customer_id` | string | Google Ads 账号 ID |
| `merchant_center_id` | string | Google Merchant Center ID(Shopping 必需) |
| `ga4_property_id` | string | GA4 数据集 ID |
| `google_business_profile_id` | string | Google 商家号 ID(若有) |

未注入时 skill 阶段 1 询问用户绑定。

---

## 二、Google 在 D2 资源位下的映射

| D2 资源位 | Google 广告类型 |
|---|---|
| `gg-uac` | App Campaign(原 Universal App Campaign) |
| `gg-shopping` | Shopping Campaign |
| `gg-search` | Search Campaign(留作扩展)|
| `gg-display` | Display Network(留作扩展)|
| `gg-youtube` | YouTube Ads(留作扩展)|

V_1.0 重点:UAC + Shopping。

---

## 三、CTW 类似形式在 Google

Google 没有原生 CTW 等价物,B2B 引流到 WhatsApp 通常通过:

1. **Google Search Ads + 文本 CTA "Chat on WhatsApp"** → 落地页跳转 WhatsApp
2. **Google Display Ads + 横幅** → 落地页跳转 WhatsApp
3. **YouTube In-stream Ads + 链接** → 落地页跳转 WhatsApp

**V_1.0 不深度支持 Google CTW 路径**(因为汽车 B2B 现货的客户当前主要跑 Meta CTW)。

---

## 四、Google UAC(应用安装)

适用 App 推广场景,V_1.0 不重点用,但保留规范。

锁定字段:

| 字段 | 锁定值 |
|---|---|
| campaign_type | UNIVERSAL_APP |
| optimization_goal | APP_INSTALLS / IN_APP_ACTION |
| bidding_strategy | TARGET_CPA / MAXIMIZE_CONVERSIONS |

---

## 五、Google Shopping(商品目录广告)

适用 B2B 商品目录场景,V_1.0 不重点用,但保留规范。

需 Merchant Center 商品 feed,字段 ID / title / description / price / image / availability 等。

---

## 六、设备字段映射

| D3 抽象值 | Google API 字段 |
|---|---|
| mobile-ios | device: ["MOBILE"] + os: ["IOS"] |
| mobile-android | device: ["MOBILE"] + os: ["ANDROID"] |
| tablet | device: ["TABLET"] |
| desktop | device: ["DESKTOP"] |
| other | 不指定 |

---

## 七、Google 投放合规

- Google Ads Policy:类似 Meta 通用合规
- 各国法规同 Meta(详见 references/compliance.md)
- YouTube Community Guidelines(若投视频)

---

## 八、状态

⚠️ **V_1.0 内测期**:Google 投放规范结构搭好,但深度内容(plan_json 子 schema、后台手册、KPI 基准)待真实投放后补全。

skill 在用户选 Google 时,产出带 `⚠️ Google 投放内测期·未深度验证` 标记。

---

## 九、扩展待办

- [ ] 补 plan_json 子 schema(Google Ads API v15 结构)
- [ ] 补后台操作手册(Google Ads Manager 填写路径)
- [ ] 补 Google × 各国 KPI 基准(需真实投放)
- [ ] 补 GA4 转化追踪配置(若 V_2.0 接 Pixel)
