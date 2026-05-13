# 阶段四:CTW 素材生成规范(基于 generate_ad_creative 工具)

本文件为阶段四执行参考。**本 skill 通过 `generate_ad_creative` 工具生成素材**,不调用任何外部 API(如 OpenRouter / Meta Graph)。

## 目录

1. [generate_ad_creative 工具用法](#1-generate_ad_creative-工具用法)
2. [welcome_message 设计模板](#2-welcome_message-设计模板)
3. [Meta 平台版位规格(供 Meta 后台投放参考)](#3-meta-平台版位规格供-meta-后台投放参考)
4. [各市场合规规则细则](#4-各市场合规规则细则)
5. [广告素材任务清单模板](#5-广告素材任务清单模板)
6. [单素材输出标准](#6-单素材输出标准)
7. [合规检查清单(每张图必检)](#7-合规检查清单每张图必检)

---

## 1. generate_ad_creative 工具用法

### 1.1 工具签名

```
generate_ad_creative({
  product_name:        string,    // 必填
  product_description: string,    // 必填,50-200 字卖点 + 视觉描述
  headline:            string,    // 必填,会被渲染到图上的标题(≤40 字符)
  reference_image_ids: number[],  // 必填,1-based,引用用户已上传的产品图
  target_countries?:   string[],  // 可选,ISO-2 码
  language?:           string,    // 可选,默认 "English"
})
→ 成功: { url: string, model: string }
→ 失败: { error: string, message: string }
```

### 1.2 工具内部已注入的属性(不要重复约束)

工具内部**已自动**处理以下属性,**严禁**在 `product_description` 里重复写,否则会污染 prompt 导致质量下降:

- ✅ 输出尺寸:1080×1080 PNG
- ✅ 风格:studio-grade 商业摄影
- ✅ 产品保真控制(基于参考图,确保车型外观与参考一致)
- ✅ Headline 文字 overlay(由 `headline` 字段自动渲染到图上)
- ✅ WhatsApp 风格绿色 CTA 按钮(自动叠加)
- ✅ 文字占比 ≤20%(工具内部硬约束,不要在 prompt 里强调"少文字")

### 1.3 调用前置:必须确认参考图已上传

工具**强制要求** `reference_image_ids`。如果用户尚未上传产品图,工具会返回:

```
{ error: 'no_reference_images', message: '...' }
```

**正确做法**:阶段四开始前先询问用户:

> "阶段四需要您先上传车型产品图(透明背景或干净背景的官方图最佳)。
> 请上传后告诉我,我会基于您的产品图生成 Meta CTW 广告图。
> 通常每个车型 1-3 张高质量参考图就够了,可以包含:正面角度、侧面角度、内饰局部。"

**禁止**做法:盲调工具看返回结果。这会浪费工具调用配额。

### 1.4 product_description 写作要点

**应该写**(50-200 字):

- 产品的 3 个核心卖点(本地化语境)
- 期望的视觉氛围(场景、光线、情感基调)
- 期望的画面构图(车辆位置、与场景元素的关系)

**不应该写**(工具已处理):

- ❌ "高分辨率"、"4K"、"商业摄影质感"
- ❌ "1080x1080"、"square format"、"1:1 ratio"
- ❌ "with green CTA button"、"with WhatsApp icon"
- ❌ "less than 20% text"、"minimal text overlay"

### 1.5 product_description 写作示例

**好的示例(德语市场,家庭场景)**:

```
BYD Seal — premium electric family sedan with up to 600 km WLTP range,
spacious interior for 5 adults, advanced driver assistance.
Visual setting: warm autumn afternoon at a Bavarian countryside road,
family-friendly atmosphere, golden-hour lighting suggesting end-of-day calm.
Vehicle positioned at center, surrounded by rolling green hills and distant Alps.
```

**差的示例(违反 1.4 规则)**:

```
A high-resolution 4K square (1080x1080) photo of the BYD Seal in commercial
photography style, with a green WhatsApp button and minimal text overlay.
The car looks premium...
```

### 1.6 headline 写作要点

- ≤40 字符
- 本地化(目标市场语言)
- 必须有数字 / 具象卖点(避免"最佳"、"领先"等空洞词)
- 工具会自动渲染到图上,所以要写**视觉友好的短句**,不写整段话

**示例**:

| 市场 | Headline 示例 |
|---|---|
| 德国 | `Bis zu 600 km Reichweite (WLTP)` |
| 法国 | `Jusqu'à 600 km d'autonomie WLTP` |
| 英国 | `Up to 600 km WLTP Range` |
| 西班牙 | `Hasta 600 km de autonomía WLTP` |

---

## 2. welcome_message 设计模板

### 2.1 必填规则(契约 6.4)

每条 ad 必须有 welcome_message,作为用户点击广告进入 WhatsApp 后看到的第一句话。

强制要求:

- **纯文本**(不带 emoji 装饰过度,1-2 个表情可以)
- **第一人称**(以品牌或销售身份说话,如 "Ich"/"I"/"Yo")
- **必须包含产品名**(车型)
- **必须含一个开放式问题**(引导用户回复)
- **本地化**(目标市场语言)
- **经过母语者审核**(产出物附 ⚠️ 提示)

### 2.2 结构骨架

```
[问候] + [我是谁 / 看到您对 X 感兴趣] + [开放式问题]
```

### 2.3 各市场示例

**德语(BYD Seal)**:

> Hallo! Ich freue mich, dass Sie sich für den BYD Seal interessieren.
> Welche Funktion ist Ihnen am wichtigsten – Reichweite, Innenraum oder Preis?

**法语(BYD Seal)**:

> Bonjour ! Je suis ravi que vous vous intéressiez à la BYD Seal.
> Qu'est-ce qui compte le plus pour vous : l'autonomie, l'intérieur ou le prix ?

**英语(英国 / 中东英语市场)**:

> Hi there! I'm glad you're interested in the BYD Seal.
> What matters most to you — range, interior space or price?

**西班牙语**:

> ¡Hola! Me alegra mucho que estés interesado en el BYD Seal.
> ¿Qué es más importante para ti: autonomía, interior o precio?

**阿拉伯语(中东)**:

> مرحباً! يسعدنا اهتمامك بسيارة BYD Seal.
> ما الأهم بالنسبة لك: المدى، المقصورة الداخلية، أم السعر؟

### 2.4 反面示例(不要这样写)

❌ "Hello, click here for more info."(无产品名、无开放式问题)

❌ "We are the best electric car brand in Europe."(自夸式,违反 Meta 政策)

❌ "Buy now and get 30% off."(强销售感,WhatsApp 政策不喜欢)

❌ Headline 直接复制为 welcome_message(冗余)

---

## 3. Meta 平台版位规格(供 Meta 后台投放参考)

> 注意:本 skill 阶段四**仅生成 1080×1080 静态图**(`generate_ad_creative` 工具固定)。Reels / Stories 版位会用同一张图,Meta 后台自动适配比例(可能截切上下区域)。

| 版位 | 推荐尺寸 | 比例 | 工具是否原生支持 |
|---|---|---|---|
| Facebook Feed | 1080×1080 | 1:1 | ✅ 原生 |
| Instagram Feed | 1080×1080 | 1:1 | ✅ 原生 |
| Stories | 1080×1920 | 9:16 | ⚠️ 用 1:1 图,Meta 自动 letterbox |
| Reels | 1080×1920 | 9:16 | ⚠️ 同上 |
| Marketplace | 1080×1080 | 1:1 | ✅ 原生 |
| Audience Network | 1080×1080 / 1080×1920 | 1:1 / 9:16 | ✅(1:1 部分) |

> 如果未来需要原生 4:5 / 9:16,需向宿主提案扩展 `generate_ad_creative` 工具(见契约第九部分扩展位表)。

### 3.1 关键规范

- 最低分辨率:1080×1080(工具默认)
- 最大文件大小:30MB(工具自动控制)
- 文件格式:PNG(工具固定)

---

## 4. 各市场合规规则细则

### 4.1 Meta 平台通用合规(全市场)

**禁止**:

- 绝对化用语:"最佳"、"第一"、"唯一"、"完美"、"100% 安全"
- 未经证实的性能宣称(尤其续航、加速、安全相关)
- 误导性对比(必须有数据支撑且公平对比)
- 鼓励危险驾驶行为的画面(超速、特技、违章)
- 未授权使用的真人形象、品牌标识

**必须**:

- 性能参数标注测试条件(WLTP / EPA / NEDC / CLTC 等)
- 价格相关标注"起售价"、"建议零售价"等限定语

### 4.2 德国(DE)

| 项 | 要求 |
|---|---|
| 续航宣传 | 必须标 WLTP 工况 |
| 价格宣传 | 用 "ab"(起)或 "UVP"(建议零售价) |
| 新能源补贴 | 标注"前提条件"(如"在符合资格条件下") |
| WhatsApp 隐私 | 对话流程符合 GDPR,客服首响附隐私条款链接 |

### 4.3 法国(FR)

| 项 | 要求 |
|---|---|
| 强制语 | **2022 年起所有汽车广告必须含三条强制语之一**(鼓励多式联运),示例:"Pour les courts trajets, privilégiez la marche ou le vélo" |
| 续航 | 必须标 WLTP |
| 排放 | CO₂ 排放数值必须可见 |
| ARPP 自律 | 遵守 ARPP《Recommandation Automobile》 |

### 4.4 英国(UK)

| 项 | 要求 |
|---|---|
| ASA CAP Code | 强制遵守 |
| 续航 | 必须标 WLTP |
| 加速 | 0-100 km/h 数据必须标"测试条件",不得暗示在公共道路超速 |
| 价格 | 含 "OTR price"(On The Road)说明 |

### 4.5 欧盟通用(EU)

| 项 | 要求 |
|---|---|
| DSA(数字服务法) | 广告必须标注"为什么投给我" |
| GDPR | WhatsApp 对话内不主动收集敏感个人信息 |
| 油耗披露 | EU 2017/1369 法规要求 |

### 4.6 美国(US)

| 项 | 要求 |
|---|---|
| FTC Endorsement Guides | KOL 合作必须明示 #ad / #sponsored |
| 加州 CCPA / CPRA | 比 GDPR 更严 |
| 燃油经济性 | EPA 数据,标 "estimated MPG / MPGe" |
| 价格 | "Starting at" 或 "MSRP" 标注 |

### 4.7 中东(UAE / 沙特)

| 项 | 要求 |
|---|---|
| UAE | 禁止酒精、宗教、女性身体暴露元素 |
| 沙特 | 禁止周五黄金时段非伊斯兰文化广告 |
| 价格 | 含 VAT 标注 |
| 翻译 | 阿拉伯语翻译必须由当地母语者审核(welcome_message 尤其重要) |

### 4.8 东南亚(IDN / THA / VNM)

| 项 | 要求 |
|---|---|
| 印尼 | Halal 认证(若适用),Bahasa Indonesia 翻译 |
| 泰国 | 泰文翻译,皇室相关元素禁用 |
| 越南 | 越南语翻译,禁用过度奢侈宣传 |

---

## 5. 广告素材任务清单模板

阶段四步骤 1 必须输出以下结构的清单表(对话内 markdown 输出):

```markdown
# {品牌} {车型} CTW 广告素材任务清单

**生成日期**:YYYY-MM-DD
**素材总数**:N 张
**目标市场/语言**:{markets}
**素材尺寸**:全部 1080×1080(工具固定)

## 任务清单总表

| 素材编号 | 创意方向 | A/B 变体 | 主打卖点 | 目标市场/语言 | 对应广告组 | 状态 |
|---|---|---|---|---|---|---|
| CR-001 | 科技感 | 变体 A | 长续航 | 德国/德语 | DE_TIER1_FAMILY | 待生成 |
| CR-002 | 科技感 | 变体 B | 智能驾驶 | 德国/德语 | DE_TIER1_FAMILY | 待生成 |
| CR-003 | 性价比 | 变体 A | 起售价 | 德国/德语 | DE_TIER1_FAMILY | 待生成 |
| CR-004 | 家庭场景 | 变体 A | 大空间 | 德国/德语 | DE_TIER1_FAMILY | 待生成 |
| ... | ... | ... | ... | ... | ... | ... |

## 素材生成原则

- 每个 ad_set 至少 2 个 A/B 变体
- 每个目标市场提供本地化 headline 和 welcome_message
- 命名规范:CR-{编号}(与 plan_json 中 creative_id 对应)
```

---

## 6. 单素材输出标准

每个素材**调用 `generate_ad_creative` 后**,在对话内输出以下完整结构:

```markdown
## 素材 CR-001

### 工具调用结果
- **图片 URL**:{tool 返回的 url}
- **生成模型**:{tool 返回的 model}

### 基础信息
- **创意方向**:科技感 - 变体 A
- **主打卖点**:长续航
- **目标市场/语言**:德国 / 德语
- **对应广告组**:DE_TIER1_FAMILY

### 工具入参(供回溯)
```
generate_ad_creative({
  product_name: "BYD Seal",
  product_description: "BYD Seal — premium electric family sedan with up to 600 km WLTP range...",
  headline: "Bis zu 600 km Reichweite (WLTP)",
  reference_image_ids: [1, 2],
  target_countries: ["DE"],
  language: "German"
})
```

### 配套 Meta 文案(德语)

| 字段 | 字符限制 | 内容 |
|---|---|---|
| Headline(已渲染到图上) | ≤40 | Bis zu 600 km Reichweite (WLTP) |
| Primary Text | ≤125 | Erleben Sie die Zukunft des Fahrens. Modernste E-Mobilität, jetzt mit großzügiger Reichweite und smarter Technologie. |
| Description | ≤30 | Gespräch starten |

### welcome_message(德语,本地化)

> Hallo! Ich freue mich, dass Sie sich für den BYD Seal interessieren.
> Welche Funktion ist Ihnen am wichtigsten – Reichweite, Innenraum oder Preis?

> ⚠️ AI 生成,投放前必须由德语母语者审核(语气 / 文化 / 法规标注)。

### CTW 锁定字段(plan_json 引用)
- `creative.link_data.call_to_action.type`:`WHATSAPP_MESSAGE`(契约锁定)
- `creative.link_data.link`:`https://api.whatsapp.com/send`(契约锁定)

### 合规检查
- [x] 无绝对化宣传用语
- [x] 续航参数标注 "WLTP" 测试工况
- [x] 无危险驾驶画面(由工具控制)
- [x] 无德国市场文化禁忌元素
- [x] 文字占比 ≤20%(工具内部已控制)
- [x] welcome_message 已本地化

### 投放使用说明
- 用于 Campaign:BYD_Seal_CTW_20260601(单一 campaign)
- 用于 Ad Set:DE_TIER1_FAMILY
- 投放周期:2026-06-01 ~ 2026-11-30
- A/B 测试组:变体 A(与 CR-002 变体 B 对照)
```

---

## 7. 合规检查清单(每张图必检)

### 工具自动控制(工具已处理,默认通过)

- [x] 尺寸 1080×1080
- [x] 分辨率 ≥ 1080×1080
- [x] 文件格式 PNG
- [x] 文件大小 ≤ 30MB
- [x] 文字占比 ≤20%
- [x] WhatsApp 风格绿色 CTA 按钮
- [x] Headline 文字 overlay 渲染

### 内容合规(skill 必须人工核查)

- [ ] 无绝对化宣传用语
- [ ] 性能参数标注测试条件(WLTP / EPA / 等)
- [ ] 无危险驾驶画面
- [ ] 无目标市场文化禁忌元素(参见第 4 节)
- [ ] 创意方向与策划案 04/05 章一致
- [ ] welcome_message 本地化且经母语者审核
- [ ] welcome_message 含产品名 + 开放式问题(契约 6.4 必填)

### CTW 锁定校验(关键)

- [ ] CTA 类型规划为 `WHATSAPP_MESSAGE`(不使用 LEARN_MORE / GET_QUOTE 等)
- [ ] link 规划为 `https://api.whatsapp.com/send`(不指向落地页)
- [ ] 文案中**不**承诺"填表领取"、"在网站填资料"等(暗示落地页)
- [ ] 文案中**不**承诺"立即购买"(SHOP_NOW 已禁用)
