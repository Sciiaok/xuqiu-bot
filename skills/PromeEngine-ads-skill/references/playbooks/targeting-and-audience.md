# 受众分组 + 关键词 + 定向测试手册

> 适用所有 dim5 组合,B2B 现货为主力场景。
> 关键约束:**输出关键词,不输出 Meta ID**(ID 转换由宿主 draft_ad_plan 处理)

---

## 一、B2B 现货核心受众词库

### 1.1 兴趣词(interest keywords)

按客户身份分组:

**经销商类**:
- car dealer / automotive dealership / car dealership owner
- importer / automotive importer / vehicle import business
- car wholesaler / automotive wholesaler
- new car dealer / used car dealer / commercial vehicle dealer

**车队类**:
- fleet management / fleet operator / commercial fleet
- logistics company / trucking company / delivery fleet
- taxi company / ride-sharing operator
- construction fleet / mining fleet(重卡场景)

**贸易商类**:
- trading company / international trade / B2B trading
- automotive trader / car export business
- procurement manager / international buyer

### 1.2 行为词(behavior keywords)

- B2B trade involvement
- International business activity
- Cross-border commerce
- Auto industry professional
- Fleet purchasing decision-maker

### 1.3 排除受众(避免 b2c 流量)

- ❌ 排除"individual car shoppers"(个人购车者)
- ❌ 排除"new car shopping intent"(c 端购车意向)
- ❌ 年龄 < 25 岁(B2B 决策者通常 28+)

---

## 二、按业务模式 × 国家的受众分组矩阵

### 2.1 b2b-spot × 价格敏感新兴市场(NG / KE / EG / PK)

| 广告组类型 | 兴趣词 | 行为词 | 年龄 |
|---|---|---|---|
| 经销商 | car dealer + importer | B2B trade | 28-55 |
| 二级批发 | automotive wholesaler + used car | International trade | 28-55 |
| 车队 | fleet operator + logistics company | Cross-border commerce | 30-55 |

### 2.2 b2b-spot × 中东枢纽(AE / SA)

| 广告组类型 | 兴趣词 | 行为词 | 年龄 |
|---|---|---|---|
| 转口贸易商 | re-export business + international trade | B2B procurement | 30-55 |
| 进口商 | automotive importer + GCC importer | International business | 28-55 |
| 高端车队 | luxury fleet + corporate fleet | Premium auto buyer | 30-55 |

### 2.3 b2b-spot × 拉美经销/车队(MX / CL / PE / CO)

| 广告组类型 | 兴趣词 | 行为词 | 年龄 |
|---|---|---|---|
| 经销商 | car dealer + automotive dealership | B2B trade | 28-55 |
| 车队 | fleet management + delivery fleet | Cross-border commerce | 30-55 |
| 单证敏感买家 | import compliance + customs broker | International procurement | 32-55 |

### 2.4 b2b-spot × 中亚独联体(KZ / UZ)

| 广告组类型 | 兴趣词 | 行为词 | 年龄 |
|---|---|---|---|
| 经销商 | car dealer + automotive importer | Russian-speaking professional | 28-55 |
| 车队 | mining fleet + construction fleet | Heavy industry purchasing | 30-55 |

### 2.5 b2b-spot × 东南亚(PH / VN / TH)

| 广告组类型 | 兴趣词 | 行为词 | 年龄 |
|---|---|---|---|
| 经销商(LHD 国) | car dealer + automotive importer | B2B trade | 28-55 |
| 经销商(RHD 国 PH/TH) | RHD car dealer + Japanese car dealer | Right-hand drive market | 28-55 |
| 车队 | logistics company + taxi company | Fleet purchasing | 30-55 |

---

## 三、Custom Audience(自定义受众)

### 3.1 可用的 Custom Audience

| 类型 | 来源 | 用途 |
|---|---|---|
| 网站访客 | Pixel(若有) | 再营销 |
| 过往 WhatsApp 对话用户 | WhatsApp Business API | 再营销暖名单 |
| CRM 客户名单 | 客户邮箱/电话上传 | 复购激活 |

### 3.2 Lookalike Audience 创建节奏

- 测新期:**1% Lookalike**(最相似,量小)
- 放大期:**2% Lookalike**(扩量)
- 持续放大:**5% Lookalike**(最大化覆盖)

种子来源建议:
- 已成交客户邮箱(最强信号)
- 过往高价值询盘(次优)
- 网站访客(若有)

