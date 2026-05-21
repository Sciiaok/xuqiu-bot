# 通用行业知识库(兜底)

> 适用 dim5 D5:`industry = other`(未命中 automotive / agri-machinery / solar)
> 用途:当用户业务不属于 V_1.0 内置 3 个行业时,用本文件作为兜底框架。
> skill 在用本文件时,产出带"⚠️ 通用框架·未行业定制" 标记,产出质量较低。

---

## 一、通用框架

V_1.0 通用行业策略:

1. **创意主线**:让 AI 从用户在阶段 1 描述的"核心卖点 + 业务模式"中现场抽取
2. **图片类型**:用通用 5 类(主图 + 场景 + 团队 + 信任元素 + 物流)代替 12 类
3. **市场矩阵**:让 AI 用 `web_search` 现查该行业在目标市场的常见受众和打法
4. **首响映射**:让 AI 现场推导(承诺-兑现一致性原则)
5. **KPI 基准**:用行业通用范围,标"未行业定制"

---

## 二、通用 5 类图片

### #G1 产品主图

- 适用:所有 B2B / B2C 场景
- 视觉:产品 3/4 视角 + 干净背景 + 品牌可见
- Prompt 骨架:
```
{产品名} in product photography style, 3/4 view angle, clean neutral background,
brand identity visible, professional commercial lighting, no Chinese characters
visible anywhere.
```

### #G2 应用场景图

- 适用:展示产品在真实使用环境
- 视觉:产品 + 目标市场场景 + 用户行为
- Prompt 骨架:
```
{产品名} in authentic {目标市场} {使用场景}, daytime natural lighting,
local environment context, no culturally sensitive elements.
```

### #G3 真人团队图

- 适用:建信任(B2B 尤其需要)
- 视觉:真人销售/技术/服务团队 + 品牌物料
- Prompt 骨架:
```
Professional team in branded uniform at office or showroom, friendly approachable,
multi-language service badge, brand backdrop visible, soft warm lighting.
```

### #G4 信任元素图

- 适用:展示认证 / 单证 / 客户案例
- 视觉:认证标章 + 案例图 + 数字徽章
- Prompt 骨架:
```
{产品名} image with overlay of relevant certifications, checkmark badges
"Certified / Verified / Trusted", clean infographic layout, no fake official
seals.
```

### #G5 物流/交付图

- 适用:B2B 出口场景
- 视觉:产品装箱 / 装船 / 仓储
- Prompt 骨架:
```
{产品名} being packaged or loaded for shipping at warehouse or port, daytime
natural lighting, professional logistics environment.
```

---

## 三、通用受众词模板(让 AI 现查)

skill 在阶段 4 调用 `web_search` 查询:

| 查询模板 | 用途 |
|---|---|
| `{industry} B2B importer keywords` | 找 importer 兴趣词 |
| `{industry} {country} dealer interest` | 找当地经销商兴趣 |
| `{industry} fleet/bulk buyer` | 找批量买家词 |

---

## 四、通用 KPI 基准范围(行业不可知)

| 指标 | B2B 通用 | B2C 通用 |
|---|---|---|
| CPM | $2-15 | $5-25 |
| CTR | 0.8-2.5% | 1.0-3.0% |
| CPC | $0.3-2.0 | $0.5-3.0 |
| Cost per Conv | $0.5-5 | $1-8 |
| CPQL | $20-100 | -- |

具体行业数值会比上述范围更精确,跑过数据后建议补到对应 industry 文件。

---

## 五、通用合规

参考 references/compliance.md 通用规则(全行业适用)。

行业专项合规需根据具体行业现查(如食品 / 药品 / 医疗器械等高监管行业)。

---

## 六、什么时候触发本文件?

skill 阶段 1 业务理解后,如果 `D5.industry` 不属于 V_1.0 内置:
- `automotive` ✅ 走 industries/automotive.md
- `agri-machinery` ⚠️ 走 industries/agri-machinery.md(内测期)
- `solar` ⚠️ 走 industries/solar.md(内测期)
- **其他 → 走本文件 generic.md + 强制 web_search 补充**

skill 此时主动告知用户:
> "您的行业不属于 V_1.0 内置行业(汽车/农机/光伏)。我会用通用框架 +
>  联网查询为您生成方案,但建议后续投放后,把行业知识沉淀进 skill,
>  以获得更专业的产出。"

---

## 七、扩展机制

如果某新行业累计跑了 1 个月以上数据,建议:
1. 用 `_template-industry.md` 创建该行业 md 文件
2. 把实战 KPI、图片类型、市场矩阵填入
3. 提交合并到 skill,后续不再走 generic.md
