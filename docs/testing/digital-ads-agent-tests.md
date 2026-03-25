# 自动化数字投放 Agent — 测试用例文档

## 运行方式

```bash
# 单元测试（不需要外部 API）
node --experimental-test-module-mocks --test tests/unit/research-agent.test.js
node --experimental-test-module-mocks --test tests/unit/strategy-agent.test.js
node --experimental-test-module-mocks --test tests/unit/execution-agent.test.js
node --experimental-test-module-mocks --test tests/unit/campaign-orchestrator.test.js
node --experimental-test-module-mocks --test tests/unit/aigc-service.test.js

# 全部单元测试
node --experimental-test-module-mocks --test tests/unit/{research,strategy,execution}-agent.test.js tests/unit/campaign-orchestrator.test.js tests/unit/aigc-service.test.js

# 集成测试（需要 .env.local 中的 API keys）
node tests/integration-meta-ads.mjs           # Meta 广告 API，~15s
node tests/integration-meta-ads.mjs --keep    # 保留创建的广告实体
node tests/integration-orchestrator.mjs       # 全流程，~5min
node tests/integration-orchestrator.mjs --keep # 保留 Meta 广告系列
```

### 环境变量依赖

| 变量 | 单元测试 | Meta 集成测试 | 全流程集成测试 |
|------|----------|--------------|--------------|
| `OPENROUTER_API_KEY` | - | - | 必需 |
| `META_SYSTEM_TOKEN` | - | 必需 | 必需 |
| `META_AD_ACCOUNT_ID` | - | 必需 | 必需 |
| `META_PAGE_ID` | - | 可选 | 可选 |
| `SERPAPI_KEY` | - | - | 可选 |
| `NEXT_PUBLIC_SUPABASE_URL` | - | - | 必需 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | - | - | 必需 |

---

## 一、Research Agent 单元测试

文件：`tests/unit/research-agent.test.js`（4 tests）

### 1.1 Claude tool_use 循环

| 用例 | 验证内容 |
|------|---------|
| 调用搜索工具后提交报告 | Claude 先调用 `search_meta_ad_library` + `search_google_trends`，拿到结果后调用 `submit_report` |
| 验证工具定义 | 首次调用包含 3 个工具：search_meta_ad_library, search_google_trends, submit_report |
| 验证工具结果回传 | 第二次调用的 messages 包含 `tool_result` 类型消息 |

### 1.2 外部 API 工具

| 用例 | 验证内容 |
|------|---------|
| fetchMetaAdLibrary — 正常返回 | 调用 Meta Ad Library API，返回 `{available: true, ads: [...]}` |
| fetchMetaAdLibrary — API 报错 | 返回 `{available: true, error: "..."}` 而不是抛异常 |
| fetchGoogleTrends — 正常返回 | 调用 SerpAPI，返回 `{available: true, trends: [...]}` |

---

## 二、Strategy Agent 单元测试

文件：`tests/unit/strategy-agent.test.js`（5 tests）

### 2.1 Claude tool_use 循环

| 用例 | 验证内容 |
|------|---------|
| 调用工具后提交方案 | Claude 调用 allocate_budget + generate_audience_segments，然后 submit_media_plan |
| 验证工具定义 | 包含 4 个工具：allocate_budget, generate_keywords, generate_audience_segments, submit_media_plan |
| 验证 prompt 包含 brief + research | messages 中同时包含 brief 数据和 MARKET RESEARCH REPORT |
| 无效方案被拒绝 | submit_media_plan 缺少 platforms → 抛出 "missing platforms" 错误 |

### 2.2 独立工具函数

| 用例 | 验证内容 |
|------|---------|
| allocateBudget — 按 fit score 分配 | meta(fit=9) 分配比例 > google(fit=3) |
| generateKeywords — 返回关键词组 | 包含 product, industry, geo_intent 等主题组 |
| generateAudienceSegments — 返回受众分群 | 至少 1 个 primary 优先级分群 |

