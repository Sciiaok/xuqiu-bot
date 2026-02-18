# Sales Prompt Optimization Design

## Overview

优化 Claude 提示词，使 AI 销售助手具备更好的谈判和销售技巧。核心改动：引入客户意图分类、商业价值评估，简化评分系统为 inquiry_quality 四级体系。

## Goals

1. AI 能识别客户意图（C端/B端询盘/B端合作/其他）
2. AI 能评估商业价值（LOW/AVERAGE/HIGH）
3. 简化评分系统，废弃 score_delta，使用 inquiry_quality
4. 增强对话技巧：适时引导、模板确认、合作方式说明

## Non-Goals

- 不重构 prompt 为模块化架构（后续迭代）
- 不改变数据库表结构（仅新增字段）
- 不修改 dashboard 展示（后续迭代）

---

## Design

### 1. 新的输出格式

废弃 `score_delta`、`reasons`、`risk_flags`、`stage`，新增意图分类和价值评估：

```javascript
{
  // 新增：意图分类
  conversation_intent: "personal_consumer | business_inquiry | business_cooperation | other",
  conversation_intent_summary: "", // 当 intent 为 other 时的简要说明

  // 新增：询盘质量（替代 stage + score_delta）
  inquiry_quality: "BAD | GOOD | QUALIFY | PROOF",

  // 新增：商业价值
  business_value: "LOW | AVERAGE | HIGH",

  // 保留：lead 提取
  leads: [...],

  // 简化：路由（移除 NURTURE）
  route: "CONTINUE | HUMAN_NOW | FAQ_END",

  // 保留
  next_message: "...",
  handoff_summary: "..."
}
```

### 2. inquiry_quality 四级体系

| 级别 | 含义 | 必需字段 |
|------|------|----------|
| BAD | 无效/C端/垃圾 | - |
| GOOD | 基本意图明确 | brand, car_model, color |
| QUALIFY | 询盘细节完整 | color_quantity, destination_port |
| PROOF | 验证通过可交接 | company_name, incoterm |

### 3. 路由决策逻辑

| inquiry_quality | 路由 |
|-----------------|------|
| PROOF | HUMAN_NOW |
| QUALIFY | CONTINUE |
| GOOD | CONTINUE |
| BAD | FAQ_END |

特殊情况：
- `conversation_intent: personal_consumer` → FAQ_END + 发送公司网站链接
- 诈骗/推销/求职 → FAQ_END + 空 next_message
- 30 轮对话限制 → 强制 FAQ_END

### 4. 客户意图分类

| 意图 | 描述 | 处理方式 |
|------|------|----------|
| personal_consumer | C端，单台车询价 | 发送公司网站，FAQ_END |
| business_inquiry | B端主动询盘（车型+数量+询价） | 快速推进，收集询盘细节 |
| business_cooperation | B端合作探讨（询问背景、能力） | 先回答问题，适时引导业务话题 |
| other | 其他（需 summary 说明） | 根据情况处理 |

意图影响：
- 持续影响对话风格
- business_inquiry 比 business_cooperation 更快推进到 PROOF

### 5. 商业价值评估

基于采购数量：
- 1-10台：LOW
- 11-50台：AVERAGE
- 50+台：HIGH

基于 inquiry_quality 调整：
- inquiry_quality: PROOF 且数量 20+ → 可升级价值
- inquiry_quality: BAD → 强制 LOW

影响：
- 回复风格（HIGH 更详细，LOW 简短）
- 路由优先级

### 6. 对话技巧

1. 每条消息最多 1-2 个问题，180字符内
2. 友好称呼：Friend、Dear
3. 绝不承诺最终价格
4. 闲聊中适时引导：回答问题后顺带一个业务问题
5. 客户要报价时，发送询盘确认模板：
   ```
   Friend, let me confirm your inquiry:
   Company:
   - BRAND-MODEL-OPTION:
   - COLOR:
   - DESTINATION/LOADING PORT:
   - TERM (FOB|CIF):
   ```

### 7. 合作方式说明

当客户询问合作方式时，先了解客户偏好的贸易条款，再根据情况说明：
- FOB：装船前全款，客户自己货代
- 小批量 CIF：提单副本后全款
- 不接受寄售
- 公司网站：revopanda.com

---

## Code Changes

### 1. src/claude.service.js

- 重写 SYSTEM_PROMPT（意图分类、对话技巧、合作方式、inquiry_quality 定义）
- 更新 JSON_SCHEMA：
  - 新增：conversation_intent, conversation_intent_summary, inquiry_quality, business_value
  - 移除：stage, score_delta, reasons, risk_flags
  - 简化：route enum 移除 NURTURE

### 2. src/state-machine.js → src/inquiry-quality.js

重命名并简化：

```javascript
const GLOBAL_MAX_TURNS = 30;

const INQUIRY_QUALITY_STANDARD_CONFIG = {
  GOOD: { required_fields: ['brand', 'car_model', 'color'] },
  QUALIFY: { required_fields: ['color_quantity', 'destination_port'] },
  PROOF: { required_fields: ['company_name', 'international_commercial_term'] },
};

export function getMissingFields(inquiryQuality, leadData) { ... }

export function hasReachedGlobalMaxTurns(messageCount) {
  return Math.floor(messageCount / 2) >= GLOBAL_MAX_TURNS;
}
```

### 3. src/routing.service.js

- 简化路由逻辑：基于 inquiry_quality 决策
- 移除 NURTURE 相关代码
- 移除 score 阈值判断

### 4. src/lead-scorer.js

- 废弃或大幅简化（评分逻辑已移到 Claude prompt）

### 5. lib/queue-processor.js

- 移除 shouldAdvanceStage() 调用
- 移除 updateSessionStage() 调用
- inquiry_quality 直接从 claudeResponse 存储
- 简化 stageInfo → 只传 missing_fields

---

## Database Compatibility

leads 表：
- 新增字段：conversation_intent, inquiry_quality, business_value
- 废弃字段：score（保留但不再更新，避免破坏历史数据）
- stage 字段：保留，由 inquiry_quality 映射（GOOD→GREET, QUALIFY→QUALIFY, PROOF→PROOF）

---

## Migration Strategy

1. 渐进式改造，不中断服务
2. 新字段先设为可选，旧字段暂时保留
3. 验证新 prompt 效果后，再清理废弃代码

---

## Files Changed

| 文件 | 改动类型 |
|------|----------|
| src/claude.service.js | 重写 |
| src/state-machine.js → src/inquiry-quality.js | 重命名+简化 |
| src/routing.service.js | 简化 |
| src/lead-scorer.js | 废弃/简化 |
| lib/queue-processor.js | 适配 |

## Files Unchanged

- app/api/webhook
- app/dashboard
- lib/repositories
- src/whatsapp.service.js
