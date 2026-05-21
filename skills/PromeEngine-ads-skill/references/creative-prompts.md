# 素材生成失败模式 prompt 补丁

> V_1.0 把 V4.0 的 4 类失败模式扩展到 11 类。
> 每次调用 `generate_ad_creative` 时,product_description 必须叠加对应补丁。

---

## 一、CMF 保真硬约束(每次必加)

```
CMF preservation (strict):
- Keep exact body color from reference image
- Keep exact surface finish (matte / glossy / metallic)
- Keep exact brand logo position and proportions
- Keep exact wheel design / grille shape / headlight signature
- Do NOT change model identification features
```

---

## 二、11 类失败模式 prompt 补丁

### #1 车身/车牌出现中文字符

**问题**:车身侧面贴中文广告语 / 车牌上「京沪粤」/ 后窗中文贴纸

**实测案例**:Foton Aumark S 重生 4 次,车牌中文反复出现

**补丁**:
```
License plates blurred or completely blank, no Chinese characters anywhere on
the vehicle body or windows, no Chinese decals or stickers, no Chinese banner
ads visible in the scene.
```

### #2 货币显示人民币 ¥ / CNY / RMB

**问题**:目标市场是 NG/SA 等,但素材里出现 ¥ 符号或 RMB / CNY 字样

**补丁**:
```
No ¥ / RMB / CNY symbols anywhere in the image. If price tags are needed,
use {目标市场货币符号} only:
- NG → ₦ (NGN) / EG → E£ (EGP) / KE → KSh (KES)
- AE → AED / SA → SAR / IQ → IQD
- MX → MXN / PE → S/ (PEN) / BR → R$ (BRL)
- KZ → ₸ (KZT) / UZ → soʻm (UZS)
- PH → ₱ (PHP) / VN → ₫ (VND) / TH → ฿ (THB)
```

注:v2.0 收紧后,**广告内容中尽量不出现具体价格数字**(让客服在 WhatsApp 沟通),但仍要写防御性约束。

### #3 透视 / 比例不协调

**问题**:车辆与场景透视不一致(俯视 + 平视混)、比例失真、角度不符合广告吸引力

**补丁**:
```
Vehicle shot at 3/4 front three-quarter view, consistent perspective with the
environment, no top-down or bird's eye view, vehicle occupies 40-60% of frame,
naturally integrated into scene.
```

### #4 画面留白(角落空白)

**问题**:画面四角(尤其左上角)大块未填充

**补丁**:
```
Full-frame composition, no empty corners, background extends to image edges,
decorative elements or text naturally distributed, no large blank areas in
any corner.
```

### #5 视频开头掉帧 / 卡顿(预留,V_1.0 不用)

V_1.0 仅静态图,但留接口给未来视频素材扩展。

### #6 9:16 截切丢失主体(预留,V_1.0 不用)

V_1.0 仅 1:1 生成,但未来扩展多尺寸时需此补丁。

### #7 轮播图主体断裂(预留,V_1.0 不用)

V_1.0 不用 Carousel。

### #8 Catalog 主图风格不统一(预留,V_1.0 不用)

V_1.0 不用 DPA。

### #9 Lead Form 字段过多(预留)

V_1.0 不用 Lead Form。

### #10 App Store 素材文字超限(预留)

V_1.0 不用 App Install。

### #11 IG Stories 顶部头像遮挡主体

**问题**:IG Stories 上方有用户头像 + 用户名 overlay,主体上 1/8 区域会被遮挡

**补丁**(仅当 D2 含 ig-reels 时使用):
```
For IG Stories/Reels placements: keep main subject below top 15% of frame.
Top area should be visual background, never contain critical product details
or text overlays.
```

---

## 三、文化本地化补丁(按 D4 国家叠加)

### 价格敏感新兴市场(NG / KE / EG / PK)

```
Cultural context: African / South Asian commercial setting,
warm tones, dusty road environment, market vibe.
Avoid: overly luxurious settings (mismatched with B2B price-sensitive audience).
```

### 中东枢纽市场(AE / SA / EG)

