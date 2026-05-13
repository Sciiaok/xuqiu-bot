# state-output-schema

本文件定义 AI 接待每轮最少需要输出的结构化状态。

## 1. 必填字段

- `current_stage`
- `known_fields`
- `missing_fields`
- `next_best_action`
- `need_human_handover`
- `handover_reason`
- `customer_intent_level`
- `reply_to_customer`

## 2. 字段含义

### current_stage

当前所处阶段，建议取值：

- `inbound`
- `lead_collection`
- `dealing`
- `negotiation`
- `order_intent`
- `human_handover`

### known_fields

当前已确认的关键业务字段，至少包括：

- model
- configuration
- color
- quantity
- destination_country
- destination_port
- trade_term
- company_name

说明：

- `model` 仍建议保留在输出中，便于系统统一维护产品标识
- 但当前整车业务线中，leads 收集完成和正式报价前的最低必填字段以宿主业务规则为准，最低必填字段为：
  - configuration
  - color
  - quantity
  - destination_country
  - destination_port
  - trade_term
  - company_name

### missing_fields

当前仍缺失、且影响下一步推进的字段列表。

### next_best_action

建议下一步动作，建议取值：

- `collect_fields`
- `answer_with_kb`
- `prepare_quote`
- `continue_negotiation`
- `prepare_order_handover`
- `handover_to_human`

### need_human_handover

- `yes`
- `no`

### handover_reason

若需转人工，必须说明原因。若无需转人工，可为空。

### customer_intent_level

建议取值：

- `low`
- `medium`
- `high`

### reply_to_customer

对客户的最终回复内容。
