// LLM 模型定价表 —— 单位 USD per 1K tokens
//
// 维护说明：模型上线/调价时直接改这里。命中不到的 model 走 UNKNOWN 兜底
// （cost = 0），不影响调用，只是统计成本会偏低 —— 看到「成本=0 但调用数>0」
// 就该来补这张表。
//
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

export function calcCostUsd({ model, promptTokens = 0, completionTokens = 0 }) {
  const p = lookupPrice(model);
  const cost = (promptTokens / 1000) * p.input + (completionTokens / 1000) * p.output;
  // 6 位小数，跟 DB 列一致
  return Math.round(cost * 1_000_000) / 1_000_000;
}
