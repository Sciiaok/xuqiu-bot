import supabase from '../lib/supabase.js';

// Import the hardcoded defaults from claude.service.js
import { SYSTEM_PROMPT, JSON_SCHEMA } from '../src/claude.service.js';

const DEFAULT_VEHICLE_QUALIFICATION_CONFIG = {
  inquiry_quality_requirements: {
    GOOD: {
      required_fields: ['brand', 'car_model'],
    },
    QUALIFY: {
      required_fields: ['color_quantity', 'destination_port'],
    },
    PROOF: {
      required_fields: ['company_name', 'international_commercial_term'],
    },
  },
};

async function seedDefaultAgent() {
  // Check if default agent already exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .eq('product_line', 'auto')
    .single();

  if (existing) {
    console.log('Default agent already exists, updating qualification config...');
    const { data, error } = await supabase
      .from('agents')
      .update({
        name: 'Vehicle Export Agent',
        system_prompt: SYSTEM_PROMPT,
        output_schema: JSON_SCHEMA,
        qualification_config: DEFAULT_VEHICLE_QUALIFICATION_CONFIG,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      console.error('Update failed:', error);
      process.exit(1);
    }
    console.log(`Default agent updated: ${data.id}`);
    return;
  }

  const { data, error } = await supabase
    .from('agents')
    .insert({
      name: 'Vehicle Export Agent',
      product_line: 'auto',
      system_prompt: SYSTEM_PROMPT,
      output_schema: JSON_SCHEMA,
      qualification_config: DEFAULT_VEHICLE_QUALIFICATION_CONFIG,
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