---

## 四、A/B 测试框架

### 4.1 测试维度

| 维度 | 变量 | 显著性判定 |
|---|---|---|
| **创意** | 卖点 / 场景 / 色调 / 图片类型 | 单组 ≥ 1000 次曝光,CTR 差异 ≥ 20% |
| **Headline** | 简短 vs 详细 / 数字化 vs 故事化 | 单组 ≥ 1000 次曝光,CTR 差异 ≥ 15% |
| **welcome_message** | 首句问题不同 / 语气差异 | 单组 ≥ 100 条对话,首响率差异 ≥ 15% |
| **受众** | 兴趣组合 / 年龄段 | ≥ 7 天数据,Cost per Conv 差异 ≥ 25% |
| **设备** | mobile-android vs mobile-ios | ≥ 7 天,CPA 差异 ≥ 25% |

### 4.2 测试期 ad_set 配置

| ad_set 名 | 变量组 |
|---|---|
| FB_IQ_DEALERS_ANDROID_CR-A | 创意 A + Android |
| FB_IQ_DEALERS_ANDROID_CR-B | 创意 B + Android |
| FB_IQ_DEALERS_IOS_CR-A | 创意 A + iOS |
| FB_IQ_DEALERS_IOS_CR-B | 创意 B + iOS |

### 4.3 决策流程

- 测试期(M1-M2):多变量同跑,小预算
- 显著性达标 → 关停 loser,winner 加预算
- 放大期(M3-M4):winner 复制 + 扩展受众(Lookalike)
- 优化期(M5-M6):精细化 + 再营销

---

## 五、避坑指南(基于您 20 天数据)

### 5.1 受众过宽问题

**实测案例**:
- KZ-Kazakhstan-18-65-Auto:CPM $5.39 + 0 高价值
- UZ-Uzbekistan-18-65-Auto:CPM $2.07 + 0 高价值
- KH-Cambodia-18-65-Auto:CPM $3.61 + 0 高价值

**共同模式**:18-65 全年龄段 + Auto 通用兴趣 = 低质流量

**应对**:
- 收紧年龄到 25-55
- Auto 通用词改为 B2B 专属词(importer/dealer/wholesaler)
- 加排除项(individual buyer / new car shopper)

### 5.2 价敏市场询价无采购能力

**实测**:低质询单占 13%(BAD=8 + PROOF=64)

**应对**:在受众层做更严过滤,**importer/dealer 标签优先,排除个人消费者属性**

### 5.3 单一兴趣词组合 → 流量瓶颈

**应对**:每个 ad_set 用 3-5 个相关兴趣词组合(narrow 模式),不要单一兴趣

---

## 六、Persona 与 ad_set 命名规范

### 6.1 ad_set 命名格式

```
{D1}_{D4 国家}_{受众类型}_{D3 设备}_{CR-编号}
```

例:
- `FB_IQ_DEALERS_MOBILE_ANDROID`
- `IG_MX_FLEET_MOBILE_IOS`
- `FB_AE_REEXPORT_MOBILE_ANDROID`

### 6.2 Persona 命名

| Persona 缩写 | 含义 |
|---|---|
| DEALERS | 经销商 |
| IMPORTERS | 进口商 |
| FLEET | 车队公司 |
| TRADERS | 贸易商 |
| REEXPORT | 转口贸易(中东专属) |
| OEM | OEM 合作伙伴(b2b-general) |

---

## 七、引用关系

| skill 阶段 | 读取本文件的哪些节 |
|---|---|
| 阶段 3 市场分析 §3 受众洞察 | §1 词库 + §2 矩阵 |
| 阶段 4 §4.5 广告层级结构 | §6 命名规范 |
| 阶段 4 §4.7 定向测试规划 | §2 矩阵 + §4 A/B 测试 |
| 阶段 4 KPI 预测 | §5 避坑指南 |

---

## 八、关键约束

1. **不输出 Meta 兴趣/行为 ID**:skill 工具白名单内没有 targetingsearch,无法实时查 ID;输出关键词由宿主转 ID
2. **不写 Persona 故事化画像**(姓名/生活方式):那是消费者营销,B2B 不需要
3. **不绑定竞品品牌名作为兴趣词**:Meta 政策风险
4. **Advantage+ Audience 锁定关闭**(advantage_audience: 0):契约锁定,不可改
