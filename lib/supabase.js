import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config.js';

const supabase = createClient(
  config.supabase.url,
  config.supabase.publishableKey
);

export default supabase;
