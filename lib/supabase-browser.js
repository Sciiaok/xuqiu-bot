import { createBrowserClient } from '@supabase/ssr';
import { config } from '@/src/config';

export function createClient() {
  return createBrowserClient(
    config.supabase.url,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
  );
}
