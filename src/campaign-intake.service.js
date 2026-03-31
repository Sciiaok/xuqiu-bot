import { anthropic, MODELS } from './llm-client.js';
import { parseExcel, extractExcelContent } from './product-knowledge.service.js';
import {
  getBrief,
  updateBriefFields,
  updateCompletion,
  updateBrief,
  sanitizeBriefFields,
} from '../lib/repositories/campaign-brief.repository.js';
import {
  createSession,
  getLatestSession,
  getSession,
  addMessage,
  addMessages,
  getMessagesForClaude,
  getNextMessageIndex,
  attachmentsToContentBlocks,
  updateSession,
  updateSessionIfStatus,
} from '../lib/repositories/orchestrator.repository.js';
import { fetchAccountAssets } from './meta-account.service.js';
import { orchestrate } from './campaign-orchestrator.service.js';

// Core fields: must have these to proceed to orchestration
const CORE_FIELDS = [
  'company_name',
  'industry',
  'products',
  'target_countries',
  'budget_total',
  'budget_currency',
];

// Optional fields: nice-to-have, can be inferred by downstream agents
const OPTIONAL_FIELDS = [
  'target_audience',
  'campaign_duration_days',
  'objectives',
  'preferred_platforms',
  'competitors',
  'existing_landing_pages',
  'existing_creatives',
  'instructions',
];

const REQUIRED_FIELDS = [...CORE_FIELDS, ...OPTIONAL_FIELDS];

// ── Tool Definitions ────────────────────────────────────────────────────

export function getIntakeTools() {
  return [
    {
      name: 'update_brief',
      description:
        "Update the campaign brief with newly extracted fields from the conversation. Call this whenever you learn new information about the client's requirements. Returns current completion status. Set show_summary=true when the user explicitly asks to see the current brief status or a summary of collected info.",
      input_schema: {
        type: 'object',
        properties: {
          fields: {
            type: 'object',
            description:
              'Partial CampaignBrief fields to merge into the existing brief. products MUST be an array of objects [{model, category, key_specs, selling_points}], never a plain string.',
            properties: {
              products: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    model: { type: 'string' },
                    category: { type: 'string' },
                    key_specs: { type: 'object' },
                    selling_points: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['model'],
                },
                description: 'Product list. Each item must have at least a model name. NEVER pass a plain string.',
              },
            },
          },
          show_summary: {
            type: 'boolean',
            description: 'Set to true to display the brief summary card to the user (only when user asks to see current status)',
          },
        },
        required: ['fields'],
      },
    },
    {
      name: 'save_brief',
      description:
        'Save the brief and mark the session as complete. Call this when: (1) core_complete=true and user confirms to proceed, OR (2) all fields are filled, OR (3) user explicitly says to skip. Minimum: company_name + industry. Prefer saving early once core fields are ready — optional fields can be inferred by downstream agents.',
      input_schema: {
        type: 'object',
        properties: {
          brief: {
            type: 'object',
            description: 'The complete CampaignBrief to save',
          },
        },
        required: ['brief'],
      },
    },
    {
      name: 'parse_attachment',
      description:
        'Parse an uploaded document (PDF or XLSX) to extract product information such as specs, pricing, and company info. Only call this for PDF/XLSX files — images are already visible to you directly.',
      input_schema: {
        type: 'object',
        properties: {
          attachment_url: { type: 'string', description: 'Public URL of the uploaded file' },
          type: { type: 'string', enum: ['pdf', 'xlsx'], description: 'File format' },
        },
        required: ['attachment_url', 'type'],
      },
    },
    {
      name: 'web_search',
      description:
        '联网搜索信息。当用户要求搜索竞品、市场数据、行业资讯，或你需要主动调研公司官网和产品页时调用。返回搜索摘要和候选链接。',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_webpage',
      description:
        '读取指定网页内容。当用户提供了网址，或你已通过搜索拿到官网/产品页 URL 并需要阅读正文时调用。返回网页标题和正文摘要。',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要读取的网页 URL' },
        },
        required: ['url'],
      },
    },
  ];
}

// ── System Prompt ───────────────────────────────────────────────────────

