# 一个 Conversation 支持多个 Lead 的设计方案

**Date**: 2026-02-17
**Status**: Draft
**Author**: Claude + User Collaboration

---

## 1. 需求背景

### 1.1 当前问题

当前系统设计是 1 conversation : 0-1 lead，但业务场景中用户可能在一个对话中提出多个商机：

```
用户: "我想询问 BYD Seal 50台到迪拜的价格"
Bot: "好的，BYD Seal 50台到迪拜..."
用户: "另外，我还想问 BYD Atto 3 到沙特的报价，大概20台"
```

**当前行为**: 第二条消息会**覆盖**第一条的 `car_model` 和 `destination_country`

**期望行为**: 创建**两个独立的 lead**，各自追踪

### 1.2 数据模型变更

```
当前:
contacts (1) ──< conversations (1) ──< messages
                      │
                      └── lead (0-1)

目标:
contacts (1) ──< conversations (1) ──< messages ──> lead
                      │
                      └──< leads (0-N)
```

---

## 2. 数据库 Schema 变更

### 2.1 leads 表新增字段

```sql
-- 多 lead 支持字段
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_key TEXT;

-- 新增业务字段
ALTER TABLE leads ADD COLUMN IF NOT EXISTS color_quantity JSONB DEFAULT '[]';

-- lead_key: 用于区分同一对话中的不同商机，格式如 "model:byd seal|dest:uae"
-- color_quantity: 颜色和数量数组
-- 注意：使用现有 route 字段判断 lead 是否活跃（route='CONTINUE' 表示活跃）
```

### 2.2 messages 表新增字段

```sql
-- 消息关联到具体 lead
ALTER TABLE messages ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
```

### 2.3 索引

```sql
-- 复合唯一索引，防止同一对话中重复的活跃 lead_key
-- 使用 route='CONTINUE' 判断 lead 是否活跃
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_lead_key
ON leads (conversation_id, lead_key)
WHERE route = 'CONTINUE' AND lead_key IS NOT NULL;
```

### 2.4 color_quantity 字段格式

```json
[
  { "color": "white", "qty": 6 },
  { "color": "gray|black", "qty": 7 },
  { "color": "red", "qty": 3 }
]
```

- `color`: 颜色规格，格式为 `"外观色"` 或 `"外观色|内饰色"`
- `qty`: 该颜色的数量

---

## 3. Lead Key 设计

### 3.1 生成规则

**Lead Key** 是用于区分不同商机的唯一标识符，基于核心需求字段生成：

```javascript
function generateLeadKey(extractedFields) {
  const parts = [];

  // 核心区分字段（按优先级排序）
  if (extractedFields.car_model) {
    parts.push(`model:${extractedFields.car_model.toLowerCase().trim()}`);
  }
  if (extractedFields.destination_country) {
    parts.push(`dest:${extractedFields.destination_country.toLowerCase().trim()}`);
  }

  // 如果没有核心字段，返回 null（使用默认 lead）
  if (parts.length === 0) return null;

  return parts.join('|');
}
```

### 3.2 示例

| 用户需求 | Lead Key |
|----------|----------|
| BYD Seal 到 UAE | `model:byd seal\|dest:uae` |
| BYD Atto 3 到 Saudi | `model:byd atto 3\|dest:saudi arabia` |
| Toyota Corolla 到 UAE | `model:toyota corolla\|dest:uae` |

---

## 4. Claude Prompt 变更

### 4.1 支持多 Lead 提取（聚合消息场景）

由于消息队列聚合机制，单次 Claude 调用可能处理多条用户消息，其中可能包含多个不同的商机询问。

**场景示例**：
```
聚合消息内容：
"I want BYD Seal to Dubai
Also Atto 3 to Saudi
And Han to Qatar"
```

**解决方案**：将 `extracted_fields` 改为数组 `leads`，每个元素代表一个识别出的商机。

通过 `lead_key`（car_model + destination）自动判断是新建还是更新，无需 `is_new_inquiry` 字段。

在 `src/claude.service.js` 的 JSON_SCHEMA 中：

