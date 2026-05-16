// LLM 模型定价表 —— 单位 USD per 1K tokens
//
// 维护说明：模型上线/调价时直接改这里。命中不到的 model 走 UNKNOWN 兜底
// （cost = 0），不影响调用，只是统计成本会偏低 —— 看到「成本=0 但调用数>0」
// 就该来补这张表。
//
// Anthropic prompt caching 三段计费（OpenRouter 透传 Anthropic 字段）：
//   - 常规 prompt_tokens          ：input 价
//   - cache_creation_input_tokens ：input × 1.25（写入 cache）
//   - cache_read_input_tokens     ：input × 0.10（命中 cache）
// 价格参考 OpenRouter pricing 页面（人工抄录，会随时间漂移）。

// 注意：请求方 model 字符串和 OpenRouter 返回的 model 字符串可能不一样。
// 比如请求 'anthropic/claude-haiku-4.5'，返回的是 'anthropic/claude-4.5-haiku-20251001'。
// 价表两种 key 都得覆盖，否则 cost 会被错算成 0。
const PRICES = {
  // Anthropic —— 请求方 key
  'anthropic/claude-sonnet-4.6':           { input: 0.003,   output: 0.015   },
  'anthropic/claude-haiku-4.5':            { input: 0.00080, output: 0.00400 },
  // Anthropic —— OpenRouter 实际返回的 key（数字在前 + 日期后缀）
  'anthropic/claude-4.6-sonnet':           { input: 0.003,   output: 0.015   },
  'anthropic/claude-4.5-haiku':            { input: 0.00080, output: 0.00400 },

  // OpenAI
  'openai/gpt-5.4':                        { input: 0.00250, output: 0.01000 },
  'openai/gpt-5.4-mini':                   { input: 0.00015, output: 0.00060 },

  // MiniMax
  'minimax/minimax-m2.7':                  { input: 0.00030, output: 0.00130 },

  // Embeddings (OpenAI)
  'text-embedding-3-small':                { input: 0.00002, output: 0       },

  // Whisper (OpenAI direct, 按分钟计价；近似换算这里跳过 —— 调用量小)
  'whisper-1':                             { input: 0,       output: 0       },
};

const UNKNOWN = { input: 0, output: 0 };

// 图片生成模型按 "每张" 计费，跟 token 表分开。Ogilvy 创意生成走的两条路径:
//   - gpt-image-1 1024×1024 standard:OpenAI 实际单价 ~$0.04/张
//   - google/gemini-3.1-flash-image-preview:OpenRouter 单价 ~$0.03/张
// 跟 token 表一样,模型版本/计费档变了直接改这里。
const IMAGE_PRICES_PER_CALL = {
  'gpt-image-1': 0.04,
  'google/gemini-3.1-flash-image-preview': 0.03,
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

/**
 * 图片生成单次成本。命中不到表的模型走 0(同 calcCostUsd 兜底语义)。
 *
 * @param {object} p
 * @param {string} p.model
 * @param {number} [p.count=1] 单次调用返回的图片数(OpenAI /images/edits 的 n 参数)
 */
export function calcImageCostUsd({ model, count = 1 }) {
  const per = IMAGE_PRICES_PER_CALL[model] ?? 0;
  return Math.round(per * count * 1_000_000) / 1_000_000;
}
