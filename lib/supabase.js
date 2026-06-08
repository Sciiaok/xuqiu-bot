import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config.js';

function missingSupabaseClient() {
  return new Proxy({}, {
    get() {
      throw new Error('Supabase is not configured for this deployment.');
    },
  });
}

const supabase = config.supabase.publishableKey
  ? createClient(config.supabase.url, config.supabase.publishableKey)
  : missingSupabaseClient();

export default supabase;
