
## 新增功能
### leads approve
- Approve：代表人工approve lead真实性，lead新增approve这个字段
- List界面新增对搜索结果批量Approve的功能
- lead到达PROOF阶段后，自动Approve

### leads同步功能
需要将leads同步到外部的供应链管理系统

1. 在leads界面，新增一个同步询单功能，可以发起询单同步任务。为了数据质量保证，点击后同步24内所有approved的lead。不过可以勾选全部同步，来实现对搜索结果所有lead的同步。

2. 系统内部维护一个单独的定时task，每隔30s检查24小时内是否有未同步的APPROVED lead（需要单独一个lead同步log表，可以只存30天内的数据）

3. lead list view中新增的2个操作按钮，1. Edit（点击后可以手动修改lead所有信息，包括approve），2. Approve（代表人工直接approve lead真实性）

## API 文档

### API 凭证
URL: https://www.revoscm.cn/api/external/inquiries/batch

X-API-Key: kEXMhOTYbNGDkVo2+8k0bEnL1bNcn3IwVplN8yLQGVM=

### Endpoint

```
POST /api/external/inquiries/batch
```

### Authentication

```
X-API-Key: <your-api-key>
```

### Request Body

```json
{
  "mode": "skip",
  "items": [
    {
      "external_id": "ai_12345",
      "customer": {
        "name": "ABC Trading Co.",
        "country": "UAE"
      },
      "inquiry": {
        "brand": "Toyota",
        "model": "Land Cruiser 300",
        "quantity": 5,
        "year": "2024",
        "colors": ["白色", "黑色"],
        "configuration": "GXR 3.5L",
        "expected_delivery_date": "2024-06-01",
        "budget_min": 50000,
        "budget_max": 60000,
        "port_of_loading": "天津港",
        "port_of_discharge": "杰贝阿里港",
        "notes": "客户通过 WhatsApp 询价"
      }
    }
  ]
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | string | 否 | `"skip"`（默认）跳过已存在，`"upsert"` 覆盖更新 |
| `items` | array | 是 | 询单数组，1-100 条 |
| `items[].external_id` | string | 是 | 外部系统唯一标识，≤64 字符 |
| `items[].customer.name` | string | 是 | 客户/公司名称 |
| `items[].customer.country` | string | 是 | 国家 |
| `items[].inquiry.brand` | string | 是 | 品牌 |
| `items[].inquiry.model` | string | 是 | 车型 |
| `items[].inquiry.quantity` | integer | 是 | 数量，正整数 |
| `items[].inquiry.year` | string | 否 | 年款 |
| `items[].inquiry.colors` | string[] | 否 | 颜色数组 |
| `items[].inquiry.configuration` | string | 否 | 配置 |
| `items[].inquiry.expected_delivery_date` | string | 否 | 期望交期，ISO 日期 |
| `items[].inquiry.budget_min` | number | 否 | 预算下限（USD） |
| `items[].inquiry.budget_max` | number | 否 | 预算上限（USD） |
| `items[].inquiry.port_of_loading` | string | 否 | 装运港 |
| `items[].inquiry.port_of_discharge` | string | 否 | 目的港 |
| `items[].inquiry.notes` | string | 否 | 备注 |

### Response

**成功 (200)**

```json
{
  "success": true,
  "summary": {
    "total": 3,
    "created": 2,
    "updated": 0,
    "skipped": 1,
    "failed": 0
  },
  "results": [
    {
      "external_id": "ai_12345",
      "status": "created",
      "inquiry_id": "550e8400-e29b-41d4-a716-446655440000",
      "inquiry_no": "INQ-20240216-001"
    },
    {
      "external_id": "ai_12346",
      "status": "skipped",
      "inquiry_id": "550e8400-e29b-41d4-a716-446655440002",
      "inquiry_no": "INQ-20240210-005"
    }
  ]
}
```

**认证失败 (401)**

```json
{
  "success": false,
  "error": "Invalid API key"
}
```

**请求格式错误 (400)**

```json
{
  "success": false,
  "error": "items must be an array with 1-100 elements"
}
```

### 状态码说明

| status | 说明 |
|--------|------|
| `created` | 新建成功 |
| `updated` | 更新成功（mode=upsert） |
| `skipped` | 已存在，跳过（mode=skip） |
| `error` | 处理失败，见 `error` 字段 |

### 示例调用

```bash
curl -X POST https://www.revoscm.cn/api/external/inquiries/batch \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secret-key" \
  -d '{
    "mode": "skip",
    "items": [
      {
        "external_id": "ai_001",
        "customer": { "name": "Dubai Motors", "country": "UAE" },
        "inquiry": {
          "brand": "Toyota",
          "model": "Prado VX",
          "quantity": 3,
          "port_of_loading": "天津港",
          "port_of_discharge": "杰贝阿里港"
        }
      }
    ]
  }'
```