```
Cultural context: Middle Eastern professional setting,
modern architecture or port facility, palm trees acceptable.
Avoid: alcohol references, immodest clothing, Friday prayer time imagery (SA),
pork-related symbols, gambling/casino imagery.
```

### 拉美市场(MX / CL / PE / CO / BR)

```
Cultural context: Latin American professional setting,
Spanish/Portuguese signage if visible.
Avoid: politically sensitive symbols, religious imagery (varies by country).
```

### 中亚独联体(KZ / UZ)

```
Cultural context: Central Asian setting,
modern port or warehouse facility.
Russian/Cyrillic signage acceptable if naturally present.
```

### 东南亚(PH / VN / TH / ID)

```
Cultural context: Southeast Asian commercial setting,
tropical environment acceptable.
Right-hand drive (RHD) for PH/TH/ID;
left-hand drive (LHD) for VN/KH/LA.
Avoid: King/royal family imagery (TH strictly),
pork references (MY/ID strictly Muslim),
religious sensitivities.
```

---

## 四、CTA 风格补丁(按 D1 渠道叠加)

```
For Meta CTW: green WhatsApp CTA button overlay (tool auto-handles, do not
specify in prompt). Show "Chat" or "Message" text near CTA area.

For Google UAC: no specific CTA, platform auto-overlays "Install" or "Open".

For TikTok Spark Ads: no overlay CTA, organic-looking content.
```

---

## 五、完整 product_description 拼装顺序

调用 `generate_ad_creative` 时,按以下顺序拼:

```
1. [图片类型骨架 prompt]    (来自 industries/automotive.md 的对应 #N)
2. [文化本地化补丁]          (按 D4 国家)
3. [11 类失败模式补丁]       (按图片类型可能踩的失败模式)
4. [CMF 保真硬约束]          (每次必加)
5. [CTA 风格补丁]            (按 D1 渠道)
```

每段之间用空行分隔。

---

## 六、调用示例

```
generate_ad_creative({
  product_name: "Foton AUMARK",
  product_description: `
[图片类型骨架]
Real photography (not rendered) of 30+ same-model Foton AUMARK light trucks
parked in rows at port-bonded warehouse, daytime natural light, "Foton In Stock"
banner visible.

[文化本地化补丁 - NG 市场]
Cultural context: Nigerian commercial setting, warm tones, dusty road
environment near a port facility.

[失败模式补丁 - #1 #2 #3 #4]
License plates blurred or completely blank, no Chinese characters anywhere.
No ¥ / RMB / CNY symbols, if currency needed use ₦ (NGN).
Vehicle shot at 3/4 front three-quarter view, consistent perspective, no
top-down view.
Full-frame composition, no empty corners.

[CMF 保真]
Keep exact body color from reference image, exact surface finish (matte/glossy),
exact brand logo position, exact wheel design / grille shape.
Do NOT change model identification features.

[CTA 风格 - Meta CTW]
Show "Chat" text near CTA area, green WhatsApp button styling.
  `,
  headline: "Ready Stock Today",
  reference_image_ids: [4],  // 用户上传的堆场图
  target_countries: ["NG"],
  language: "English"
})
```

---

## 七、失败模式排查清单(每张图生成后核查)

| 排查项 | 是否通过 |
|---|---|
| 车身/车牌无中文字 | □ |
| 货币正确(无 ¥) | □ |
| 透视一致 | □ |
| 无空白角落 | □ |
| CMF 保真(色/材/logo) | □ |
| 文化本地化正确 | □ |
| 舵向正确(RHD/LHD) | □ |
| 文字占比 ≤20% | □(工具内部已控)|
| 无绝对化用语 | □ |
| 无危险驾驶画面 | □ |

任一未通过 → 重新生成。

---

## 八、扩展机制

发现新失败模式后,**追加到 §2**,并在对应图片类型的 prompt 骨架里引用。

历史失败案例归档(让 AI 学习):
- 2026-04 Foton Aumark S 车牌中文 → 已加 #1
- 2026-04 NG 素材出现 ¥ → 已加 #2
- 2026-04 透视不协调 → 已加 #3
- 2026-04 左上角空白 → 已加 #4