```javascript
leads: {
  type: 'array',
  description: 'Array of leads extracted from user message(s). Usually 1, but can be multiple if user asks about different products/destinations.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      car_model: { type: 'string', description: 'REQUIRED for lead matching' },
      destination_country: { type: 'string', description: 'REQUIRED for lead matching' },
      destination_port: { type: 'string' },
      qty_bucket: { type: 'string', enum: ['1-5', '6-20', '20+'] },
      loading_port: { type: 'string' },
      international_commercial_term: { type: 'string', enum: ['FOB', 'CIF', 'EXW', 'DDP'] },
      company_name: { type: 'string' },
      buyer_type: { type: 'string', enum: ['dealer', 'store_owner', 'trading_org'] },
      timeline: { type: 'string' },
      budget_indication: { type: 'string' },
      brand: { type: 'string' },
      color_quantity: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            color: { type: 'string' },
            qty: { type: 'number' }
          }
        }
      }
    }
  }
}
```

### 4.2 JSON_SCHEMA 完整结构

原有的 `extracted_fields` + `lead_intent` 合并为 `leads` 数组，移除 `is_new_inquiry`（通过 lead_key 自动判断）：

```javascript
const JSON_SCHEMA = {
  type: 'object',
  required: ['stage', 'leads', 'score_delta', 'reasons', 'risk_flags', 'route', 'next_message', 'handoff_summary'],
  properties: {
    stage: { type: 'string', enum: ['GREET', 'QUALIFY', 'PROOF'] },

    // 新结构：leads 数组（替代 extracted_fields + lead_intent）
    leads: {
      type: 'array',
      description: 'Array of leads extracted. Usually 1, can be multiple for multi-inquiry messages.',
      items: {
        type: 'object',
        properties: {
          car_model: { type: 'string', description: 'REQUIRED for lead matching' },
          destination_country: { type: 'string', description: 'REQUIRED for lead matching' },
          destination_port: { type: 'string' },
          qty_bucket: { type: 'string', enum: ['1-5', '6-20', '20+'] },
          loading_port: { type: 'string' },
          international_commercial_term: { type: 'string', enum: ['FOB', 'CIF', 'EXW', 'DDP'] },
          company_name: { type: 'string' },
          buyer_type: { type: 'string', enum: ['dealer', 'store_owner', 'trading_org'] },
          timeline: { type: 'string' },
          budget_indication: { type: 'string' },
          brand: { type: 'string' },
          color_quantity: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                color: { type: 'string', description: '"exterior" or "exterior|interior"' },
                qty: { type: 'number' }
              }
            }
          }
        }
      }
    },

    score_delta: { type: 'number', description: 'Overall score change (-30 to +30)' },
    reasons: { type: 'array', items: { type: 'string' } },
    risk_flags: { type: 'array', items: { type: 'string' } },
    route: { type: 'string', enum: ['CONTINUE', 'HUMAN_NOW', 'NURTURE', 'FAQ_END'] },
    next_message: { type: 'string', description: 'Response to user (max 120 chars)' },
    handoff_summary: { type: 'string' },

    // 保留 extracted_fields 用于向后兼容（deprecated）
    extracted_fields: { type: 'object', description: 'DEPRECATED: Use leads array instead' },
  }
};
```

**Lead 匹配逻辑**：
- `lead_key = model:{car_model}|dest:{destination_country}`
- 相同 lead_key → 更新现有 lead
- 新 lead_key → 创建新 lead
- 无需 `is_new_inquiry` 字段

**向后兼容**：保留 `extracted_fields`，处理逻辑优先使用 `leads` 数组，fallback 到旧格式

### 4.3 SYSTEM_PROMPT 实际实现

以下是 `src/claude.service.js` 中需要更新的 prompt 指令：

