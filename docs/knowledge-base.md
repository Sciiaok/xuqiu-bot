# Knowledge Base 模块技术规格

> 最后更新：2026-05-12
>
> 适用范围：当前 4-layer KB 架构（2026-05-08 collapse 之后），Sonnet 4.6 (1M
> context GA) 作为抽取/翻译模型，OpenAI `text-embedding-3-small` 作为向量模型。

---

## 1. 模块定位

知识库（Knowledge Base，KB）是 LeadEngine 里把"客户上传的文件"转成"Medici
能直接查询的结构化事实"的模块。它解决的是**"客户问星耀6 多少钱，Medici
能从用户上传的 Excel 里查到准确报价"**这件事 ── 中间所有的解析、翻译、嵌入、
冲突检测、查询路由都属于这个模块。

KB 是 product-line 范畴 ── **每条产品线一套独立 KB**，不跨产品线共享。

**主要文件：**

| 角色 | 路径 |
|---|---|
| 上传/解析管道入口 | `src/kb-upload.service.js` |
| 文件 → 文本/切片 | `src/kb-file-parsers.js` |
| Medici 工具读路径 | `src/kb-tools.service.js` |
| 向量检索 + 翻译 | `src/kb-search.service.js` |
| 图片抽取（Excel/PDF 嵌入图） | `src/kb-image-extractor.service.js` |
| 上传进度 SSE 总线 | `lib/kb-upload-bus.js` |
| UI | `app/(app)/product-lines/[id]/knowledge-base/KnowledgeBaseTab.js` |
| Medici 工具定义 | `src/agents/medici/kb-tools.js` |

**主要表：** `kb_documents` `kb_knowledge_points` `kb_products`
`kb_shipping_routes` `kb_qa_snippets` `kb_assets` `kb_corrections`
`kb_knowledge_gaps` `kb_pending_review`。Schema 详见 `.claude/index/schema.md`。

---

## 2. 数据模型

### 2.1 四层架构

每个 KB document 上传时被打上一个 `layer` 标签，对应不同的内容性质：

| layer | 中文名 | 典型文件 | 主写入表（除 KP 外） |
|---|---|---|---|
| `company` | 公司基础信息 | 公司介绍、资质证书、出口许可 | — |
| `product` | 产品 & 价格 | 产品手册、价格表、配置清单 | **kb_products** |
| `logistics` | 物流 & 交付 | 海运/空运费率表、装柜数据、运输周期 | **kb_shipping_routes** |
| `sales` | 销售话术 & 政策 | FAQ、谈判政策、Q&A、付款条款 | — |

**关键约束：**
1. 所有上传都会写 `kb_knowledge_points`（KP，向量索引层）。
2. `product` / `logistics` 层**额外**结构化抽取一遍，独立写 `kb_products` / `kb_shipping_routes`。这是为了让 Medici 的工具调用走"deterministic SQL"而不是向量相似度 ── 报价场景下相似度匹配是不可接受的。
3. `kb_qa_snippets` 是**人工录入**的销售 Q&A，不走 LLM 抽取管道，由前端"对话式录入"或"知识管理"页面直接 insert。

### 2.2 读路径优先级（Medici 工具）

`src/agents/medici/kb-tools.js` 暴露 6 个工具：

| 工具 | 主查表 | 兜底 |
|---|---|---|
| `lookup_product` | `kb_products`（filter: is_active + high_confidence + not expired，模糊匹配 `sku/model/product_name/product_name_en`） | 不兜底，找不到返回 `{found:false, suggestions}` |
| `quote_price` | 内部调 `lookup_product` + `lookup_shipping` + `check_constraint`，组合算 FOB/CIF/DDP | needs_human 时返回让客服接管 |
| `lookup_shipping` | `kb_shipping_routes`（filter 同上） | 找不到时返回同国家备选港口 |
| `lookup_policy` | 1. 先查 `kb_qa_snippets`（人工权威）2. 不命中再走向量检索 `kb_knowledge_points` | 都没就 `{found:false}` |
| `find_asset` | `kb_assets`（tag 匹配优先，semantic 兜底） | matched_by 字段区分两种来源 |
| `check_constraint` | `kb_qa_snippets` 里的特殊条目（人工录入业务规则） | 没规则就返回 `unknown` |

