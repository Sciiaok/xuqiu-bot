# 汽车 Meta CTW 广告合规黑名单清单(v2.0)

> 阶段四每个素材生成后必须按本文件做合规对照(SKILL.md §7.6)。
> v2.0 关键变化:FOB 价格 + 未求证对比全部严禁(收紧);各市场附加禁词改为动态查询。

---

## 1. 通用黑名单(全市场,headline + primary_text + welcome_message 都禁)

### 1.1 绝对化用语

| 中文 | 英文 | 替换方案 |
|---|---|---|
| 最便宜、最低价 | cheapest, lowest price | 具有竞争力的价格 / competitive pricing |
| 最好、最佳、第一 | best, top, #1, the leading | 优秀的 / excellent, top-tier |
| 唯一 | the only, exclusive | 独特的 / distinctive |
| 完美 | perfect | 卓越的 / outstanding |
| 100% 安全、绝对安全 | 100% safe, absolutely safe | 高安全标准 / high safety standards |
| 国家级、世界级 | national-grade, world-class | 行业领先 / industry-leading |
| 革命性、颠覆性 | revolutionary, disruptive | 创新的 / innovative |

### 1.2 未求证的对比数字(v2.0 收紧:全禁)

**严禁出现任何「比 X 高/低/快/远 X%」的表述**,即使带 "up to" 软化措辞也禁止。

| ❌ 禁止 | ✅ 替换 |
|---|---|
| "比 Hilux 便宜 12%" | 删除该对比 |
| "续航比比亚迪秦 PLUS 多 100km" | "Long range, suitable for daily commute" |
| "省油 15% vs 同级车" | "Fuel-efficient" |
| "16% Lower Price" | "Competitive pricing in segment" |
| "Up to 12% more fuel efficient" | "Fuel-efficient(WLTP)" |

**v2.0 收紧的原因**:用户明确反馈"没有求证对比的就不要给用户输出,严格禁止"。

### 1.3 具体补贴金额(高风险,实测中已被用户预警)

| 禁 | 替换 |
|---|---|
| 政府补贴 $5,000 | 享受当地新能源补贴(具体金额以政府公告为准) |
| EV 退税 30% | 符合资格者可享受 EV 优惠政策 |
| Free registration | 注册费减免(条件以当地为准) |

**理由**:补贴金额变化频繁,文案写死数字会过期且被监管挑刺。

### 1.4 价格绝对值 + FOB 范围(v2.0 收紧:全禁)

**v2.0 关键收紧**:**所有价格信息(MSRP / FOB / starting from)全部禁止出现在广告内容中**,价格信息交给客服在 WhatsApp 对话中沟通。

| ❌ 禁止 | ✅ 处理 |
|---|---|
| "$15,000" / "Starting from $15,000" | 删除价格,改为 "Contact us for pricing" |
| "FOB Tianjin: $X,XXX–$X,XXX(MOQ ≥10 units)" | 删除,FOB 交给客服聊 |

**v2.0 收紧的原因**:用户明确反馈"FOB 价格范围不能在广告投放这些内容上写,包括欢迎词以及广告文案,这个部分让 AI 介入(客服)就好了"。

### 1.5 性能绝对值

| 禁 | 替换 |
|---|---|
| 续航 600km | Long range — up to 600km (WLTP) |
| 0-100 加速 3.5 秒 | High performance — 3.5s 0-100km/h(track conditions) |
| 5.5T 载重 | Heavy duty — payload up to 5.5T |

### 1.6 风险行为画面

- ❌ 超速画面、特技漂移、违章驾驶
- ❌ 不系安全带、儿童在副驾
- ❌ 未授权使用真人形象、明星脸、竞品 Logo

---

## 2. 各市场附加禁词与强制要求(v2.0:动态查询)

**v2.0 关键变化**:本节**不再固化具体禁词**,改为通过 §4.C 的「平台 + 国家规则查询」**动态获取最新规则**。

每次执行时,根据阶段 1.0 锁定的目标国家,用以下检索关键词模板拉取最新规范:

