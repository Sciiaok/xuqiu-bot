// ══════════════════════════════════════════════════════════════════════
// OpenAI 直连价目表 —— 手动维护的静态常量
// ══════════════════════════════════════════════════════════════════════
//
// 这段是 llm-pricing.js 里唯一**必须手维护**的部分,专门给图片生成兜底
// (OpenAI 不在 response 里返回 cost,只给 token 数 / 图片张数;OpenRouter
// 的 usage.cost 不一定在所有 provider 路径上返回)。
//
// OpenAI 涨/降价时 → 改下面的数字 + commit。
//
// 校准来源:
//   - gpt-image-2:   https://openai.com/api/pricing/ (Image generation 段)
// 价表 last verified: 2026-05-18

/** Flat fallback,USD / 张图。仅在 response.usage.cost 缺失时兜底。
 *  1024×1024 high quality 实测均值。usage 正常返回时不走这条。 */
export const OPENAI_GPT_IMAGE_2_FLAT_USD_PER_IMAGE = 0.21;

/** gpt-image-1 (已下线),USD / 张图。留 key 兜底历史 aigc_assets 行的成本回看。 */
export const OPENAI_GPT_IMAGE_1_FLAT_USD_PER_IMAGE = 0.17;

// ══════════════════════════════════════════════════════════════════════
// 下方价表 = OpenRouter 路径的 fallback (正常情况下 usage.cost 直接落表)
// ══════════════════════════════════════════════════════════════════════
//
// LLM 模型定价表 —— 单位 USD per 1K tokens
//
// **重要变更(2026-05-18)**: 这张表现在是 *fallback only*。常规路径下,llm-client
// 走 `usage: { include: true }` 让 OpenRouter 在 response.usage.cost 里返回它实
// 际向账户扣的费,直接落表(=控制台 Spend By Model 完全一致)。这张价表只在
// 以下场景触发:
//   - OpenRouter 没返 usage.cost(老 provider / 缓存层 bug / 错误返回)
//   - OpenAI 直连(Whisper / gpt-image-2)拿不到 usage.cost
// 看 admin/llm-usage 日志里 cost_source='local-pricing-table' 的比例,正常应在
// 个位数百分比内;持续高的话查 OpenRouter 健康状况。
//
// 维护说明: 模型上线/调价时**仍要更**,但不再是关键路径。校准方式见 README:
//   1. curl https://openrouter.ai/api/v1/models | jq '.data[] | select(.id=="X") | .pricing'
//   2. OpenRouter 的 pricing 是 per-token 单位,乘 1000 转成 per-1K-tokens 写进来
//
// Anthropic prompt caching 三段计费(OpenRouter 透传 Anthropic 字段):
//   - 常规 prompt_tokens          : input 价
//   - cache_creation_input_tokens : input × 1.25 (写入 cache, 5min TTL)
//   - cache_read_input_tokens     : input × 0.10 (命中 cache)

// 注意:请求方 model 字符串和 OpenRouter 返回的 model 字符串可能不一样。
// 比如请求 'anthropic/claude-haiku-4.5',返回的是 'anthropic/claude-4.5-haiku-20251001'。
// 价表两种 key 都得覆盖,否则 cost 会被错算成 0。
//
// 校准来源(2026-05-18): OpenRouter /api/v1/models
const PRICES = {
  // Anthropic —— 请求方 key
  'anthropic/claude-sonnet-4.6':           { input: 0.003,   output: 0.015   },
  'anthropic/claude-haiku-4.5':            { input: 0.001,   output: 0.005   },
  // Anthropic —— OpenRouter 实际返回的 key(数字在前 + 日期后缀)
  'anthropic/claude-4.6-sonnet':           { input: 0.003,   output: 0.015   },
  'anthropic/claude-4.5-haiku':            { input: 0.001,   output: 0.005   },

  // OpenAI
  'openai/gpt-5.4':                        { input: 0.0025,  output: 0.015   },
  'openai/gpt-5.4-mini':                   { input: 0.00075, output: 0.0045  },
  'openai/gpt-5.4-nano':                   { input: 0.0002,  output: 0.00125 },

  // MiniMax
  'minimax/minimax-m2.7':                  { input: 0.000279, output: 0.0012 },

  // Embeddings (OpenAI via OpenRouter or direct)
  'text-embedding-3-small':                { input: 0.00002, output: 0       },

  // Audio transcription (WhatsApp 语音 → 文字)。Gemini 2.5 Flash Lite,极便宜
  // 且 verbatim 行为稳定。OR 实测 usage.cost 总会返回,这里只是兜底。
  'google/gemini-2.5-flash-lite':          { input: 0.0001,  output: 0.0004  },
};