---

## 三、Execution Agent 单元测试

文件：`tests/unit/execution-agent.test.js`（8 tests）

### 3.1 低级 Meta API 函数

| 用例 | 验证内容 |
|------|---------|
| uploadMedia | 调用 `/adimages`，返回 `image_hash` |
| createCampaign — 目标映射 | `lead_gen` → `OUTCOME_LEADS`，预算转换为分（×100） |
| createAdSet — targeting 构建 | countries 映射为 ISO，gender `male` → `[1]`，interests 构建 flexible_spec |
| createAd — 两步创建 | 先创建 adcreative，再创建 ad，CTA 映射正确（Send WhatsApp → WHATSAPP_MESSAGE） |

### 3.2 Claude tool_use 执行

| 用例 | 验证内容 |
|------|---------|
| executeMediaPlan — Claude 编排 | Claude 按顺序调用 meta_create_campaign → meta_create_adset → meta_create_ad → submit_execution_result |
| executeMediaPlan — 无 Meta 平台 | 返回 `{status: 'skipped'}` |

### 3.3 预览

| 用例 | 验证内容 |
|------|---------|
| previewExecution | 输出人类可读的方案预览，entity_counts 正确统计 |

---

## 四、Campaign Orchestrator 单元测试

文件：`tests/unit/campaign-orchestrator.test.js`（15 tests）

### 4.1 完整流水线

| 用例 | 验证内容 |
|------|---------|
| research → strategy → creative → 暂停 | 发出 3 个 phase_start，3 个 phase_complete，1 个 approval_required |
| 不发出 done 事件 | approval_required 后流结束，无 done |
| agent traces 写入 DB | orchestrator_messages 中有 `phase != null` 的 trace 消息 |
| approval 预览写入 DB | 有 `phase=null, role=assistant` 的用户可见消息 |
| session 状态更新 | running → awaiting_approval 状态变化记录在 sessionUpdates |

### 4.2 恢复

| 用例 | 验证内容 |
|------|---------|
| 跳过已完成阶段 | phase_results 有 research → 从 strategy 开始 |

### 4.3 审批后执行

| 用例 | 验证内容 |
|------|---------|
| 审批后跑 execution | 只有 1 个 phase_start(execution) + 1 个 done |
| 用户审批消息持久化 | orchestrator_messages 有"确认执行投放方案"用户消息 |
| 非 awaiting_approval 状态拒绝 | 返回 error 事件 |

### 4.4 用户对话

| 用例 | 验证内容 |
|------|---------|
| chatWithOrchestrator | 流式输出 delta + done，用户消息和 AI 回复都持久化到 `phase=null` |

### 4.5 错误处理

| 用例 | 验证内容 |
|------|---------|
| agent 抛异常 | 发出 phase_error 事件，session 状态设为 failed |

### 4.6 辅助函数

| 用例 | 验证内容 |
|------|---------|
| detectStartPhase — 空结果 | 返回 'research' |
| detectStartPhase — 部分完成 | 返回下一个未完成阶段 |
| summarizePhaseResult | research/strategy/execution 各有正确的摘要字段 |

---

## 五、AIGC Service 单元测试

文件：`tests/unit/aigc-service.test.js`（21 tests）

### 5.1 extractBase64Image

| 用例 | 验证内容 |
|------|---------|
| GPT-5 images[] format | 从 `message.images[0]` 提取 base64 |
| Gemini multimodal content[] | 从 `content[].image_url.url` 提取 |
| 无图片时返回 null | 空 images/content 都返回 null |

### 5.2 buildAdPrompt

| 用例 | 验证内容 |
|------|---------|
| 完整产品信息 | prompt 包含公司名、产品型号、规格、卖点、尺寸 |
| 空产品信息 | 优雅降级为"Our Company" |
| 限制卖点数量 | 最多 3 个 selling points |

### 5.3 saveGeneratedAsset

