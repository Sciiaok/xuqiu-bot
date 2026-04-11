// Next.js automatically loads .env.local - no need for dotenv

export const config = {
  // Claude API — prefer OpenRouter, fallback to Anthropic direct
  anthropic: {
    apiKey: process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.OPENROUTER_API_KEY
      ? (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api')
      : undefined,
    model: process.env.OPENROUTER_API_KEY
      ? (process.env.OPENROUTER_MODEL || 'claude-sonnet-4-6')
      : (process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'),
  },

  // OpenAI Whisper
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  // WhatsApp Cloud API
  whatsapp: {
    token: process.env.WA_TOKEN,
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
    verifyToken: process.env.WA_VERIFY_TOKEN,
    apiVersion: process.env.WA_API_VERSION || 'v21.0',
  },

  // Server
  server: {
    port: process.env.PORT || 3002,
    nodeEnv: process.env.NODE_ENV || 'development',
  },

  // n8n Webhooks (optional)
  n8n: {
    webhookHumanNow: process.env.N8N_WEBHOOK_HUMAN_NOW || '',
    webhookNurture: process.env.N8N_WEBHOOK_NURTURE || '',
  },

  // Meta Marketing API — ad campaign execution
  meta: {
    accessToken: process.env.META_SYSTEM_TOKEN || process.env.META_ACCESS_TOKEN,
    adAccountId: process.env.META_AD_ACCOUNT_ID,
    pageId: process.env.META_PAGE_ID,
    apiVersion: process.env.META_API_VERSION || 'v21.0',
    apiTimeoutMs: parseInt(process.env.META_API_TIMEOUT_MS) || 30_000,
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

  // AIGC — image generation via OpenRouter
  aigc: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api',
    imageModel: process.env.AIGC_IMAGE_MODEL || 'google/gemini-3.1-flash-image-preview',
    storageBucket: 'aigc-assets',
  },

  // Message Queue (aggregation for rapid messages)
  queue: {
    aggregationWindowMs: parseInt(process.env.QUEUE_AGGREGATION_MS) || 2000, // Wait 2s for more messages
    maxRetries: parseInt(process.env.QUEUE_MAX_RETRIES) || 3,
    lockTimeoutMs: parseInt(process.env.QUEUE_LOCK_TIMEOUT_MS) || 30000, // 30s lock timeout
    instanceId: process.env.INSTANCE_ID || `instance-${process.pid}`,
  },
};
