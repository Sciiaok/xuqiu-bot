import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3002',
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'PLAYWRIGHT_TEST=1 NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=test-anon-key npx next dev -p 3002',
    port: 3002,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