**Medici 决策逻辑是 if-else，不是 similarity ranking**。例如：`quote_price` 必须先 `lookup_product` 拿到精确 SKU，再用该 SKU 的 `fob_price_usd`，绝不会因为"两个产品名相似"就给报价。

---

## 3. 上传管道（写路径）

### 3.1 完整数据流

```
浏览器 (multipart)
   │ POST /api/knowledge/upload  (≤2s)
   ▼
[/api/knowledge/upload/route.js]
   ├── SHA256 去重（同 agent + 同 content → 复用 doc_id）
   ├── 写 kb-assets bucket（best-effort）
   ├── INSERT kb_documents (status='processing')
   └── 立即 200 返回 { document_id }
        │ fire-and-forget
        ▼
   runBackground():
   ├── parseBufferToContent(buffer, fileType)
   │     ├── xlsx  → extractExcelChunks → Array<{ label, content, sheet, row_start, row_end, total_rows }>
   │     ├── pdf   → extractPdfText → string
   │     ├── docx  → extractDocxText → string
   │     └── md/txt/csv → buffer.toString('utf-8') → string
   │
   ├── processDocument(ctx, docId, contentOrChunks, layer, options)
   │     │
   │     ├── normalizeToChunks() —— 单 string 视为 1 个 chunk
   │     │
   │     ├── Pass 1..N: 每个 chunk 并发 (上限 3)：
   │     │     ┌─ extractKnowledgePoints  ── Sonnet 4.6, max_tokens=32K
   │     │     │   capInputForLlm(content, 600K cap)
   │     │     │   返回 { knowledge_points[], input_truncated, output_truncated, parse_failed }
   │     │     │
   │     │     └─ extractStructuredProducts (if layer=product)
   │     │       OR extractStructuredShipping (if layer=logistics)
   │     │         同样 600K cap + 32K 输出 + 同样的截断信号
   │     │
   │     ├── 聚合：concat 所有 chunks 的 KPs + structured rows
   │     │
   │     ├── 结构化批量 INSERT (kb_products / kb_shipping_routes)
   │     │
   │     ├── KP 逐条 (并发 8)：
   │     │     ├─ detectLanguage
   │     │     ├─ translateToEnglish (Haiku, 仅非英文)
   │     │     ├─ generateEmbedding × 2 (OpenAI)
   │     │     ├─ INSERT kb_knowledge_points
   │     │     └─ detectConflict (SKU/price 冲突)
   │     │
   │     └── 决定最终 status：
   │           任一 chunk input_truncated/output_truncated/parse_failed
   │             → 'partial' + partial_reason
   │           全干净
   │             → 'ready'
   │
   └── 并行：extractAndStoreImages (Excel/PDF 嵌入图 → kb-assets bucket + kb_assets 表)

   全程通过 lib/kb-upload-bus.js 推 SSE 进度事件
浏览器 ← GET /api/knowledge/upload/stream?doc_id=...
```

### 3.2 关键代码位置

| 阶段 | 文件 | 函数 |
|---|---|---|
| HTTP 入口 | `app/api/knowledge/upload/route.js` | `POST` |
| 后台任务 | 同上 | `runBackground` |
| Excel 切片 | `src/kb-file-parsers.js` | `extractExcelChunks` |
| 多格式统一入口 | 同上 | `parseBufferToContent` |
| 主管道 | `src/kb-upload.service.js` | `processDocument` |
| 单 chunk 抽取 | 同上 | `runExtractionPass` |
| LLM input 截断 | 同上 | `capInputForLlm` |
| KP 抽取 | 同上 | `extractKnowledgePoints` |
| 结构化抽取 | 同上 | `extractStructuredProducts` / `extractStructuredShipping` |
| 状态收尾 | 同上 | `finalizeDocStatus` |

---

## 4. 文件格式支持

