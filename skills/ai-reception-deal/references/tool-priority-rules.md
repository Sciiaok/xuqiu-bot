# tool-priority-rules

本文件定义 AI 接待在不同问题场景中对宿主知识库工具的默认调用优先级。

## 1. 适用范围

本规则适用于所有 product_line 的 KB typed tool 调用优先级。具体业务字段、KB 数据由宿主按当前 product_line 配置注入，但工具的命名、入参、返回结构是通用的。

宿主当前注册的 KB typed tool：

- `lookup_product`：按 SKU / 型号 / 属性查产品
- `quote_price`：精确报价（FOB / CIF / DDP，含边界检查）
- `lookup_freight`：目的港预录运费 / 船期数据（`found:false` 只表示"未预录运费"，**不代表"不能发"**——业务默认接受任何目的港）
- `lookup_policy`：政策 / 资质 / 公司 / 销售话术；`free_text` 优先匹配销售 Q&A snippet，再走向量检索兜底
- `find_asset`：找图（tag 优先，semantic 兜底）
- `check_constraint`：议价 / 让步 / 非标付款边界检查

每个工具返回**确定性结构**（`found:true/false` / `ok:true/false` / `decision: allowed|requires_approval|forbidden|unknown`），按结构做 if-else，不要做相似度评估。

宿主在装配工具列表时会先检测 `(tenant_id, product_line_id)` scope 下是否有任何 KB 内容，没有时这 6 个工具不会注册。处理"工具不在场"这条退路：正面承接 + 必要时转人工。

## 2. 默认优先级规则

### 2.1 价格问题

适用问题：

- 价格
- 报价
- FOB / CIF / DDP 价格
- 最终价前的标准报价

默认建议：

1. 先调 `lookup_product` 确认产品 / SKU
2. 条件齐备后调 `quote_price` 计算报价；CIF / DDP 必须带 `destination_port`，缺则先反问客户补齐，不要默认到任意港口
3. 报价规则 / 商务背景类追问（"为什么这价格" / "和别家比"）补充调 `lookup_policy({free_text: ...})`

### 2.2 库存问题

适用问题：

- 是否有货
- 是否现货
- 是否可供
- 是否能马上发运

默认建议：

- 先调 `lookup_product`，结果里通常带库存或可供状态
- 库存口径 / 替代方案话术调 `lookup_policy`

### 2.3 付款条款问题

适用问题：

- 付款方式
- 账期
- 定金比例
- 尾款节点

默认建议：

- 标准条款：`lookup_policy({topic: 'payment_terms'})`
- 客户提非标条款（特殊账期 / 信用证 / 远期付款）：先 `check_constraint({action: 'accept_payment_term', context: ...})`，`requires_approval` / `forbidden` 必须转人工

### 2.4 船期 / 运费问题

适用问题：

- 目的港运费
- CIF / DDP 价格中的运费部分
- 船期
- 整体时效

默认建议：

- 优先调 `lookup_freight({destination_port, ...})`
- 与价格计算合一时，`quote_price` 在 CIF / DDP 模式下内部已经合并运费，无须再单独算
- `lookup_freight` 返回 `found:false` 时：**不要**说"不能发"或"没有这条航线"；正确措辞是"可以发，具体运费和船期需运营同事核实"。同时**禁止**编造路线特性（频率 / 时效 / "稳定航线" / "定期班次"）

### 2.5 公司资质 / 出口能力 / 政策问题

适用问题：

- 公司背景
- 资质文件
- 出口能力
- 是否可出口到某国
- 政策 / 责任 / 赔偿口径

默认建议：

- 调 `lookup_policy({topic: ...})`；客户原话不清晰类目时用 `free_text` 兜底语义检索
- 客户主动要图（资质证书 / 公司宣传图等）才调 `find_asset`

## 3. 结果冲突时的处理

- 不同 KB 工具结果冲突时，不允许自行拼接答案
- 视为知识依据不一致，进入"需进一步确认"或转人工判断

## 4. 结果缺失时的处置语义

各工具的失败语义：

- `missing_fields` → 反问客户补齐字段
- `needs_human` / `requires_approval` / `forbidden` → 转人工
- `not_found` / `decision: 'unknown'` → 不得编造；明确告诉客户需要确认或转人工
- `matched_by: 'semantic'`（find_asset 命中）→ 先文字描述请客户确认，不要直接发图

若已具备正式报价前置条件且客户要求正式报价 / 最终价 / PI / 合同，KB 无结果时转人工。