export function buildIntakeSystemPrompt() {
  return `你是一位专业的投放需求顾问（Campaign Requirements Consultant），帮助客户定义数字广告投放需求。

═══ 你的职责（严格边界）═══
你的**核心任务**是收集客户的广告投放需求，形成 Campaign Brief，然后调用 save_brief 交接给下游 Agent。

**你可以做的事情：**
- ✅ 用 web_search / read_webpage 调研与 brief 字段直接相关的事实信息
- ✅ 基于调研结果给出简短的事实性建议帮助用户做决策

**你不能做的事情：**
- ❌ 输出完整投放策略、媒体方案、预算分配方案
- ❌ 生成广告素材、创意文案
- ❌ 制定排期计划、A/B 测试方案
- ❌ 输出账户结构、受众定向详细设置

═══ 搜索调研原则（重要！）═══
搜索能力必须服务于你的核心职责——填充 brief 字段。遵循以下优先级：

1. **优先回答核心问题**：如果还有未确认的核心字段，先要求用户回答，不要被调研请求带偏
2. **搜索结果要落地到字段**：每次搜索后，必须将结果提炼为具体的 brief 字段值（如搜索海关数据 → 得出 target_countries 建议），用 update_brief 保存
3. **不做发散性研究**：如果用户的调研请求与 brief 字段无关（如"帮我分析整个东南亚汽车市场格局"），简短回应"这部分会在方案规划阶段由策略 Agent 深入分析"，然后拉回核心问题
4. **搜索后立即收敛**：搜索完成后，立即将结论用于填充字段或向用户确认，然后继续追问剩余的核心问题。不要在搜索话题上展开过多讨论

示例：
- 用户："调研一下哪些国家出口中国汽车多" → 搜索 → "根据数据，泰国和印尼是前两大市场。建议 target_countries 设为泰国、印尼。您确认吗？另外还需要确认：您的月预算大概是多少？"
- 用户："帮我做一份竞品分析报告" → "详细竞品分析会在方案规划阶段完成。目前我先记录主要竞品名称就好——您知道在目标市场的主要竞争对手有哪些吗？"

═══ CampaignBrief 字段说明（6 大类） ═══

**1. 市场与业务目标 (Market & Business Objectives)**
- company_name: 公司名称
- industry: 所属行业
- target_countries: 目标投放国家/地区（具体到国家或城市群）
- objectives: 投放目标（品牌认知 Brand Awareness / 销量转化 Conversion / 线索获取 Lead Generation）
- kpi_targets: 期望的具体 KPI 指标（如 CPL、CPC、品牌搜索指数增幅）

**2. 产品与定价策略 (Product & Pricing)**
- products: 推广的产品或服务（含型号、核心卖点 USP、对标竞品）
- product_pricing: 产品定价及细分市场定位

**3. 目标受众画像 (Audience Profiling)**
- target_audience: 目标受众描述（年龄、性别、职业、收入、行为特征、触媒习惯）

**4. 竞争环境与差异化 (Competitive Landscape)**
- competitors: 主要竞争对手及其在目标市场的现状
- differentiation: 品牌差异化策略/破局点

**5. 现有数字资产与资源 (Digital Assets & Resources)**
- existing_landing_pages: 已有的落地页/官网（是否本地化、是否有询价表单）
- existing_creatives: 已有的广告素材（TVC、产品图、视频等）
- website: 公司官网
- crm_system: CRM 系统（如 Salesforce、HubSpot）

**6. 预算与合规 (Budget & Compliance)**
- budget_total: 总预算金额
- budget_currency: 预算货币（如 USD、CNY）
- campaign_duration_days: 投放周期（天数）
- preferred_platforms: 偏好投放平台（如 Google Ads、Meta、TikTok、LinkedIn）
- compliance_notes: 当地法律合规要求（如 GDPR、广告法限制、油耗披露标准）

**7. 特殊指令 (Special Instructions)**
- instructions: 用户提出的特殊要求或偏好，无法归入上述标准字段的内容（如"希望突出越野性能"、"需要阿拉伯语素材"）。下游 Agent 会读取此字段。

═══ 主动调研策略（最重要！）═══
当用户提到公司名或品牌名时，你必须立即主动行动：
1. 调用 web_search 搜索「{company_name} official website」和「{company_name} {industry} products」
2. 从搜索结果中确认官网 URL、产品页、行业定位和目标市场线索；必要时调用 read_webpage 阅读具体页面
3. 从搜索结果和网页内容中自动提取并推理以下字段：
   - industry（从官网描述推断）
   - products（从产品页提取型号、品类、卖点）
   - website（官网 URL）
   - competitors（搜索同行业竞品）
   - target_countries（如果官网有多语言版本或提到出口市场）
4. 把推理出的信息用 update_brief 保存，同时在回复中清晰展示你发现了什么，**并标注每条信息的来源和置信度**
5. 基于调研结果，推理用户可能的投放目标（如 B2B 机械企业 → Lead Generation，跨境电商 → Conversion）

═══ 客户身份推理（重要！）═══
在收集信息的同时，你必须主动推理客户的商业角色，因为它直接影响投放策略：
- **品牌方 (Brand Owner)**：如比亚迪、华为 → 品牌建设 + 线索获取，预算通常较高
- **经销商/代理商 (Distributor/Dealer)**：代理某品牌在特定市场 → 侧重本地化获客、到店/询盘
- **跨境 DTC 卖家 (Cross-border DTC)**：自有品牌直接面向海外消费者 → 侧重 ROAS、转化率

推理依据：
- 提到大品牌名（如"比亚迪"）但预算较低（如 $500/月）→ 可能是经销商，而非品牌方总部
- 有独立站/Shopify → 更可能是 DTC 卖家
- 提到"招商"、"代理" → 经销商招募场景

**客户身份属于中置信度推理，必须确认。** 将推理结果保存到 brief 的 client_role 字段（brand_owner / distributor / dtc_seller）。

═══ 信息确认策略（必须遵守）═══
对于每条核心字段信息，你需要评估其置信度：
- **高置信度**：用户直接说出、或从官网产品页明确提取（如公司名、具体产品型号）→ 直接保存，简短告知用户
- **中/低置信度**：通过推理或间接来源获得（如从官网语言版本推断目标市场、从行业推断投放目标、客户商业角色推理）→ **必须明确向用户确认后再保存**

确认方式示例：
- "您提到方程豹7，月预算 $500 — 请问您是比亚迪方程豹的**品牌方团队**还是某个市场的**授权经销商**？这会影响我们的投放策略方向。"
- "根据官网信息，贵公司主要产品为 XX 和 YY。请问这些信息准确吗？"

**绝不要把不确定的推理结果直接写入 brief 后跳过确认。**

═══ 智能追问策略 ═══
不要机械地按清单逐项提问。根据已知信息进行推理和关联追问：
- 已知行业 + 产品 → 推理目标受众画像，询问用户确认
- 已知目标国家 → 推荐平台组合（如中东 → Meta + Google，东南亚 → Meta + TikTok）
- 已知预算 + 周期 → 评估是否合理，给出专业建议
- 已知竞品 → 分析差异化策略，引导用户思考破局点
- 如果用户只给了模糊描述（如"做外贸的"），追问具体品类和目标市场

每次回复最多追问 2-3 个最关键的缺失信息，优先问能触发更多推理的字段（如 company_name → 可以推理出一半的字段）。

═══ 对话策略 ═══
1. 每次获取到新信息时，立即调用 update_brief 保存
2. update_brief 返回值中包含 core_complete 字段。**当 core_complete=true 时**，不要直接 save_brief，而是先询问用户是否需要补充可选信息。回复模板：

"核心需求已收集完毕！在进入方案规划之前，您还可以补充以下信息，它们能显著提升后续市场调研、策略规划和素材生成的质量：
- **目标受众画像**：年龄、职业、决策角色等（帮助精准定向）
- **竞品信息**：主要竞争对手（帮助差异化分析和素材创意）
- **现有素材/落地页**：已有的产品图、官网链接（帮助生成更贴合品牌的广告素材）
- **偏好投放平台**：如 Meta、Google、TikTok（帮助制定平台策略）

如果暂时没有需要补充的，我们可以直接开始。"

3. 如果用户回复"直接开始"、"不需要"、"没有了"等，立即调用 save_brief
4. 如果用户补充了信息，update_brief 保存后再次确认是否还需补充，或直接 save_brief
5. 如果用户的第一条消息就包含了足够的核心信息（公司名、产品、目标市场、预算），在一次 web_search 调研后 update_brief，然后仍然按上述模板询问是否补充可选信息
6. 如果用户说"继续"、"下一步"等推进性指令，只要 company_name 和 industry 已填，立即 save_brief
7. 当用户要求做策划、生成素材、制定排期等下游工作时，先完成 save_brief，然后简短回复"需求已保存，系统即将自动启动方案规划"
8. 你有联网搜索和网页读取能力。用于调研公司和产品信息补充 brief 字段，不要用于输出策略分析
9. 每条回复控制在200字以内。你的目标是高效收集信息并交接，不是展示专业知识

═══ 重要：关于系统状态 ═══
- save_brief 成功后，系统会**自动**启动方案规划流程，你无需做任何额外操作
- 不要说"请稍候"、"正在生成"等暗示你在等待结果的话——你的任务在 save_brief 后就结束了
- 如果 save_brief 后用户继续发消息，简短回复"需求已保存，方案正在自动生成中"即可

═══ 回复要求 ═══
- 每条回复控制在200字以内，简洁直接
- 用中文回复
- 只围绕 brief 字段追问，不输出分析、建议、方案
- 对推理出的信息标注来源，低置信度的必须确认`;
}