```
MULTI-LEAD EXTRACTION:
User messages may contain multiple product inquiries. Extract each distinct inquiry as a separate lead.

RULES:
1. Each UNIQUE (car_model + destination_country) combination = 1 lead entry
2. Return leads as an array, even if only 1 lead
3. ALWAYS include car_model and/or destination_country for lead matching
4. Shared info (company_name, buyer_type) can be included in each relevant lead
5. If user asks follow-up without mentioning car/destination, infer from conversation context

EXAMPLES:

Single inquiry:
User: "I want BYD Seal 50 units to Dubai"
→ leads: [{ car_model: "BYD Seal", destination_country: "UAE", qty_bucket: "20+" }]

Multiple inquiries in one message:
User: "I want BYD Seal to Dubai, also Atto 3 to Saudi, and Han to Qatar"
→ leads: [
    { car_model: "BYD Seal", destination_country: "UAE" },
    { car_model: "BYD Atto 3", destination_country: "Saudi Arabia" },
    { car_model: "BYD Han", destination_country: "Qatar" }
  ]

Follow-up (infer context):
Previous: BYD Seal to Dubai
User: "I want red color, 5 units"
→ leads: [{ car_model: "BYD Seal", destination_country: "UAE", color_quantity: [{color: "red", qty: 5}] }]

Mixed (existing + new):
Previous: BYD Seal to Dubai
User: "I want red for the Seal. Also interested in Atto 3 to same destination"
→ leads: [
    { car_model: "BYD Seal", destination_country: "UAE", color_quantity: [{color: "red", qty: null}] },
    { car_model: "BYD Atto 3", destination_country: "UAE" }
  ]

General question (no lead update):
User: "What payment methods do you accept?"
→ leads: []

COLOR QUANTITY EXTRACTION:
When user mentions specific colors and quantities, extract them into color_quantity array within the relevant lead.
- Format: [{"color": "exterior" or "exterior|interior", "qty": number}]
- Examples:
  - "白色6台，黑色4台" → [{color: "white", qty: 6}, {color: "black", qty: 4}]
  - "灰色外观黑内饰7台" → [{color: "gray|black", qty: 7}]
- Use "|" to separate exterior and interior colors
- Leave empty [] if no specific color/quantity mentioned
```

### 4.4 generateJsonInstruction 函数

为保持 JSON_SCHEMA 和 jsonInstruction 的一致性，实现了自动生成函数：

```javascript
/**
 * Generate JSON instruction string from JSON_SCHEMA
 * Converts schema to example JSON with enum values as pipe-separated options
 */
function generateJsonInstruction(schema) {
  function buildExample(property) {
    if (!property) return '';
    const type = property.type;

    if (type === 'object') {
      const example = {};
      Object.entries(property.properties || {}).forEach(([key, prop]) => {
        example[key] = buildExample(prop);
      });
      return example;
    }

    if (type === 'array') {
      if (property.items?.type === 'object') {
        const itemExample = {};
        Object.entries(property.items.properties || {}).forEach(([key, prop]) => {
          itemExample[key] = buildExample(prop);
        });
        return [itemExample];
      }
      return [];
    }

    if (type === 'string') {
      return property.enum ? property.enum.join('|') : '';
    }

    if (type === 'number') return 0;
    if (type === 'boolean') return false;
    return '';
  }

  const example = {};
  Object.entries(schema.properties || {}).forEach(([key, prop]) => {
    example[key] = buildExample(prop);
  });

  return `\n\nRESPONSE FORMAT: You MUST respond with valid JSON only, no markdown. Use this exact structure:\n${JSON.stringify(example)}`;
}
```

**优点**：
- 单一数据源（JSON_SCHEMA）
- 自动处理 enum 转换为 `|` 分隔格式
- 支持嵌套对象和数组
- 添加新字段只需修改 JSON_SCHEMA

---

## 5. 核心逻辑变更

### 5.1 lead.repository.js 新增函数

```javascript
/**
 * 根据 lead_key 查找或创建 lead
 * @param {string} conversationId - 对话 ID
 * @param {string} contactId - 联系人 ID
 * @param {string|null} leadKey - Lead 标识键
 */
export async function findOrCreateLeadByKey(conversationId, contactId, leadKey) {
  if (!leadKey) {
    // 没有 leadKey，使用默认 lead
    return findOrCreateLead(conversationId, contactId);
  }

  // 查找现有的活跃 lead（route='CONTINUE' 表示活跃）
  const { data: existing, error: findError } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('lead_key', leadKey)
    .eq('route', 'CONTINUE')
    .maybeSingle();

  if (existing) return existing;

  // 创建新 lead
  const { data, error } = await supabase
    .from('leads')
    .insert({
      conversation_id: conversationId,
      contact_id: contactId,
      lead_key: leadKey,
      stage: 'GREET',
      score: 0,
      route: 'CONTINUE',
    })
    .select()
    .single();

  if (error) {
    // 处理并发创建的情况
    if (error.code === '23505') {
      const { data: existing } = await supabase
        .from('leads')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('lead_key', leadKey)
        .eq('route', 'CONTINUE')
        .single();
      if (existing) return existing;
    }
    throw error;
  }

  console.log(`Created new lead ${data.id} with key: ${leadKey}`);
  return data;
}

/**
 * 获取对话下所有活跃的 leads（route='CONTINUE' 表示活跃）
 */
export async function getLeadsByConversation(conversationId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('route', 'CONTINUE')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}
```