const UNKNOWN = { input: 0, output: 0 };

// 图片生成模型按 "每张" 计费的 fallback 兜底表。Ogilvy 创意生成正常情况下:
//   1. response.usage.cost (OpenRouter 权威账单值,2026-05-22 起 primary 也走
//      OR/chat-completions,两条路径同口径)
//   2. usage.cost 缺失才回这张表(<5%)
// 'gpt-image-2' / 'gpt-image-1' 保留 key 是为了老 aigc_assets 行回看;
// 当前路径都用前缀键('openai/...')。
const IMAGE_PRICES_PER_CALL = {
  // legacy direct-OpenAI keys —— 历史 row 回看用,新调用不会写
  'gpt-image-2': OPENAI_GPT_IMAGE_2_FLAT_USD_PER_IMAGE,
  'gpt-image-1': OPENAI_GPT_IMAGE_1_FLAT_USD_PER_IMAGE,
  // 当前 OR 路径
  'openai/gpt-5.4-image-2': OPENAI_GPT_IMAGE_2_FLAT_USD_PER_IMAGE,
  'google/gemini-3.1-flash-image-preview': 1.34,
};

// Anthropic prompt cache 折扣系数（相对 input 价）。
// 文档值：写入 1.25×，命中读取 0.1×。
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT  = 0.10;

// 找最贴近的价格条目。OpenRouter 返回的 model 字段有时会带 ":nitro" / 路由后缀，
// 先精确匹配，再 startsWith 兜底。
function lookupPrice(model) {
  if (!model) return UNKNOWN;
  if (PRICES[model]) return PRICES[model];
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key)) return PRICES[key];
  }
  return UNKNOWN;
}

/**
 * 计算单次 LLM 调用的成本。
 *
 * promptTokens 在 Anthropic prompt-caching 启用时含义会变化：OpenRouter 透传
 * 的 usage 字段把"未缓存的常规输入"留在 prompt_tokens 里，把缓存写入 / 命中
 * 拆到 cache_creation_input_tokens / cache_read_input_tokens。三者互不重叠。
 *
 * @param {object} p
 * @param {string} p.model
 * @param {number} [p.promptTokens=0]
 * @param {number} [p.completionTokens=0]
 * @param {number} [p.cacheCreationInputTokens=0]
 * @param {number} [p.cacheReadInputTokens=0]
 */
export function calcCostUsd({
  model,
  promptTokens = 0,
  completionTokens = 0,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
}) {
  const p = lookupPrice(model);
  const cost =
    (promptTokens / 1000) * p.input +
    (completionTokens / 1000) * p.output +
    (cacheCreationInputTokens / 1000) * p.input * CACHE_WRITE_MULT +
    (cacheReadInputTokens / 1000) * p.input * CACHE_READ_MULT;
  // 6 位小数，跟 DB 列一致
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// 同 lookupPrice：OpenRouter 返回的 model 字段常带日期后缀（如
// 'google/gemini-3.1-flash-image-preview-20260226'），精确匹配会落空，
// 走 startsWith 兜底。命中不到走 0。
function lookupImagePrice(model) {
  if (!model) return 0;
  if (IMAGE_PRICES_PER_CALL[model] != null) return IMAGE_PRICES_PER_CALL[model];
  for (const key of Object.keys(IMAGE_PRICES_PER_CALL)) {
    if (model.startsWith(key)) return IMAGE_PRICES_PER_CALL[key];
  }
  return 0;
}

/**
 * 图片生成单次成本。命中不到表的模型走 0(同 calcCostUsd 兜底语义)。
 *
 * @param {object} p
 * @param {string} p.model
 * @param {number} [p.count=1] 单次调用返回的图片数(OpenAI /images/edits 的 n 参数)
 */
export function calcImageCostUsd({ model, count = 1 }) {
  return Math.round(lookupImagePrice(model) * count * 1_000_000) / 1_000_000;
}

