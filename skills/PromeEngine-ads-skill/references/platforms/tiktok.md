# TikTok Ads 平台投放规范

> 适用 dim5 D1:`tiktok`
> V_1.0 状态:**留作扩展,主投平台为 Meta**。
> 投放同事原话:"TikTok 量很小,质量差"。V_1.0 不重点投。

---

## 一、TikTok Business 账号体系(宿主自动注入)

| 字段 | 类型 | 用途 |
|---|---|---|
| `tiktok_business_id` | string | TikTok Business 账号 ID |
| `advertiser_id` | string | 广告主 ID |
| `pixel_id` | string | TikTok Pixel ID |
| `tiktok_account_id` | string | TikTok 账号(可选)|

---

## 二、TikTok 在 D2 资源位下的映射

| D2 资源位 | TikTok 广告类型 |
|---|---|
| `tt-feed` | In-Feed Ads(信息流)|
| `tt-spark` | Spark Ads(品牌内容广告) |

留作扩展(V_1.0 不主投):
- TopView / Branded Hashtag / Branded Effect

---

## 三、TikTok 的"CTW 等价"

TikTok 没有原生 CTW。B2B 引流到 WhatsApp 通常通过:

1. **In-Feed Ads + CTA "Send Message"** → 跳转 WhatsApp 链接
2. **Spark Ads(借势达人)+ 落地页/外链** → 跳转 WhatsApp

**关键差异**:TikTok 用户偏年轻 / 偏 C 端,**B2B 现货投放性价比通常较低**。

---

## 四、广告形式锁定建议

适用 B2B 现货 CTW-like 场景:

| 字段 | 锁定值 |
|---|---|
| objective | TRAFFIC / CONVERSIONS |
| optimization_event | LINK_CLICK / CONVERSION |
| placement_inventory | PLACEMENT_TYPE_NORMAL(信息流) |

---

## 五、素材规格

- **视频为主**(TikTok 是视频平台,静态图效果差)
- 推荐 9:16 / 1:1
- 时长 15-60 秒(15s 最佳)
- V_1.0 的 `generate_ad_creative` 工具暂只支持静态图,**TikTok 视频素材需另外提供**

---

## 六、设备字段映射

| D3 抽象值 | TikTok API 字段 |
|---|---|
| mobile-ios | device_type: ["PHONE"] + os: ["IOS"] |
| mobile-android | device_type: ["PHONE"] + os: ["ANDROID"] |
| tablet | device_type: ["PAD"] |
| desktop | (TikTok 不支持桌面投放) |
| other | 不指定 |

---

## 七、TikTok 投放合规

- TikTok Ad Policy:严于 Meta(尤其内容审核)
- 部分国家 TikTok 受限:**IN(印度禁) / RU / BY** 等
- 各国法规同 Meta(详见 references/compliance.md)

---

## 八、状态

⚠️ **V_1.0 内测期**:TikTok 投放规范结构搭好,但深度内容(plan_json 子 schema、后台手册、KPI 基准、视频素材规格)待真实投放后补全。

skill 在用户选 TikTok 时,产出带 `⚠️ TikTok 投放内测期·未深度验证 + 视频素材需外部提供` 标记。

---

## 九、扩展待办

- [ ] 补 plan_json 子 schema(TikTok Marketing API)
- [ ] 补后台操作手册(TikTok Ads Manager 填写路径)
- [ ] 补 TikTok × 各国 KPI 基准
- [ ] 视频素材生成工具集成(generate_ad_creative 升级)
- [ ] Spark Ads 借势达人合规检查清单