### 5.2 session.js processMessage 重构（支持多 Lead）

```javascript
export async function processMessage(waId, userMessageContent, claudeResponse) {
  const session = await getSession(waId);

  // 1. 获取 leads 数组（兼容旧格式）
  const leadsData = claudeResponse.leads || [];

  // 兼容旧格式：如果没有 leads 数组，从 extracted_fields 构建
  if (leadsData.length === 0 && claudeResponse.extracted_fields) {
    leadsData.push({ ...claudeResponse.extracted_fields });
  }

  // 2. 创建用户消息（先不关联 lead，后续关联到第一个 lead）
  const userMessage = await createMessage({
    conversationId: session.conversation_id,
    role: 'user',
    content: userMessageContent,
    sentBy: 'customer',
  });

  // 3. 处理每个 lead
  const processedLeads = [];
  for (const leadData of leadsData) {
    // 3.1 生成 lead key
    const leadKey = generateLeadKey(leadData);

    // 3.2 获取或创建 lead
    const targetLead = await findOrCreateLeadByKey(
      session.conversation_id,
      session.contact_id,
      leadKey,
      userMessage.id // source_message_id
    );

    // 3.3 计算该 lead 的分数增量
    // 注意：score_delta 是整体的，按 lead 数量平均分配，或全部给第一个
    const scoreDelta = processedLeads.length === 0
      ? (claudeResponse.score_delta || 0)
      : 0;

    // 3.4 更新 lead 数据
    const newScore = targetLead.score + scoreDelta;
    await updateLeadFromClaudeFields(targetLead.id, leadData, newScore);

    processedLeads.push(targetLead);
  }

  // 4. 关联用户消息到第一个 lead（主要询问）
  if (processedLeads.length > 0) {
    await updateMessage(userMessage.id, {
      score_delta: claudeResponse.score_delta || 0,
      risk_flags: claudeResponse.risk_flags || [],
      leadId: processedLeads[0].id,
    });
  }

  // 5. 创建助手消息（关联到第一个 lead）
  await createMessage({
    conversationId: session.conversation_id,
    role: 'assistant',
    content: claudeResponse.next_message,
    sentBy: 'bot',
    leadId: processedLeads[0]?.id,
  });

  // 6. 更新对话时间戳
  await updateConversationOnMessage(session.conversation_id);

  // 7. 更新联系人公司名（如有，任意 lead 中提取）
  const companyName = leadsData.find(l => l.company_name)?.company_name;
  if (companyName) {
    await updateContact(session.contact_id, { company_name: companyName });
  }

  // 8. 处理终结路由（仅影响第一个 lead）
  // route 字段本身会被更新为 HUMAN_NOW/NURTURE/FAQ_END，表示 lead 不再活跃
  // 无需额外的 status 字段

  // 9. 返回更新后的 session
  return getSessionWithAllLeads(waId);
}

/**
 * 从 lead 数据更新 lead（单个 lead 的字段）
 */
async function updateLeadFromClaudeFields(leadId, leadData, newScore) {
  const updates = { score: newScore };

  if (leadData.destination_country) updates.destinationCountry = leadData.destination_country;
  if (leadData.destination_port) updates.destinationPort = leadData.destination_port;
  if (leadData.car_model) updates.carModel = leadData.car_model;
  if (leadData.qty_bucket) updates.qtyBucket = leadData.qty_bucket;
  if (leadData.buyer_type) updates.buyerType = leadData.buyer_type;
  if (leadData.timeline) updates.timeline = leadData.timeline;
  if (leadData.international_commercial_term) updates.incoterm = leadData.international_commercial_term;
  if (leadData.loading_port) updates.loadingPort = leadData.loading_port;
  if (leadData.brand) updates.brand = leadData.brand;

  // color_quantity 使用 merge 逻辑
  if (leadData.color_quantity && leadData.color_quantity.length > 0) {
    const currentLead = await findLeadById(leadId);
    const existingColorQty = currentLead?.color_quantity || [];
    updates.colorQuantity = mergeColorQuantity(existingColorQty, leadData.color_quantity);
  }

  return updateLead(leadId, updates);
}
```

