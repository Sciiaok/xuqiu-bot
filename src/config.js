// Next.js automatically loads .env.local into process.env.
//
// This file is the SINGLE SOURCE OF TRUTH for env-derived config.
// Rule: no other .js file may read `process.env.XXX` directly.

export const config = {
  llm: {
    provider: process.env.LLM_PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openrouter'),
  },

  // OpenRouter — used by llm-client for all LLM calls (/chat/completions).
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  },

  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
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
    // App Secret —— webhook POST 用 HMAC-SHA256(body) 校验，header 名
    // X-Hub-Signature-256。未配置时 webhook POST 直接拒（无法做来源校验
    // 就别处理），避免静默裸跑被任何知道 phone_number_id 的人伪造消息。
    appSecret: process.env.META_APP_SECRET,
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

  // Message Queue (aggregation for rapid messages)
  // 注：进程级唯一的 queue instanceId 不在这里 —— `process.pid` 是 Node-only，
  // 写在 config.js 顶层会让 Edge Runtime（proxy.js）import 时直接 build fail。
  // 由唯一消费方 lib/repositories/queue.repository.js 自己读 process.pid。
  queue: {
    // 每次 burst 取 [min, max) 之间的随机毫秒数做聚合窗口。固定值会让回复
    // 节奏过于机械，且太短会把碎片消息（"I" / "want" / "info"）拆成多次
    // Medici 调用。3~15s 既能把同一意图的连发拼成一次，也让 AI 回复
    // 看起来像"人类正在打字"而非毫秒级响应。
    aggregationWindowMinMs: 3000,
    aggregationWindowMaxMs: 15000,
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
  feishu: {
    requirementBotCallbackTenantId: process.env.FEISHU_REQUIREMENT_BOT_CALLBACK_TENANT_ID || 'local',
  },

  requirementBot: {
    storePath: process.env.REQUIREMENT_BOT_STORE_PATH || '/tmp/requirement-bot/store.json',
    enabled: process.env.FEISHU_REQUIREMENT_BOT_ENABLED !== 'false',
    feishuAppId: process.env.FEISHU_APP_ID || '',
    feishuAppSecret: process.env.FEISHU_APP_SECRET || '',
    feishuEncryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    defaultChatId: process.env.FEISHU_DEFAULT_CHAT_ID || '',
    defaultPmFeishuUserId: process.env.FEISHU_DEFAULT_PM_USER_ID || '',
    defaultDeveloperFeishuUserId: process.env.FEISHU_DEFAULT_DEVELOPER_USER_ID || '',
    defaultTesterFeishuUserId: process.env.FEISHU_DEFAULT_TESTER_USER_ID || '',
    defaultAcceptorFeishuUserId: process.env.FEISHU_DEFAULT_ACCEPTOR_USER_ID || '',
    bitableAppToken: process.env.FEISHU_BITABLE_APP_TOKEN || process.env.BITABLE_APP_TOKEN || '',
    bitableTableId: process.env.FEISHU_BITABLE_TABLE_ID || process.env.BITABLE_TABLE_ID || '',
    reminderHour: Number(process.env.FEISHU_REMINDER_HOUR || 10),
  },

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
  },

  // Internal API secrets (cron jobs, partner APIs)
  secrets: {
    cron: process.env.CRON_SECRET,
  },
};

/**
 * Pick a random aggregation window in [min, max) ms. Called once per inbound
 * webhook POST (production) or per simulator batch — all messages within the
 * same burst share the same deadline.
 */
export function pickAggregationWindowMs() {
  const lo = config.queue.aggregationWindowMinMs;
  const hi = config.queue.aggregationWindowMaxMs;
  return Math.floor(lo + Math.random() * (hi - lo));
}