| MIME | fileType | 解析器 | chunking 策略 | 大文件行为 |
|---|---|---|---|---|
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `xlsx_text` | `xlsx` 包 + 自写 `extractExcelChunks` | **每 sheet 按 80 行切片**，每片自带 header | 自动多 chunk 并发抽取，输入端不受 600K cap 影响 |
| `application/pdf` | `pdf_text` | `pdf-parse` | 单串文本 | 触发 600K cap → status='partial' / partial_reason='input_truncated' |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `docx` | `mammoth` | 单串文本 | 同上 |
| `text/markdown` / `text/plain` / `text/csv` | `markdown` / `txt` / `csv` | `buffer.toString('utf-8')` | 单串文本 | 同上；**编码假设 UTF-8，GBK 文件会乱码** |

**已知短板：**

1. **CSV 不做行切片** ── 直接当文本送 LLM。超大 CSV 会撞 600K cap。短期内不修，需要时改 fileType 路由到 Excel 同款 chunking 即可。
2. **PDF 不做章节切片** ── 巨型 PDF（如 30MB 整本书）能进 600K 但输出端可能撞 32K token 上限，得到 partial。当前接受这个限制。
3. **Excel 合并单元格不还原** ── 合并 cell 在 `sheet_to_json` 里只有左上角的 cell 有值，其它是空字符串。罕见，未修。

---

## 5. 性能 & 成本规格

### 5.1 LLM 调用预算

| 项 | 值 | 备注 |
|---|---|---|
| 抽取模型 | `anthropic/claude-sonnet-4.6` via OpenRouter | 1M 上下文 GA，flat $3/$15 per MTok（无 200K 之上分段加价） |
| 翻译模型 | `anthropic/claude-haiku-4.5` | $0.80/$4 per MTok |
| 嵌入模型 | `openai/text-embedding-3-small` | $0.02 per MTok input |
| **单次 LLM 输入硬上限** | `LLM_INPUT_HARD_CAP_CHARS = 600_000` chars | 600K 字符 ~ 150-200K tokens 安全余量 |
| **单次 LLM 输出上限** | `max_tokens = 32_000` | 64K 是 Sonnet 4.6 物理上限，留余量给 prompt overhead |
| Excel chunk 大小 | 80 data rows + header | 每 chunk 输出 ~16K tokens，远低于 32K |
| Pass 并发上限 | 3 | OpenRouter 上 Sonnet 4.6 稳定 RPS |
| KP 处理并发 | 8 | 单 KP = translate + 2 embed |

### 5.2 各路径输出能力天花板

每行 JSON 输出 token 估算：

| 对象 | tokens/行 | 32K 输出能写 |
|---|---|---|
| `knowledge_point`（含 metadata + source_location） | ~150 | ~210 条 |
| `kb_products`（含 specs） | ~200 | ~160 条 |
| `kb_shipping_routes` | ~80 | ~400 条 |

→ Excel 走 chunked 永远不撞顶；非 Excel 单次模式若内容超大会撞顶并标 `partial`。

### 5.3 实测延迟 & 成本（基于现状）

| 文件 | KP | Products | LLM 调用 | 预估延迟 | 预估成本 |
|---|---|---|---|---|---|
| 小 Excel (≤80 行) | 5-15 | ~10 | 2 大 + N×3 小 | 10-20s | <$0.02 |
| 中 Excel (~240 行，星耀价目表) | ~150 | ~200 | 6 大 + ~150×3 小 | 60-90s | $0.10-0.15 |
| 公司 1MB Excel | ~50 | 0 | 1 大 + 50×3 小 | 20-30s | $0.05 |
| PDF (~30 页) | ~50 | 0 | 1 大 + 50×3 小 | 30s | $0.05 |

---

## 6. 状态机 & 一致性

### 6.1 `kb_documents.status` 值域

| 状态 | 含义 | 触发 |
|---|---|---|
| `processing` | 后台解析中 | INSERT 时初始值；reparse 时回滚到此 |
| `ready` | 完整解析 ✅ | 无任何截断/失败信号 |
| `partial` | 解析完成但有数据丢失嫌疑 ⚠️ | 任一 chunk 报 input/output 截断或 parse 失败 |
| `error` | 解析过程整体崩了 ❌ | runBackground 抛异常，已清掉 partial rows |

