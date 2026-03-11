import supabase from '../lib/supabase.js';
import { SYSTEM_PROMPT, JSON_SCHEMA } from '../src/claude.service.js';

async function syncAgentPrompt() {
  // List all agents
  const { data: allAgents } = await supabase
    .from('agents')
    .select('id, name, product_line, is_active')
    .order('created_at', { ascending: true });

  console.log('Current agents in DB:');
  allAgents?.forEach(a => console.log(`  ${a.id} | ${a.name} | product_line=${a.product_line} | active=${a.is_active}`));

  // Check if vehicle agent exists
  let agent = allAgents?.find(a => a.product_line === 'vehicle');

  if (agent) {
    // Update existing vehicle agent
    const { data, error } = await supabase
      .from('agents')
      .update({
        system_prompt: SYSTEM_PROMPT,
        output_schema: JSON_SCHEMA,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agent.id)
      .select('id, name, updated_at')
      .single();

    if (error) { console.error('Update failed:', error); process.exit(1); }
    console.log(`\nUpdated agent: ${data.name} (${data.id})`);
  } else {
    // Create new vehicle agent
    const { data, error } = await supabase
      .from('agents')
      .insert({
        name: 'Vehicle Export Agent',
        product_line: 'vehicle',
        system_prompt: SYSTEM_PROMPT,
        output_schema: JSON_SCHEMA,
        is_active: true,
      })
      .select('id, name')
      .single();

    if (error) { console.error('Create failed:', error); process.exit(1); }
    console.log(`\nCreated agent: ${data.name} (${data.id})`);
  }

  // Verify
  const { data: final } = await supabase
    .from('agents')
    .select('id, name, product_line, is_active')
    .order('created_at', { ascending: true });

  console.log('\nFinal agents:');
  final?.forEach(a => console.log(`  ${a.id} | ${a.name} | product_line=${a.product_line} | active=${a.is_active}`));
}

syncAgentPrompt();
