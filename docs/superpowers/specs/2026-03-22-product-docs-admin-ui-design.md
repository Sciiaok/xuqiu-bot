# Product Docs Admin UI - Design Spec

## Overview

在 dashboard 中新增"Product Docs"管理页面，允许用户上传 PDF、查看解析状态/结果、删除文档，并保留操作记录。

## UI 布局

```
┌─────────────────────────────────────────────────────────┐
│  Product Docs                          [Upload PDF ▲]   │
├─────────────────────────────────────────────────────────┤
│  Agent Filter: [All ▾] [agri_machinery] [vehicle] ...   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 📄 2004E.pdf                     ● Ready        │   │
│  │ Agent: agri_machinery  |  1 page  |  37 fields  │   │
│  │ Model: DF2004E  |  Uploaded: 2 hours ago        │   │
│  │                        [View Specs] [Delete]     │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 📄 3004F.pdf                     ◐ Processing   │   │
│  │ Agent: agri_machinery  |  Processing...          │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 📄 old-spec.pdf                  ✕ Error        │   │
│  │ Agent: vehicle  |  Error: Table extraction fail  │   │
│  │                        [Retry] [Delete]          │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  Operation History                                      │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 14:30  admin@  Uploaded 2004E.pdf → agri_mach..  │  │
│  │ 14:31  system  Parsed 2004E.pdf: 1 spec, 2 emb  │  │
│  │ 13:00  admin@  Deleted old-catalog.pdf           │  │
│  │ 12:45  system  Error parsing broken.pdf: ...     │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### View Specs Modal

```
┌─────────────────────────────────────────┐
│  DF2004E Specifications          [✕]    │
├─────────────────────────────────────────┤
│  Brand: SDEC                            │
│  Product Line: agri_machinery           │
│                                         │
│  ┌──────────────────┬──────────────┐   │
│  │ nominal_power_kw │ 147          │   │
│  │ rated_power_kw   │ 162          │   │
│  │ fuel_tank_l      │ 400          │   │
│  │ min_mass_kg      │ 7375         │   │
│  │ wheel_base_mm    │ 2900         │   │
│  │ ...              │ ...          │   │
│  └──────────────────┴──────────────┘   │
│                                         │
│  Chunks: 2 embeddings                   │
│                          [Close]        │
└─────────────────────────────────────────┘
```

## Database: Operation Log Table

```sql
CREATE TABLE product_doc_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES product_documents(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL REFERENCES agents(id),
  operation TEXT NOT NULL CHECK (operation IN ('upload', 'parsed', 'error', 'delete', 'retry')),
  operator TEXT,           -- user email or 'system'
  details JSONB DEFAULT '{}',  -- filename, specs_count, error_message, etc.
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_product_doc_ops_agent ON product_doc_operations(agent_id);
CREATE INDEX idx_product_doc_ops_created ON product_doc_operations(created_at DESC);
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `supabase/migrations/020_product_doc_operations_log.sql` | New | 操作记录表 |
| `app/dashboard/components/Sidebar.js` | Edit | 添加 "Product Docs" 导航项 |
| `app/dashboard/docs/page.js` | New | 主页面：文档列表 + 上传 + 操作记录 |
| `app/dashboard/components/ProductDocUploader.js` | New | 上传组件（拖拽/点击 + 选择 agent） |
| `app/dashboard/components/ProductDocCard.js` | New | 文档卡片（状态 badge、spec 预览、操作按钮） |
| `app/dashboard/components/ProductSpecViewer.js` | New | Spec 详情弹窗（解析参数表格） |
| `app/api/product-docs/upload/route.js` | Edit | 上传时写操作日志 |
| `app/api/product-docs/[id]/route.js` | Edit | 删除时写操作日志 |
| `app/api/product-docs/operations/route.js` | New | GET 操作记录 API |
| `src/product-knowledge.service.js` | Edit | 解析完成/失败时写操作日志 |

## Key Interactions

### Upload Flow
1. 点击 "Upload PDF" 或拖拽文件到上传区域
2. 选择关联的 agent（下拉选择）
3. 上传 → 卡片出现 "Processing" 状态
4. 前端轮询 `GET /api/product-docs` 直到 status 变为 ready/error（每 3s，仅当有 processing 状态时）
5. 操作记录自动追加

### View Specs
1. 点击 "View Specs" → 调用 `GET /api/product-docs/[id]/specs`
2. 弹窗显示 model、brand、所有 spec fields 的 key-value 表格
3. 底部显示 embedding chunks 数量

### Delete
1. 点击 "Delete" → 确认弹窗（"确定删除 2004E.pdf？关联的 specs 和 embeddings 将一并删除"）
2. 调用 `DELETE /api/product-docs/[id]`
3. 级联删除 specs + embeddings + storage 文件
4. 操作记录追加

### Polling Logic
```javascript
useEffect(() => {
  const hasProcessing = docs.some(d => d.status === 'processing');
  if (!hasProcessing) return;
  const timer = setInterval(() => fetchDocs(), 3000);
  return () => clearInterval(timer);
}, [docs]);
```

## API Endpoints

### GET /api/product-docs/operations
```
Query: ?agent_id=uuid&limit=20
Response: [{
  id, document_id, agent_id, operation, operator,
  details: { filename, specs_count, error_message, ... },
  created_at
}]
```

## UI Patterns (follow existing dashboard conventions)

- **Cards**: `bg-surface rounded-xl border border-border p-4`
- **Status badges**: ready=green, processing=blue (animate-pulse), error=red, pending=amber
- **Buttons**: `btn btn-primary` for Upload, `btn btn-secondary` for View, `btn btn-ghost` for Delete
- **Modal**: Fixed overlay `bg-black/50 z-50`, content `max-w-lg`
- **Filters**: Agent toggle buttons (same pattern as FilterBar)
- **Empty state**: Centered text with upload CTA
- **Operation log**: Compact list with timestamp, operator, action description

## Implementation Order

1. Migration (操作记录表)
2. API 改造（上传/删除/解析时写操作记录 + 操作记录查询 API）
3. Sidebar 导航项
4. 页面 + 4 个组件
5. 轮询逻辑
6. Playwright E2E 测试