// ── SSE Filtering ───────────────────────────────────────────────────────

function shouldEmit(eventType, streamLevel) {
  if (streamLevel === 'full') return true;
  if (streamLevel === 'events') return eventType !== 'thinking';
  // streamLevel === 'text'
  return (
    eventType === 'delta' ||
    eventType === 'done' ||
    eventType === 'error' ||
    eventType === 'brief_update'
  );
}

// ── Tool Execution ──────────────────────────────────────────────────────

async function executeUpdateBrief(briefId, input) {
  const current = await getBrief(briefId);
  const sanitized = sanitizeBriefFields(input.fields, current?.brief);
  const updated = await updateBriefFields(briefId, sanitized);
  const briefData = updated.brief || {};

  const filled = REQUIRED_FIELDS.filter((f) => {
    const val = briefData[f];
    if (val === undefined || val === null || val === '') return false;
    if (Array.isArray(val) && val.length === 0) return false;
    return true;
  });
  const missing = REQUIRED_FIELDS.filter((f) => !filled.includes(f));
  const completion_pct = Math.round((filled.length / REQUIRED_FIELDS.length) * 100);
  const is_complete = missing.length === 0;

  const coreFilled = CORE_FIELDS.filter(f => filled.includes(f));
  const coreMissing = CORE_FIELDS.filter(f => !filled.includes(f));
  const core_complete = coreMissing.length === 0;

  const completion = { filled, missing, completion_pct, core_complete };
  await updateCompletion(briefId, completion);

  return {
    brief: briefData,
    is_complete,
    core_complete,
    filled,
    missing,
    core_missing: coreMissing,
    optional_missing: OPTIONAL_FIELDS.filter(f => !filled.includes(f)),
    completion_pct,
  };
}