### 5.3 message.repository.js 新增函数

```javascript
/**
 * 创建消息（支持 lead 关联）
 */
export async function createMessage(messageData) {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: messageData.conversationId,
      role: messageData.role,
      content: messageData.content,
      score_delta: messageData.scoreDelta || 0,
      risk_flags: messageData.riskFlags || [],
      sent_at: messageData.sentAt || new Date().toISOString(),
      sent_by: messageData.sentBy,
      lead_id: messageData.leadId || null,  // 新增
      metadata: messageData.metadata || {},
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * 获取指定 lead 的总分
 */
export async function getTotalScoreForLead(leadId) {
  const { data, error } = await supabase
    .from('messages')
    .select('score_delta')
    .eq('lead_id', leadId);

  if (error) throw error;
  return (data || []).reduce((sum, msg) => sum + (msg.score_delta || 0), 0);
}
```

---

## 6. 状态机和评分

### 6.1 每个 Lead 独立 Stage

每个 lead 有自己的 `stage` 字段，独立跟踪：
- Lead A (BYD Seal → UAE): QUALIFY
- Lead B (BYD Atto 3 → Saudi): GREET

### 6.2 每个 Lead 独立评分

分数通过 `messages.lead_id` 关联，各自累加：
- Lead A 的分数 = SUM(messages.score_delta WHERE lead_id = A)
- Lead B 的分数 = SUM(messages.score_delta WHERE lead_id = B)

### 6.3 每个 Lead 独立路由

当一个 lead 到达终结状态（HUMAN_NOW/NURTURE/FAQ_END）时：
- 该 lead 的 route 字段更新为终结状态（不再是 'CONTINUE'）
- 对话继续保持 'active'（可能还有其他活跃 lead）
- 只有所有 lead 都结束后（route != 'CONTINUE'），对话才关闭

---

## 7. Dashboard 变更

### 7.1 Inbox 页面

```javascript
// 获取对话下所有活跃 leads（route='CONTINUE' 表示活跃）
const fetchLeads = useCallback(async (conversationId) => {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('route', 'CONTINUE')
    .order('created_at', { ascending: false });

  if (!error) setLeads(data || []);
}, [supabase]);
```

### 7.2 LeadsList 组件

显示多个 lead 卡片，每个包含：
- 车型 + 目的地（lead_key 解析）
- 当前 stage
- 分数
- color_quantity 列表

### 7.3 实时订阅

```javascript
// 订阅 leads 表变更
supabase.channel('leads-changes')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'leads',
    filter: `conversation_id=eq.${conversationId}`,
  }, handleLeadChange)
  .subscribe();
```

---

## 8. 实现步骤

### Phase 1: 数据库迁移 (P0)

1. 创建 `supabase/migrations/006_multi_lead_support.sql`
2. 添加 leads 表新字段
3. 添加 messages.lead_id 字段
4. 创建索引

### Phase 2: Repository 层 (P0)

5. `lead.repository.js` 添加 `findOrCreateLeadByKey`, `getLeadsByConversation`
6. `message.repository.js` 添加 `leadId` 支持和 `getTotalScoreForLead`
7. 添加 `src/lead-key.js` 工具函数

### Phase 3: Claude Schema 重构 (P0)

8. `claude.service.js` 重构 JSON_SCHEMA：
   - 将 `extracted_fields` + `lead_intent` 合并为 `leads` 数组
   - 每个 lead 包含所有提取字段（car_model, destination_country 等）
   - 移除 `is_new_inquiry`（通过 lead_key 自动判断）
   - 保留 `extracted_fields` 用于向后兼容
9. 更新 SYSTEM_PROMPT 添加多 lead 提取指导
10. 更新 `generateJsonInstruction` 支持新结构

### Phase 4: 消息处理 (P0)

11. `session.js` 重构 `processMessage`：
    - 遍历 `claudeResponse.leads` 数组
    - 每个 lead 生成 lead_key 并 findOrCreate
    - 兼容旧格式 `extracted_fields`
12. `queue-processor.js` 适配多 lead
13. `state-machine.js` 适配（接收 lead 而非 session）
14. `lead.repository.js` 新增 `updateLeadFromClaudeFields` 函数

