import supabase from '../lib/supabase.js';

// Import the hardcoded defaults from claude.service.js
import { SYSTEM_PROMPT, JSON_SCHEMA } from '../src/claude.service.js';

async function seedDefaultAgent() {
  // Check if default agent already exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .eq('product_line', 'auto')
    .single();

  if (existing) {
    console.log('Default agent already exists, skipping seed');
    return;
  }

  const { data, error } = await supabase
    .from('agents')
    .insert({
      name: 'Vehicle Export Agent',
      product_line: 'auto',
      system_prompt: SYSTEM_PROMPT,
      output_schema: JSON_SCHEMA,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }

  console.log(`Default agent seeded: ${data.id}`);
}

seedDefaultAgent();