`partial_reason` 文本枚举（status='partial' 时填）：

- `input_truncated` ── 单次 LLM 输入超 600K 字符被 `capInputForLlm` 截尾
- `output_truncated` ── 某次 LLM 输出 `finish_reason='length'`
- `chunk_partial_fail` ── Excel chunked 抽取时某些 chunk 解析失败但其它成功

### 6.2 一致性保证

| 场景 | 保证 |
|---|---|
| 上传成功后立即问 Medici | ❌ 不保证。status='processing' 期间结构化表空 |
| 首次上传中途失败 | ✅ `cleanupPartialDoc` 清掉 KP/products/shipping_routes；doc 标 'error' |
| **重新解析时 LLM 抽取阶段失败**（如 OpenRouter 500 / Anthropic 限流） | ✅ **旧数据完整保留**。`cleanupPartialDoc` 推迟到 LLM 抽取全部成功后才执行；失败时 doc 回滚到 reparse 之前的 status，`error_message` 标注失败原因 + "旧数据已保留"。Medici 继续用旧数据 |
| 重新解析时进入写库阶段后失败 | ⚠️ 旧数据已清，新数据可能半残：full cleanup + doc 标 'error'。需要用户再次重试 |
| 后台进程被 PM2 kill | ✅ `recover-stale-kb-docs` cron 兜底（15min 后清理 + 标 error） |
| 同一份文件被并发上传 | ✅ `(agent_id, content_sha256)` 唯一约束 + 23505 race handler |
| 同一份 doc 被并发 reparse | ✅ reparse 入口拒绝 status='processing' 的 doc |

**容灾设计要点**（[src/kb-upload.service.js](../src/kb-upload.service.js) 中 `processDocument` 的 `writePhaseStarted` 标志）：

```
processDocument(ctx, docId, content, layer, { isReparse: true })
  │
  ├─ PHASE 1: LLM extraction（最慢/最易抖）
  │     ├─ 所有 chunk 并发跑 KP + 结构化抽取
  │     └─ 全程不写库 ← 旧数据完整保留
  │
  ├─ [writePhaseStarted = true]
  │
  ├─ PHASE 2: Cleanup old + write new
  │     ├─ cleanupPartialDoc(docId)   ← 这里才删旧数据
  │     ├─ batch insert kb_products / kb_shipping_routes
  │     └─ 逐 KP translate + embed + insert
  │
  └─ finalize: status=ready/partial, error_message=null

catch:
  if writePhaseStarted          → cleanup + status='error'
  elif isReparse                → 还原 status / partial_reason，error_message 标失败原因
  else (first upload, phase 1)  → status='error'
```

`error_message` 字段被复用于两种语义：
- `status='error'` 时：本次上传/解析整体失败的原因
- `status='ready'` / `'partial'` 时：上次 reparse 失败但旧数据保留的提示（UI 显示 ⚠ 角标）

---

## 7. 读路径 (Medici 工具) 详细约束

### 7.1 `lookup_product` 命中条件

```sql
SELECT id, sku, model, product_name, product_name_en, category, specs,
       fob_price_usd, moq, lead_time_days, effective_date, expiry_date,
       confidence, source_doc_id
FROM kb_products
WHERE tenant_id = ?
  AND product_line_id = ?
  AND is_active = true
  AND confidence IN ('verified', 'extracted_high')
  AND (expiry_date IS NULL OR expiry_date > today)
  AND (
    -- sku / model 入参各自匹配 4 个字段，避免字段语义错配漏匹配
    sku ILIKE %?% OR model ILIKE %?% OR product_name ILIKE %?% OR product_name_en ILIKE %?%
  )
LIMIT 10
```

**找不到时**：返回当前产品线随机 5 条 `[product_name, model]` 拼接作为 suggestions。

### 7.2 `lookup_shipping` 命中条件

同上结构，匹配字段为 `destination_port`（ILIKE）+ 可选 `shipping_method` / `origin_port`。找不到时返回**同国家**的备选港口。

### 7.3 `lookup_policy` 优先级

