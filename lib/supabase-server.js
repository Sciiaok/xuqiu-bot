import { createServerClient } from '@supabase/ssr';
import { createClient as createJsClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { isDemoMode, DEMO_USER } from './demo-mode.js';
import { config } from '../src/config.js';

export async function createClient() {
  // Demo mode: return a minimal mock client that fakes auth
  if (isDemoMode()) {
    return {
      auth: {
        getUser: async () => ({ data: { user: DEMO_USER }, error: null }),
      },
    };
  }

  // Bearer JWT: external clients send Authorization header
  const headerStore = await headers();
  const authHeader = headerStore.get('authorization');

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const client = createJsClient(
      config.supabase.url,
      config.supabase.publishableKey,
      {
        global: { headers: { Authorization: authHeader } },
      }
    );
    // auth.getUser() doesn't read global headers — bind the token explicitly
    const _getUser = client.auth.getUser.bind(client.auth);
    client.auth.getUser = () => _getUser(token);
    return client;
  }

  // Fallback: cookie-based auth (dashboard / same-origin requests)
  const cookieStore = await cookies();

  return createServerClient(
    config.supabase.url,
    config.supabase.publishableKey,
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
