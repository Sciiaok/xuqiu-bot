// Next.js automatically loads .env.local into process.env.
//
// This file is the SINGLE SOURCE OF TRUTH for env-derived config.
// Rule: no other .js file may read `process.env.XXX` directly.
// The only exception is `lib/supabase-browser.js`, which runs in the
// client bundle and must read `NEXT_PUBLIC_*` inline (Next.js convention).

export const config = {
  // OpenRouter — used by llm-client for all LLM calls (/chat/completions).
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  },

  // OpenAI Direct — embeddings + Whisper only.
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  // Supabase — URL + publishable/anon key (safe to include in client bundles)
  supabase: {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
  },

  // WhatsApp Cloud API
  whatsapp: {
    token: process.env.WA_TOKEN,
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
    verifyToken: process.env.WA_VERIFY_TOKEN,
    apiVersion: process.env.WA_API_VERSION || 'v21.0',
  },

  // Meta Marketing API — ad campaign execution
  meta: {
    accessToken: process.env.META_SYSTEM_TOKEN || process.env.META_ACCESS_TOKEN,
    adAccountId: process.env.META_AD_ACCOUNT_ID,
    pageId: process.env.META_PAGE_ID,
    apiVersion: process.env.META_API_VERSION || 'v21.0',
    apiTimeoutMs: parseInt(process.env.META_API_TIMEOUT_MS) || 30_000,
  },

  // Meta Ads MCP (spawned subprocess OR remote HTTP bridge)
  metaAdsMcp: {
    url: process.env.META_ADS_MCP_URL || '',
    command: process.env.META_ADS_MCP_COMMAND || 'uvx',
    args: (process.env.META_ADS_MCP_ARGS || 'meta-ads-mcp').split(' '),
  },

  // SerpAPI — Google Trends fallback
  serpapi: {
    apiKey: process.env.SERPAPI_KEY,
  },

  // Firecrawl — website scraping / extraction
  firecrawl: {
    apiKey: process.env.FIRECRAWL_API_KEY,
    baseURL: process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev/v1',
  },

  // AIGC — image generation knobs.
  // Client (apiKey/baseURL) is owned by llm-client's openrouter.
  aigc: {
    imageModel: process.env.AIGC_IMAGE_MODEL || 'google/gemini-3.1-flash-image-preview',
    storageBucket: 'aigc-assets',
    bestOfN: parseInt(process.env.AIGC_BEST_OF_N, 10) || 1,
    noFallback: Boolean(process.env.AIGC_NO_FALLBACK),
  },

  // Message Queue (aggregation for rapid messages)
  queue: {
    aggregationWindowMs: parseInt(process.env.QUEUE_AGGREGATION_MS) || 2000,
    maxRetries: parseInt(process.env.QUEUE_MAX_RETRIES) || 3,
    lockTimeoutMs: parseInt(process.env.QUEUE_LOCK_TIMEOUT_MS) || 30000,
    instanceId: process.env.INSTANCE_ID || `instance-${process.pid}`,
  },

  // Campaign orchestration tuning knobs
  campaign: {
    creativeConcurrency: parseInt(process.env.CREATIVE_CONCURRENCY, 10) || 10,
  },

  // Feishu (Lark) — sales routing notifications + KB import
  feishu: {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    chatId: process.env.FEISHU_CHAT_ID,
  },

  // Redis (queue + rate limiter + cache)
  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
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
    baseUrl: process.env.NEXT_PUBLIC_APP_URL,
    demoMode: process.env.DEMO_MODE === 'true',
    takeoverAutoExpireDisabled: process.env.TAKEOVER_AUTO_EXPIRE === 'off',
  },

  // Internal API secrets (cron jobs, partner APIs)
  secrets: {
    cron: process.env.CRON_SECRET,
    revoScmApiKey: process.env.REVO_SCM_API_KEY,
  },
};
