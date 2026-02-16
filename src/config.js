// Next.js automatically loads .env.local - no need for dotenv

export const config = {
  // Claude API
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929',
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
};
