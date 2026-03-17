# Claude Tool Use 能力扩展方案

## 背景

当前系统中 Claude 的回复完全依赖系统提示词中的静态知识。当客户提到具体车型时，Claude 无法查询真实的配置、库存、价格等信息，只能泛泛而谈。通过引入 tool_use，Claude 可以在对话中主动调用外部数据源，用真实数据与客户确认需求，提升专业度和转化率。

## 实现位置

所有工具定义和调用逻辑放在 `src/claude.service.js` 的 `getResponse()` 函数中：
- 定义 `tools` 数组传入 Claude API
- 将当前单次调用改为 tool_use 循环：当 `stop_reason === 'tool_use'` 时，执行工具调用并将结果喂回 Claude，直到返回最终结构化响应
- 各工具的具体实现放在独立的 service 文件中

### 核心代码模式

```js
const tools = [{ name, description, input_schema }];

let response = await anthropic.messages.create({
  model, system, messages,
  tools,
  output_config: { format: { type: 'json_schema', schema } }
});

// tool_use 循环
while (response.stop_reason === 'tool_use') {
  const toolCall = response.content.find(b => b.type === 'tool_use');
  const result = await executeToolCall(toolCall.name, toolCall.input);
  messages.push({ role: 'assistant', content: response.content });
  messages.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: JSON.stringify(result)
    }]
  });
  response = await anthropic.messages.create({
    model, system, messages, tools, output_config
  });
}
```

---

## 工具清单（按优先级排列）

### P0 — 直接提升转化率

#### 1. `query_model_config` — 查询车型配置

- **触发场景**：客户提到具体车型（如 "BYD Seal"、"Toyota Land Cruiser"）
- **输入**：brand, model
- **输出**：可用年款、排量、驱动方式、颜色选项、基本参数
- **价值**：用真实配置数据和客户确认需求，而非凭空猜测
- **数据源**：内部车型数据库 / 外部 API

#### 2. `check_inventory` — 查询实时库存

- **触发场景**：客户确认了具体配置，需要确认有无现车
- **输入**：brand, model, year, color, config
- **输出**：库存数量、预计到货时间
- **价值**：避免报了价结果没货，提高客户信任度
- **数据源**：ERP / 库存管理系统

#### 3. `get_fob_price` — 查询报价

- **触发场景**：客户询价，或已确认车型配置后主动报价
- **输入**：brand, model, year, config, quantity
- **输出**：FOB 单价、批量折扣信息
- **价值**：Claude 可以直接给客户初步报价，大幅加速询盘推进
- **数据源**：报价系统 / 价格表

### P1 — 提升专业度和服务质量

#### 4. `check_shipping_schedule` — 查询船期

- **触发场景**：客户问 "多久能到"、讨论物流安排
- **输入**：loading_port, destination_port, cargo_type (RORO/Container)
- **输出**：最近船期、航程天数、船公司
- **价值**：直接回答交期问题，体现专业度
- **数据源**：船期查询 API / 货代系统

#### 5. `check_country_compliance` — 查询目的国进口政策

- **触发场景**：客户提到目的国，或讨论车辆规格要求
- **输入**：country, vehicle_type
- **输出**：排放标准（Euro 2/4/5）、左右舵要求、年限限制、关税税率
- **价值**：避免卖了车客户清不了关，提前筛选合规车型
- **数据源**：内部政策数据库（需维护）

#### 6. `calculate_landed_cost` — 估算到岸成本

- **触发场景**：CIF/DDP 客户询价
- **输入**：fob_price, destination_port, vehicle_specs
- **输出**：海运费估算、保险费、关税估算、到岸总成本
- **价值**：一站式报价能力，对 CIF/DDP 客户特别有吸引力
- **数据源**：运费数据 + 关税计算逻辑

### P2 — 锦上添花

#### 7. `search_similar_models` — 推荐替代车型

- **触发场景**：客户要的型号没货、已停产、或不符合目的国政策
- **输入**：original_model, requirements (价位、车型类别、用途)
- **输出**：2-3 个替代车型推荐，含简要对比
- **价值**：不让潜在客户因为没货而流失
- **数据源**：车型数据库 + 库存系统

#### 8. `get_exchange_rate` — 查询汇率

- **触发场景**：报价时客户要求当地货币价格
- **输入**：from_currency (USD), to_currency
- **输出**：当前汇率、换算后金额
- **价值**：方便客户理解价格
- **数据源**：汇率 API（如 exchangerate-api）

---

## 注意事项

1. **token 成本**：每次 tool_use 循环会增加一次 Claude API 调用，需控制单次对话最大工具调用次数
2. **超时处理**：外部 API 调用需设置超时，避免阻塞 WhatsApp 回复
3. **降级策略**：工具调用失败时，Claude 应能用已有知识继续对话，而非报错
4. **system prompt 引导**：需在系统提示词中说明何时该用工具、何时不需要，避免过度调用
5. **output_config 兼容性**：需验证 tools + json_schema output_config 是否可同时使用，如不兼容需调整为先 tool_use 循环再单独做结构化输出