1. **QA snippet 优先**（人工录入 → confidence='verified'）
2. 不命中再走向量检索 `kb_knowledge_points`（topic-aware layer 过滤）
3. 返回 top1 作为 `answer_text` + 全部命中作为 `citations`

---

## 8. 失败面与可观测性

| 失败模式 | 当前可见性 | 修复 / Mitigation |
|---|---|---|
| 1. 输入字符 > 600K 被截 | ✅ `logger.warn('kb.upload.input_truncated')` + `status='partial'` + UI 橙色 chip | 用户点"重新解析"或先拆文件再上传 |
| 2. 输出 token 撞 32K cap | ✅ 同上（`output_truncated`） | Excel chunk 80 行已留余量；非 Excel 撞顶就 partial |
| 3. JSON 解析失败 | ✅ `logger.warn('kb.*.parse_failed')` + 该 chunk 数据为空 → `chunk_partial_fail` | parseJsonFromLlm 已带 jsonrepair；真崩了走 partial |
| 4. pdf-parse / mammoth 未安装 | ⚠️ 返回占位字符串，整文档 0 KP | 上线时锁版本（已在 package.json） |
| 5. CSV / TXT 非 UTF-8 编码 | ❌ 静默乱码 | 限制：约定上传文件用 UTF-8 |
| 6. `lookup_product` 多匹配 | ✅ `quote_price` 返回 missing_fields=['sku'] + reason 列出冲突 SKU | 让 Medici 反问客户 |
| 7. SKU 价格冲突（两份文档同 SKU 不同价） | ✅ `kb_corrections` 写入并 surface 到 Conflict Resolver UI | 用户手动选 use_new / keep_old / coexist |
| 8. 后台进程崩了文档卡在 processing | ✅ `cron/recover-stale-kb-docs` 15min 兜底 | — |

**主要日志埋点**（`logger.*` 命名空间 `kb-upload`）：

| event | 何时 |
|---|---|
| `kb.upload.input_truncated` | 输入超 600K cap |
| `kb.upload.kp_batch_failed` | KP 并发抽取批量崩 |
| `kb.upload.failed` | 整体管道异常 |
| `kb.upload.cleanup_failed` | 失败清理时再次报错 |
| `kb.upload.partial_reason_column_missing` | 迁移没跑（向前兼容信号） |
| `kb.upload.complete` | 单文档完成态总结 |
| `kb.extract.parse_failed` | KP JSON 解析失败 |
| `kb.products.parse_failed` / `kb.shipping.parse_failed` | 结构化 JSON 解析失败 |
| `kb.kb_products.extracted` / `kb.kb_shipping_routes.extracted` | 结构化 insert 成功 |

可以用 `bun supabase logs` 或 `grep` 服务端 stdout 看上述事件。**目前没有 dashboard**，按"日志能 grep 就够"准则，等真出问题再考虑可视化。

---

## 9. 操作手册

### 9.1 上传新文档

UI：产品线详情 → 知识库 Tab → "录入" → 选层 → 拖拽文件。
约束：单文件 ≤50MB；类型须在 `ALLOWED_TYPES` 白名单内（PDF/Excel/CSV/Word/MD/TXT）。

### 9.2 重新解析（reparse）

**何时用：**
- 文档状态变成 `partial`（橙色 chip）
- chip 上出现 ⚠ 角标（上次 reparse 失败但旧数据保留）
- 你修改了管道代码（比如 prompt / chunk 阈值），想把旧文档按新代码重跑
- 上传完发现内容明显抽得不对（比如关键产品没进 kb_products）

**UI：** 知识库 Tab → 内容 → 文档列表 → 每行的"重新解析"按钮。
**API：** `POST /api/knowledge/documents/reparse?doc_id=<uuid>`

**前置：** doc 必须有 `storage_path`（早期脚本导入的没原文件，无法 reparse，需重新上传）。

**容灾保证**（§6.2 详述）：
- LLM 抽取阶段失败（如 API 抖动）→ **旧数据完整保留**，状态回滚，error_message 标注失败原因
- LLM 抽取成功后才删旧数据 + 写新数据，所以 Medici 在 reparse 进行中也始终能查到一份完整数据
- 唯一会丢数据的情况：写库阶段（cleanup 之后）出 DB 错 ── 罕见，需手动再次 reparse