| 用例 | 验证内容 |
|------|---------|
| 保存图片 | 上传到 storage + 写入 aigc_assets 表，返回 id/url/storage_path |
| 记录 conversation_id | DB 中关联对话 ID |

---

## 六、Meta Ads 集成测试

文件：`tests/integration-meta-ads.mjs`（10 tests，~15 秒）

**直接调用真实 Meta Graph API，所有实体创建后自动清理。**

### 6.1 Campaign 创建

| 用例 | 目标 | 验证内容 |
|------|------|---------|
| TRAFFIC campaign | `OUTCOME_TRAFFIC` | 返回 campaign ID |
| LEADS campaign | `OUTCOME_LEADS` | 返回 campaign ID |
| AWARENESS campaign | `OUTCOME_AWARENESS` | 返回 campaign ID |

### 6.2 AdSet 创建

| 用例 | 场景 | 验证内容 |
|------|------|---------|
| 国家名 → ISO | `"Nigeria"` → `"NG"` | mapCountriesToISO 正确转换 |
| ISO 代码直传 | `"KE"` 不变 | 直接传递 |
| 多国家 | `["Nigeria","Kenya","Ghana"]` | 3 个国家都正确映射 |
| LEADS 降级 | 无 page_id 时 LEAD_GENERATION → LANDING_PAGE_VIEWS | 不报错，AdSet 创建成功 |
| 性别定向 | `female` → `genders: [2]` | Meta gender spec 正确 |
| 直接 age 字段 | `{age_min:30, age_max:50}` | 兼容非数组格式 |

### 6.3 预览

| 用例 | 验证内容 |
|------|---------|
| previewExecution | 输出包含 campaign 名称，entity 计数正确 |

### 6.4 Meta API 细节处理

本轮测试发现并修复的 Meta API 兼容性问题：

| 问题 | 原因 | 修复 |
|------|------|------|
| `targeting_automation.advantage_audience` 必填 | Meta 新版 API 要求 | buildMetaTargeting 自动加上 `{advantage_audience: 0}` |
| interests 需要数字 ID | `{name:"Automobiles"}` 不够 | 新增 `resolveInterestIds()` 通过 Search API 查 ID |
| campaign + adset 都设 daily_budget 冲突 | Meta 不允许两级预算 | adset daily_budget 改为可选 |
| LEAD_GENERATION 需要 promoted_object | 需要 Facebook Page ID | 无 page_id 时降级为 LANDING_PAGE_VIEWS |
| bid_amount 必填 | 广告账户级设置 | 默认 `bid_amount: 100` |

---

## 七、全流程集成测试

文件：`tests/integration-orchestrator.mjs`（~5 分钟）

**端到端：创建 brief → 调研 → 方案 → 执行 → 验证 DB。**

| 阶段 | 调用 | 验证内容 |
|------|------|---------|
| 0. 环境检查 | config | API keys 存在 |
| 1. 数据准备 | Supabase | brief + session 写入 DB |
| 2. Research | OpenRouter → Claude tool_use | 返回 market_overview, recommendations, platform_recommendations |
| 3. Strategy | OpenRouter → Claude tool_use | 返回含 Meta 平台的 MediaPlan，有 campaigns/ad_sets/ads |
| 4. Preview | previewExecution() | 人类可读的方案预览 |
| 5. Execution | Meta Graph API | Campaign 创建成功（PAUSED），AdSet 创建成功 |
| 6. DB 验证 | Supabase | session status=completed, phase_results 全部持久化 |

### 注意事项

- 使用 `--keep` 参数保留 Meta 广告实体和 DB 数据，方便到 Meta Ads Manager 验证
- 不使用 `--keep` 时自动清理所有创建的 Meta 实体
- Research 和 Strategy 阶段各需要 1-3 分钟（Claude tool_use 循环）
- Creative 阶段在集成测试中跳过（需要 AIGC 图片生成，较慢）
