/**
 * Ensure modules that bootstrap an external client at import time (Supabase,
 * llm-client, etc.) don't throw during unit tests that never actually hit the
 * network. Dummy values are fine — tests that need real calls should mock or
 * guard them explicitly.
 */
const DEFAULTS = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY: 'test-key',
  OPENROUTER_API_KEY: 'test-key',
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}