### 9.3 删除文档

UI：每行"删除"按钮 → 二次确认。后端级联删 `kb_knowledge_points` /
`kb_products` / `kb_shipping_routes`。`kb_assets` 用 `source_doc_id ON DELETE
SET NULL`，资产保留，需要单独清理。

### 9.4 冲突解决

不同文档抽出同一 SKU 但价格不同 → `detectConflict` 写入 `kb_corrections`，
UI 在"内容 → 冲突"标签下展示。三种处置：
- `use_new` ── 新值替代，旧 KP 标 `superseded`，旧 doc 的 product 行设 `is_active=false`
- `keep_old` ── 新 KP 标 `superseded`
- `coexist` ── 两者都保留（适合"不同有效期" / "不同港口"等场景）

### 9.5 人工录入 Q&A

UI："内容 → Q&A" 或"录入 → 对话式录入"。这条路不走 LLM 抽取，直接 insert
`kb_qa_snippets`（priority 字段决定 Medici 选用顺序）。

---

## 10. API 参考

### 10.1 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/knowledge/upload` | 上传新文档（multipart） |
| GET | `/api/knowledge/upload/stream?doc_id=...` | SSE 订阅上传进度 |
| GET | `/api/knowledge/documents?agent_id=...` | 列文档 |
| DELETE | `/api/knowledge/documents?doc_id=...` | 删文档 |
| GET | `/api/knowledge/documents/download?doc_id=...` | 签短期 URL 下载原件 |
| **POST** | **`/api/knowledge/documents/reparse?doc_id=...`** | **重新解析（清旧数据 + 重跑）** |
| GET | `/api/knowledge/health?agent_id=...` | 4 层覆盖率快照 |
| GET / PUT | `/api/knowledge/gaps` | 未答问题列表 / 标解决 |
| GET / POST / PUT | `/api/knowledge/qa-snippets` | 人工 Q&A CRUD |
| GET / POST / PUT | `/api/knowledge/corrections` | 冲突列表 / 处置 |
| POST | `/api/knowledge/conflicts/resolve` | use_new / keep_old / coexist |
| POST | `/api/knowledge/teach` / `/teach/commit` | 对话式录入（2 步） |
| GET / POST / DELETE | `/api/knowledge/assets` | 可发送图片资产 |
| GET / POST | `/api/knowledge/pending-review` | 编辑冲突待审 |

前端封装：`lib/api/knowledge.js`（强烈建议从这里调，不要散到组件里直接 fetch）。

### 10.2 SSE 事件流（upload + reparse 共用）

订阅：`new EventSource('/api/knowledge/upload/stream?doc_id=...')`

| event | 字段 |
|---|---|
| `progress` | `{ stage: 'parsing' \| 'extracting' \| 'embedding' \| 'structured' \| 'images', ...stage-specific }` |
| `done` | `{ knowledge_points, conflicts[], images, status, partial_reason }` |
| `error` | `{ message }` |

`extracting` stage 携带 `{ pass_done, pass_total }`（chunked 模式下进度）。
`embedding` 携带 `{ done, total }`（每 5 条 emit 一次，避免 spam）。

---

## 11. Schema 速查

详细字段见 `.claude/index/schema.md`，这里只列**关键关系**：

```
kb_documents (1) ───< (N) kb_knowledge_points       FK doc_id
              ───< (N) kb_products                  FK doc_id
              ───< (N) kb_shipping_routes           FK doc_id
              ─── (N) kb_assets                     FK source_doc_id ON DELETE SET NULL

kb_qa_snippets         独立表，无 doc_id（人工录入）
kb_corrections         独立表，引用两个 kb_knowledge_points.id
kb_knowledge_gaps      独立表，question + tool_name 维度去重
kb_pending_review      独立表，待 KB 管理员人工 review 的修改
```

所有 `kb_*` 表都有 `(tenant_id, product_line_id)` 复合维度，**所有读路径必须
同时过滤这两个字段**（详见 `lib/repositories/knowledge-base.repository.js`）。

---

## 12. 已知限制 & 未来工作

**不在当前版本范围：**