async function executeSaveBrief(briefId, input) {
  // Only update status — brief data is already collected via update_brief.
  // Do NOT overwrite brief with input.brief (LLM may send incomplete/garbage data).
  await updateBrief(briefId, { status: 'completed' });
  return { saved: true, brief_id: briefId };
}

async function executeParseAttachment(_briefId, input) {
  const { attachment_url, type } = input;
  try {
    const res = await fetch(attachment_url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    if (type === 'xlsx') {
      const rawText = parseExcel(buffer);
      const extracted = await extractExcelContent(rawText);
      return {
        company_info: extracted.company_info || null,
        product_intro: extracted.product_intro || null,
        selling_points: extracted.selling_points || null,
        features: extracted.features || null,
        notes: extracted.notes || null,
        raw_specs: extracted.raw_specs || null,
      };
    }

    if (type === 'pdf') {
      // Dynamic import to avoid loading Java dependency at module level
      const { convert } = await import('@opendataloader/pdf');
      const { writeFile, readFile, mkdtemp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { readdirSync } = await import('node:fs');

      const tempDir = await mkdtemp(join(tmpdir(), 'intake-pdf-'));
      const inputPath = join(tempDir, 'input.pdf');
      const outputDir = join(tempDir, 'output');

      try {
        await writeFile(inputPath, buffer);
        await convert([inputPath], { outputDir, format: 'markdown' });
        const mdFile = readdirSync(outputDir).find(f => f.endsWith('.md'));
        const markdown = mdFile
          ? await readFile(join(outputDir, mdFile), 'utf-8')
          : '';
        // Return first 6000 chars to fit in tool result
        return { extracted_text: markdown.slice(0, 6000) };
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    return { error: `Unsupported type: ${type}` };
  } catch (err) {
    console.error('[executeParseAttachment]', err);
    return { error: `Parse failed: ${err.message}` };
  }
}

function extractTextBlocks(content = []) {
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function stripCodeFence(text = '') {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function tryParseJson(text = '') {
  if (!text) return null;
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
}

function extractUrls(text = '') {
  const matches = text.match(/https?:\/\/[^\s<>()"]+/g) || [];
  return [...new Set(matches)];
}

function extractNativeSearchResults(content = []) {
  const results = [];

  for (const block of content) {
    if (block?.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const item of block.content) {
      if (item?.type !== 'web_search_result' || !item.url) continue;
      results.push({
        title: item.title || item.url,
        url: item.url,
      });
    }
  }

  return results.filter((item, index, arr) => arr.findIndex((x) => x.url === item.url) === index);
}

function extractNativeFetchDocument(content = []) {
  for (const block of content) {
    if (block?.type !== 'web_fetch_tool_result') continue;
    const result = block.content;
    if (result?.type !== 'web_fetch_result') continue;
    const doc = result.content;
    const source = doc?.source;
    const data = source?.type === 'text' ? source.data : '';

    return {
      url: result.url,
      title: doc?.title || null,
      content: typeof data === 'string' ? data : '',
    };
  }

  return null;
}

async function executeWebSearch(_briefId, input) {
  try {
    const response = await anthropic.messages.create({
      model: MODELS.SONNET,
      max_tokens: 900,
      messages: [
        {
          role: 'user',
          content:
            `你必须使用 web_search 搜索这个查询：${input.query}\n` +
            '返回一个 JSON 对象，且只返回 JSON，不要写额外说明。格式：' +
            '{"query":"原查询","summary":"200字内中文摘要","results":[{"title":"标题","url":"https://..."}]}\n' +
            'results 最多 5 条，优先保留官网、产品页、权威资料链接。',
        },
      ],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    });

    const text = extractTextBlocks(response.content);
    const parsed = tryParseJson(text);
    const nativeResults = extractNativeSearchResults(response.content);
    const parsedResults = Array.isArray(parsed?.results)
      ? parsed.results
        .filter((item) => item?.url)
        .map((item) => ({ title: item.title || item.url, url: item.url }))
      : [];
    const mergedResults = [...nativeResults, ...parsedResults]
      .filter((item, index, arr) => arr.findIndex((x) => x.url === item.url) === index)
      .slice(0, 5);

    return {
      query: input.query,
      summary: (parsed?.summary || text || '').slice(0, 2000),
      results: mergedResults.length ? mergedResults : extractUrls(text).slice(0, 5).map((url) => ({ title: url, url })),
    };
  } catch (err) {
    return { error: `Search error: ${err.message}`, results: [] };
  }
}

async function executeReadWebpage(_briefId, input) {
  try {
    const hostname = new URL(input.url).hostname;
    const response = await anthropic.messages.create({
      model: MODELS.SONNET,
      max_tokens: 1400,
      messages: [
        {
          role: 'user',
          content:
            `你必须使用 web_fetch 读取这个网页：${input.url}\n` +
            '返回一个 JSON 对象，且只返回 JSON，不要写额外说明。格式：' +
            '{"url":"页面URL","title":"页面标题","content":"保留关键信息的正文摘要，最多3000字"}',
        },
      ],
      tools: [{
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: 1,
        allowed_domains: [hostname],
        max_content_tokens: 12000,
      }],
    });

    const text = extractTextBlocks(response.content);
    const parsed = tryParseJson(text);
    const nativeDoc = extractNativeFetchDocument(response.content);

    return {
      url: parsed?.url || nativeDoc?.url || input.url,
      title: parsed?.title || nativeDoc?.title || null,
      content: (parsed?.content || nativeDoc?.content || text || '').slice(0, 6000),
    };
  } catch (err) {
    return { error: `Read error: ${err.message}`, content: '' };
  }
}

async function executeTool(briefId, toolName, toolInput) {
  switch (toolName) {
    case 'update_brief':
      return executeUpdateBrief(briefId, toolInput);
    case 'save_brief':
      return executeSaveBrief(briefId, toolInput);
    case 'parse_attachment':
      return executeParseAttachment(briefId, toolInput);
    case 'web_search':
      return executeWebSearch(briefId, toolInput);
    case 'read_webpage':
      return executeReadWebpage(briefId, toolInput);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Main Entry Point ────────────────────────────────────────────────────

export async function* processIntakeMessage(
  briefId,
  message,
  { streamLevel = 'events', attachments } = {},
) {
  let sessionId = null;
  try {
    // 1. Load brief from DB
    const brief = await getBrief(briefId);
    if (!brief) {
      yield { event: 'error', data: { message: `Brief ${briefId} not found` } };
      return;
    }

    // 2. Resolve orchestrator session (create if not exists)
    let session = await getLatestSession(briefId);
    if (!session) {
      session = await createSession(briefId, { status: 'intake', current_phase: 'intake' });
    }
    sessionId = session.id;
    // Only reset to intake if session hasn't progressed beyond intake
    // (don't regress brief_completed/running/completed back to intake)
    const INTAKE_COMPATIBLE = ['intake'];
    if (!INTAKE_COMPATIBLE.includes(session.status)) {
      // Session is past intake — this call will be handled by chatWithOrchestrator, not here
      // but if we're here anyway, don't regress the status
    } else if (session.current_phase !== 'intake') {
      session = await updateSession(sessionId, { current_phase: 'intake' });
    }

    // 2b. Fetch Meta account assets in background (non-blocking)
    // Results are persisted to session.phase_results.meta_assets so all downstream phases can use them.
    const metaAssetsPromise = (async () => {
      // Skip if already fetched in a previous intake turn
      const current = await getSession(sessionId);
      if (current?.phase_results?.meta_assets?.available !== undefined) return;
      try {
        const assets = await fetchAccountAssets();
        assets.fetched_at = new Date().toISOString();
        const latest = await getSession(sessionId);
        const results = { ...(latest?.phase_results || {}), meta_assets: assets };
        await updateSession(sessionId, { phase_results: results });
        console.log(`[intake] session=${sessionId} meta_assets fetched: pages=${assets.pages?.length || 0} wa=${assets.whatsapp_phone_numbers?.length || 0}`);
      } catch (err) {
        console.warn(`[intake] session=${sessionId} meta_assets fetch failed:`, err.message);
      }
    })();

    // 3. Load history
    const history = await getMessagesForClaude(sessionId, { phase: 'intake' });

    // 4. Get next message_index
    let messageIndex = await getNextMessageIndex(sessionId);

    // 5. Store user message in DB
    await addMessage(sessionId, {
      phase: 'intake',
      role: 'user',
      content: message,
      message_index: messageIndex++,
      attachments: attachments?.length ? attachments : undefined,
    });

    // 5a. Persist uploaded image URLs to brief.product_images
    if (attachments?.length) {
      const newImages = attachments
        .filter(a => a.content_type?.startsWith('image/'))
        .map(a => ({ url: a.url, filename: a.filename }));
      if (newImages.length) {
        const existing = brief.brief?.product_images || [];
        const existingUrls = new Set(existing.map(img => img.url));
        const deduped = newImages.filter(img => !existingUrls.has(img.url));
        if (deduped.length) await updateBriefFields(briefId, {
          product_images: [...existing, ...deduped],
        });
      }
    }

    // 5b. Build Claude request messages (multimodal if attachments exist)
    let userContent;
    if (attachments?.length) {
      const imageAttachments = attachments.filter(a => a.content_type?.startsWith('image/'));
      const docAttachments = attachments.filter(a => !a.content_type?.startsWith('image/'));

      const imageBlocks = await attachmentsToContentBlocks(imageAttachments);

      // For document attachments, add text hints so Claude calls parse_attachment
      const docHints = docAttachments.map(a => {
        const ext = a.filename?.endsWith('.xlsx') ? 'xlsx' : 'pdf';
        return `[User uploaded file: ${a.filename} (${ext}), url: ${a.url}] — please use parse_attachment to extract content.`;
      });

      const textPart = [...docHints, message].filter(Boolean).join('\n');
      userContent = [
        ...imageBlocks,
        ...(textPart ? [{ type: 'text', text: textPart }] : []),
      ];
    } else {
      userContent = message;
    }

    const messages = [
      ...history,
      { role: 'user', content: userContent },
    ];

    // 6. Process streaming response with tool-use loop
    const tools = getIntakeTools();
    const systemPrompt = buildIntakeSystemPrompt();
    let iterations = 0;
    const maxIterations = 12;
    let latestBrief = brief.brief || {};
    let latestCompletion = brief.completion || {};
    let briefCompleted = false;
    let userRequestedSummary = false;

    async function persistStreamTurn(assistantText, toolUseBlocks) {
      const rows = [];
      if (assistantText) {
        rows.push({
          phase: 'intake',
          role: 'assistant',
          content: assistantText,
          message_index: messageIndex++,
        });
      }
      for (const block of toolUseBlocks) {
        rows.push({
          phase: 'intake',
          role: 'assistant',
          content: null,
          tool_use_id: block.id,
          tool_name: block.name,
          tool_input: block.input,
          message_index: messageIndex++,
        });
        rows.push({
          phase: 'intake',
          role: 'tool',
          content: null,
          tool_use_id: block.id,
          tool_result: block.result,
          message_index: messageIndex++,
        });
      }
      if (rows.length > 0) {
        await addMessages(sessionId, rows);
      }
    }

    while (iterations < maxIterations) {
      iterations++;
      console.log(`[intake] session=${sessionId} iter=${iterations}/${maxIterations} messages=${messages.length}`);

      const stream = anthropic.messages.stream({
        model: MODELS.SONNET,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools,
      });

      // Track content blocks and cached tool results for this stream response
      const toolUseBlocks = []; // { id, name, input, result }
      let currentBlockType = null;
      let currentToolInput = '';
      let currentToolName = '';
      let currentToolUseId = '';
      let assistantText = '';

      let finalMessage;
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              currentBlockType = 'tool_use';
              currentToolName = block.name;
              currentToolUseId = block.id;
              currentToolInput = '';
              // Immediately notify frontend that a tool call is starting
              if (shouldEmit('tool_call', streamLevel)) {
                yield {
                  event: 'tool_start',
                  data: { tool: currentToolName },
                };
              }
            } else if (block.type === 'text') {
              currentBlockType = 'text';
            } else if (block.type === 'thinking') {
              currentBlockType = 'thinking';
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              assistantText += delta.text;
              if (shouldEmit('delta', streamLevel)) {
                yield { event: 'delta', data: { text: delta.text } };
              }
            } else if (delta.type === 'thinking_delta') {
              if (shouldEmit('thinking', streamLevel)) {
                yield { event: 'thinking', data: { text: delta.thinking } };
              }
            } else if (delta.type === 'input_json_delta') {
              currentToolInput += delta.partial_json;
            }
          } else if (event.type === 'content_block_stop') {
            if (currentBlockType === 'tool_use') {
              let parsedInput = {};
              try {
                parsedInput = JSON.parse(currentToolInput);
              } catch {
                // empty or malformed input
              }

              if (shouldEmit('tool_call', streamLevel)) {
                yield {
                  event: 'tool_call',
                  data: {
                    tool: currentToolName,
                    tool_use_id: currentToolUseId,
                    input: parsedInput,
                  },
                };
              }

              const toolStart = Date.now();
              const toolResult = await executeTool(
                briefId,
                currentToolName,
                parsedInput,
              );
              console.log(`[intake] session=${sessionId} tool=${currentToolName} ${Date.now() - toolStart}ms${toolResult.error ? ' ERROR=' + toolResult.error : ''}`);

              toolUseBlocks.push({
                id: currentToolUseId,
                name: currentToolName,
                input: parsedInput,
                result: toolResult,
              });

              if (shouldEmit('tool_result', streamLevel)) {
                yield {
                  event: 'tool_result',
                  data: {
                    tool: currentToolName,
                    tool_use_id: currentToolUseId,
                    result: toolResult,
                  },
                };
              }

              if (currentToolName === 'update_brief' && toolResult.brief) {
                latestBrief = toolResult.brief;
                latestCompletion = {
                  filled: toolResult.filled,
                  missing: toolResult.missing,
                  completion_pct: toolResult.completion_pct,
                };
                if (parsedInput.show_summary) {
                  userRequestedSummary = true;
                }
              }
              if (currentToolName === 'save_brief') {
                briefCompleted = true;
                // Atomic: only promote intake → brief_completed
                await updateSessionIfStatus(sessionId, 'intake', { status: 'brief_completed' });
              }
            }
            currentBlockType = null;
          }
        }

        finalMessage = await stream.finalMessage();
      } catch (streamErr) {
        console.error(`[intake] session=${sessionId} iter=${iterations} stream error:`, streamErr.message, `assistantText=${assistantText.length}chars tools=${toolUseBlocks.map(t => t.name).join(',') || 'none'}`);

        // Retry once with fallback stream (MixAI → Anthropic direct)
        if (stream._fallbackStream && assistantText.length === 0 && toolUseBlocks.length === 0) {
          console.warn(`[intake] session=${sessionId} retrying with fallback stream`);
          const fallbackStream = stream._fallbackStream();
          try {
            for await (const event of fallbackStream) {
              if (event.type === 'content_block_start') {
                const block = event.content_block;
                if (block.type === 'tool_use') {
                  currentBlockType = 'tool_use';
                  currentToolName = block.name;
                  currentToolUseId = block.id;
                  currentToolInput = '';
                } else if (block.type === 'text') {
                  currentBlockType = 'text';
                }
              } else if (event.type === 'content_block_delta') {
                const delta = event.delta;
                if (delta.type === 'text_delta') {
                  assistantText += delta.text;
                  yield { type: 'delta', data: delta.text };
                } else if (delta.type === 'input_json_delta') {
                  currentToolInput += delta.partial_json;
                }
              } else if (event.type === 'content_block_stop') {
                if (currentBlockType === 'tool_use') {
                  let parsedInput;
                  try { parsedInput = JSON.parse(currentToolInput); } catch { parsedInput = {}; }
                  const toolResult = await executeTool(briefId, currentToolName, parsedInput);
                  toolUseBlocks.push({ id: currentToolUseId, name: currentToolName, input: parsedInput, result: toolResult });
                  if (currentToolName === 'update_brief' && toolResult && !toolResult.error) {
                    yield { type: 'brief_update', data: toolResult };
                  }
                }
                currentBlockType = null;
              }
            }
            finalMessage = await fallbackStream.finalMessage();
            // Skip the throw — fallback succeeded
          } catch (fallbackErr) {
            console.error(`[intake] session=${sessionId} fallback also failed:`, fallbackErr.message);
            await persistStreamTurn(assistantText, toolUseBlocks);
            throw fallbackErr;
          }
        } else {
          await persistStreamTurn(assistantText, toolUseBlocks);
          throw streamErr;
        }
      }

      const stopReason = finalMessage.stop_reason;
      const hasToolUse = toolUseBlocks.length > 0;
      console.log(`[intake] session=${sessionId} iter=${iterations} stop_reason=${stopReason} tools=${toolUseBlocks.map(t => t.name).join(',') || 'none'} textLen=${assistantText.length}`);
      await persistStreamTurn(assistantText, toolUseBlocks);

      // If Claude stopped due to tool_use, feed cached results back and continue
      if (stopReason === 'tool_use' && hasToolUse) {
        // Build assistant content for the next turn
        const assistantContent = [];
        if (assistantText) {
          assistantContent.push({ type: 'text', text: assistantText });
        }
        for (const block of toolUseBlocks) {
          assistantContent.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
        messages.push({ role: 'assistant', content: assistantContent });

        // Build tool results for the next turn (using cached results)
        const toolResultContent = toolUseBlocks.map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(block.result),
        }));
        messages.push({ role: 'user', content: toolResultContent });

        // Reset for next iteration
        assistantText = '';
        continue;
      }

      // No more tool calls — we're done
      console.log(`[intake] session=${sessionId} loop done after ${iterations} iterations, finalTextLen=${assistantText.length}`);
      break;
    }

    if (iterations >= maxIterations) {
      console.warn(`[intake] session=${sessionId} hit maxIterations=${maxIterations}`);
    }

    // Status update: atomic promote only (intake → brief_completed), never demote
    if (briefCompleted) {
      await updateSessionIfStatus(sessionId, 'intake', { status: 'brief_completed', current_phase: 'intake' });
    }
    // If not briefCompleted, leave status unchanged (don't regress brief_completed → intake)

    // Yield brief update
    if (shouldEmit('brief_update', streamLevel)) {
      yield {
        event: 'brief_update',
        data: {
          brief: latestBrief,
          completion: latestCompletion,
          show_card: briefCompleted || userRequestedSummary,
        },
      };
    }

    // Check if orchestration should start (this turn or a previous turn completed the brief)
    const finalSession = await getSession(sessionId);
    const shouldOrchestrate = briefCompleted || finalSession?.status === 'brief_completed';

    if (shouldOrchestrate) {
      // Chain directly into orchestration — no frontend round-trip needed
      yield { event: 'done', data: { brief_id: briefId, status: 'completed' } };
      yield* orchestrate(sessionId);
    } else {
      yield { event: 'done', data: { brief_id: briefId, status: 'collecting' } };
    }
  } catch (err) {
    console.error(`[intake] session=${sessionId} fatal error:`, err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
    yield {
      event: 'error',
      data: { message: err.message || 'Unknown error' },
    };
  }
}
