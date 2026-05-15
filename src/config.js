// Next.js automatically loads .env.local into process.env.
//
// This file is the SINGLE SOURCE OF TRUTH for env-derived config.
// Rule: no other .js file may read `process.env.XXX` directly.

export const config = {
  // OpenRouter — used by llm-client for all LLM calls (/chat/completions).
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  },

  // OpenAI Direct — embeddings + Whisper only.
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  // Supabase — URL + publishable/anon key (safe to include in client bundles)
  // serviceRoleKey 仅 server 端可见 —— 创建 auth 用户、绕 RLS 等管理操作用。
  supabase: {
    url: 'https://exevqpqpsvojfowpzize.supabase.co',
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  // WhatsApp Cloud API
  whatsapp: {
    verifyToken: 'revopanda_verify_token',
    apiVersion: 'v21.0',
  },

  // Meta Marketing API — ad campaign execution
  meta: {
    apiVersion: 'v21.0',
    apiTimeoutMs: 30_000,
    // 多租户：所有租户的 token 必须属于这个 App，订阅 webhook 才会推到我们后端
    appId: "1436127511218148",
  },

  // Firecrawl — website scraping / extraction
  firecrawl: {
    apiKey: process.env.FIRECRAWL_API_KEY,
    baseURL: 'https://api.firecrawl.dev/v1',
  },

  // Tavily — web search REST API（Ogilvy 用，替代 Anthropic 原生 web_search Haiku 中转）。
  // 未配置时 webSearch 自动 fallback 到 Anthropic 原生 web_search（贵 ~20×）。
  tavily: {
    apiKey: process.env.TAVILY_API_KEY,
    baseURL: 'https://api.tavily.com',
  },

  // AIGC — image generation knobs.
  // Client (apiKey/baseURL) is owned by llm-client's openrouter.
  aigc: {
    imageModel: 'google/gemini-3.1-flash-image-preview',
    storageBucket: 'aigc-assets',
    bestOfN: parseInt(process.env.AIGC_BEST_OF_N, 10) || 1,
    noFallback: Boolean(process.env.AIGC_NO_FALLBACK),
  },

  // Message Queue (aggregation for rapid messages)
  // 注：进程级唯一的 queue instanceId 不在这里 —— `process.pid` 是 Node-only，
  // 写在 config.js 顶层会让 Edge Runtime（proxy.js）import 时直接 build fail。
  // 由唯一消费方 lib/repositories/queue.repository.js 自己读 process.pid。
  queue: {
    aggregationWindowMs: 2000,
    maxRetries: 3,
    // 90s = medici 单次调用的隐式上限。锁超时后 release_stale_queue_locks 会
    // 把行释放回 pending，另一个 worker 可能抢同一会话并发跑 —— 所以
    // lockTimeoutMs 必须 ≥ medici 最慢路径耗时（5 轮 KB tool use + 慢 API），
    // 否则就是制造并发竞态。30s 不够，90s 给够 buffer。
    lockTimeoutMs: 90000,
  },

  // Campaign orchestration tuning knobs
  campaign: {
    creativeConcurrency: 10,
  },

  // 飞书通知改成 per-tenant webhook 后，FEISHU_APP_ID/SECRET/CHAT_ID 不再使用，
  // 配置在 notification_settings 表里（每个 tenant 自己粘 webhook URL）。

  // Redis (queue + rate limiter + cache)
  redis: {
    url: 'redis://127.0.0.1:6379',
  },

  // Outbound HTTP proxy (Meta API from China, etc.)
  proxy: {
    httpsUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
  },

  // Server
  server: {
    port: process.env.PORT || 3002,
  },

  // App runtime flags & URLs
  app: {
    baseUrl: 'https://www.promeengine.com',
    takeoverAutoExpireDisabled: 'off' === 'off',
  },

  // Internal API secrets (cron jobs, partner APIs)
  secrets: {
    cron: process.env.CRON_SECRET,
    revoScmApiKey: process.env.REVO_SCM_API_KEY,
  },
};