1. **PDF 章节级 chunking** ── 大 PDF 一次输入跑完，撞顶就 partial。等用户实际撞到再做。
2. **CSV 行级 chunking** ── 当 CSV 行级抽取场景多了再做。
3. **内容相关性 LLM 筛选** ── 用户传"毛泽东传 PDF"也照样进 KB（30MB / 0 KP，因为 LLM 判定不是 B2B 内容）。这是产品决策，不是 bug。
4. **GBK / GB18030 自动识别** ── 当前一律按 UTF-8 解码。
5. **结构化抽取去重** ── 多 chunk 间偶发的边界重复（同一型号被两片各报一次）目前直接 concat 入库。低发，未修。
6. **向量库性能** ── pgvector 在 5K+ KP 时仍 OK；上 50K+ 时建议补 IVFFLAT 索引（schema 已留位置）。

**最近一次重大改动：**

- **2026-05-08** kb-collapse-to-four-layers ── 把旧的 `kb_qa_snippets` 七层模型合并到四层
- **2026-05-08** kb-docs-content-hash ── 加 `content_sha256` 去重
- **2026-05-12** Excel chunked extraction + 600K input cap + 'partial' status ── **本文档同期落地**

---

## 13. 修改本模块的检查清单

改 KB 模块代码时，过一遍：

- [ ] 改了 prompt → 用 dev-tools/sql 跑一个真实文档复现，对比抽取数量
- [ ] 改了 schema → 写 migration + 跑 `npm run index` 刷新 `.claude/index/schema.md`
- [ ] 改了读路径 SQL filter → 跑 Medici 模拟器问一个具体问题，确认 found/not_found 符合预期
- [ ] 改了 chunk 大小 / token 上限 → 重新算每 chunk 的输出 token 预算，留 ≥ 50% 余量
- [ ] 加了新的"silent fail" 路径 → **必须**升级到 `status='partial'` + `partial_reason`，不能让用户看不到
- [ ] 加了新的 LLM 调用 → 走 `src/llm-client.js`，写 `callSite`，让成本能查
- [ ] 改了上传管道 → 测一遍 reparse 接口，确保新代码能重跑历史文档

---

## 14. 故障排查 FAQ

### "Medici 说找不到 X 产品，但我明明上传了价格表"

按顺序排查：

1. **文档状态**：知识库 Tab → 文档列表，看那份文件状态是 `ready` 还是 `partial`？`partial` 直接点"重新解析"。
2. **结构化数据**：dev-tools/sql 跑：
   ```sql
   SELECT sku, model, product_name FROM kb_products
   WHERE doc_id = '<uuid>' AND product_name ILIKE '%X%';
   ```
   没结果 → LLM 抽漏；有结果 → 走 (3)
3. **过滤链**：上面查到的行 `is_active=true` 吗？`confidence` 是 'verified' / 'extracted_high' 吗？`expiry_date` 过期了吗？
4. **搜索字段**：`lookupProduct` 搜的是 sku/model/product_name/product_name_en 四个字段的 ILIKE。如果产品名只在 specs 里，搜不到。

### "上传完一直显示处理中"

15 分钟内：正常。
超过 15 分钟：`cron/recover-stale-kb-docs` 会把它标成 'error'。等一下再刷新；或者直接删了重传。

### "重新解析点了没反应"

- 检查 doc 是否有 `storage_path`（早期脚本导入的可能为空 → UI 按钮 disabled）
- 浏览器 Network 看 `/api/knowledge/documents/reparse` 的响应
- 服务端 stdout 找 `[knowledge/documents/reparse]` 日志

### "kb_products 数量明显比 Excel 行数少"

历史 bug（已修，2026-05-12）：旧代码在 LLM 输入端硬截到 15K 字符，超长 Excel
丢后半。修复后用 chunked 抽取，单 sheet ≤ 80 行/chunk 不会再丢。**历史脏数据
需要点"重新解析"或调 reparse API 重跑。**

---

附：本文档与代码同步维护。任何对 KB 管道的非平凡修改，请同步更新本文 §3 数据流 / §5 性能参数 / §6 状态机 / §8 失败面。