### Phase 5: Dashboard (P1)

13. `inbox/page.js` 支持多 lead 显示
14. `LeadsList.js` 显示 lead 列表
15. `LeadDetails.js` 显示 color_quantity

### Phase 6: 路由和同步 (P2)

16. `routing.service.js` 适配独立 lead 路由
17. 同步脚本适配

---

## 9. 兼容性

### 9.1 数据迁移

```sql
-- 为现有 lead 设置默认 lead_key
UPDATE leads
SET lead_key = 'default'
WHERE lead_key IS NULL;

-- 现有 messages 的 lead_id 保持 null（向后兼容）
```

### 9.2 API 兼容

- 现有 `/api/leads/*` 保持不变
- 新增 `/api/conversations/:id/leads` 获取对话下所有 leads

---

## 10. 消息聚合与多 Lead 场景

### 10.1 问题背景

消息队列聚合机制会将快速连续的消息合并为一次 Claude 调用：

```
T+0ms:   用户发送 "I want BYD Seal to Dubai"
T+500ms: 用户发送 "Also Atto 3 to Saudi"
T+800ms: 用户发送 "And Han to Qatar, 30 units each"
T+2000ms: 聚合处理，Claude 收到:
  "I want BYD Seal to Dubai
  Also Atto 3 to Saudi
  And Han to Qatar, 30 units each"
```

### 10.2 Claude 响应结构

```json
{
  "stage": "GREET",
  "leads": [
    {
      "car_model": "BYD Seal",
      "destination_country": "UAE",
      "qty_bucket": "20+"
    },
    {
      "car_model": "BYD Atto 3",
      "destination_country": "Saudi Arabia",
      "qty_bucket": "20+"
    },
    {
      "car_model": "BYD Han",
      "destination_country": "Qatar",
      "qty_bucket": "20+"
    }
  ],
  "score_delta": 25,
  "reasons": ["Clear quantity (30 units)", "Multiple specific models", "Clear destinations"],
  "risk_flags": [],
  "route": "CONTINUE",
  "next_message": "Great, friend! 3 models to 3 countries 👍 What's your company name?",
  "handoff_summary": ""
}
```

**Lead 匹配**：
- `BYD Seal + UAE` → lead_key: `model:byd seal|dest:uae` → 新建或更新
- `BYD Atto 3 + Saudi Arabia` → lead_key: `model:byd atto 3|dest:saudi arabia` → 新建或更新
- `BYD Han + Qatar` → lead_key: `model:byd han|dest:qatar` → 新建或更新

### 10.3 处理流程

1. `processMessage` 遍历 `leads` 数组
2. 每个 lead 生成独立的 `lead_key`
3. 创建 3 个独立的 lead 记录
4. 用户消息关联到第一个 lead
5. 发送单条回复给用户

### 10.4 分数分配策略

- `score_delta` 是整体评分，分配给**第一个 lead**
- 后续消息中，各 lead 的分数独立累加
- 这样避免同一轮对话重复计分

---

## 11. 测试场景

### 11.1 基础场景
1. **单一商机**: 行为与当前一致
2. **Lead Key 匹配**: 同一 car_model+destination 更新而非重复创建
3. **多商机创建**: 不同 car_model+destination 创建独立 lead
4. **评分隔离**: 两个 lead 分数独立
5. **Stage 独立**: 一个 PROOF，另一个 GREET
6. **路由独立**: 一个 HUMAN_NOW，另一个继续
7. **color_quantity**: 正确提取和存储颜色数量
8. **color_quantity 合并**: 同色更新数量，异色追加

### 11.2 消息聚合场景
9. **聚合多商机**: 3条消息聚合，创建3个独立 lead
10. **聚合混合场景**: 聚合消息中包含1个现有+2个新商机（通过 lead_key 自动判断）
11. **分数分配**: 聚合场景下 score_delta 只给第一个 lead
12. **回复合理性**: 多商机时回复统一处理所有询问
13. **上下文推断**: 用户未提及车型时，从对话上下文推断

### 11.3 向后兼容
14. **旧格式兼容**: `extracted_fields` 仍能正常处理（转换为单元素 leads 数组）
15. **渐进迁移**: 新旧响应格式可以混合使用