| 国家/地区 | 检索关键词模板 |
|---|---|
| 德国 (DE) | `Germany automotive advertising law Impressum CO2 emission disclosure {当前年月}` |
| 法国 (FR) | `France automotive ad ARPP mandatory disclaimers CO2 {当前年月}` |
| 英国 (UK) | `UK ASA CAP Code automotive advertising standards {当前年月}` |
| 中东 (SA/AE) | `Saudi Arabia UAE advertising cultural taboo automotive {当前年月}` |
| 菲律宾 (PH) | `Philippines LTO automotive advertising regulations {当前年月}` |
| 哈萨克斯坦 (KZ) | `Kazakhstan automotive advertising language requirements {当前年月}` |
| 越南 (VN) | `Vietnam automotive advertising VND currency disclaimer {当前年月}` |
| 拉美 (PE/CO/CL/MX) | `{country} Latin America Spanish automotive advertising regulations {当前年月}` |

**通用规则模式**(查询时关注以下方向,这些是常见的国家特殊要求,不必每次套用):
- 强制语 / 强制 disclaimer(法国汽车广告强制语、德国 Impressum)
- 排放标注要求(欧盟 CO2 / WLTP)
- 语言要求(母语审核、双语对照)
- 文化禁忌(中东宗教元素、邻国冲突)
- 价格 / 监管编号(英国 OTR、菲律宾 LTO)

查询结果存入 §4.C 的 `platform_country_rules` 字段,后续阶段引用。

---

## 3. 合规对照表模板(阶段四每素材必填)

```markdown
### 素材 CR-XXX 合规对照

| 字段 | 内容 | 通用黑名单 | 平台/国家规则 | 处理 |
|---|---|---|---|---|
| headline | "..." | 无 / [触发:绝对化用语 X] | 无 / [触发:法国强制语缺失] | ✅ 通过 / ❌ 重写为:... |
| primary_text | "..." | ... | ... | ... |
| welcome_message | "..." | ... | 字符 X / 平台上限 Y | ✅ 通过 / ❌ 重写为:... |

**综合判定**:✅ 全部通过 / ❌ 需修订 N 处
```

任何一项 ❌ 必须重写后再交付。

---

## 4. 货币本地化对照表(阶段四素材生成时用)

| 市场 | ISO-2 | 货币代码 | 符号 | 示例 |
|---|---|---|---|---|
| 菲律宾 | PH | PHP | ₱ | ₱850,000 |
| 哈萨克斯坦 | KZ | KZT | ₸ | ₸15,000,000 |
| 阿联酋 | AE | AED | د.إ / AED | AED 75,000 |
| 沙特 | SA | SAR | ر.س / SAR | SAR 80,000 |
| 越南 | VN | VND | ₫ | ₫850,000,000 |
| 秘鲁 | PE | PEN | S/ | S/55,000 |
| 哥伦比亚 | CO | COP | $ (COP) | COP 60,000,000 |
| 智利 | CL | CLP | $ (CLP) | CLP 14,000,000 |
| 墨西哥 | MX | MXN | $ (MXN) | $280,000 MXN |
| 德国 | DE | EUR | € | €35,000 |
| 法国 | FR | EUR | € | €35,000 |
| 英国 | UK | GBP | £ | £28,000 |

**严禁**:在出口市场的素材中出现 ¥ / 人民币 / RMB / CNY(实测已发生)。素材生成 prompt 必须显式指定目标市场货币符号。

> 注意:v2.0 已收紧,**广告内容中尽量不出现具体价格数字**(让客服在 WhatsApp 对话中沟通)。此表仅作为「万一需要出现价格时的本地化参考」。

---

## 5. v2.0 收紧总览

| 类别 | v1.x | v2.0 |
|---|---|---|
| 未求证对比 | 带 "up to" 允许 | **全禁** |
| 价格绝对值(B2C) | 软化允许("Starting from") | **全禁** |
| FOB 价格范围(B2B) | 允许("FOB: $X,XXX–$Y,XXX") | **全禁** |
| 各市场附加禁词 | 固化清单 | **动态查询**(每次按目标国家拉取最新规则) |
