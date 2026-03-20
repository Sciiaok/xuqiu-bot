import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { isDemoMode, DEMO_USER } from './demo-mode.js';

export async function createClient() {
  // Demo mode: return a minimal mock client that fakes auth
  if (isDemoMode()) {
    return {
      auth: {
        getUser: async () => ({ data: { user: DEMO_USER }, error: null }),
      },
    };
  }

  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Ignore - called from Server Component
          }
        },
      },
    }
  );
}
