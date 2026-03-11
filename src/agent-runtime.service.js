function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstMeaningfulLine(systemPrompt) {
  const lines = String(systemPrompt || '')
    .split('\n')
    .map((line) => compactText(line))
    .filter(Boolean);

  return lines[0] || '';
}

/**
 * Build a concise candidate summary for router prompts.
 */
export function buildRoutingCandidate(agent) {
  const summary = extractFirstMeaningfulLine(agent?.system_prompt);
  const routingHints = Array.isArray(agent?.routing_hints)
    ? agent.routing_hints.join(', ')
    : compactText(agent?.routing_hints || '');

  return {
    id: agent.id,
    name: agent.name,
    product_line: agent.product_line,
    summary: summary.slice(0, 240),
    routing_hints: routingHints.slice(0, 240),
  };
}

/**
 * Allows future shared-prompt layering without changing getResponse().
 * Current agents still work because full prompts/schema remain the fallback.
 */
export function buildRuntimeAgentConfig(agent) {
  if (!agent) return null;

  const sharedBasePrompt = compactText(agent.shared_base_prompt);
  const promptAddon = compactText(agent.prompt_addon);
  const systemPrompt = sharedBasePrompt && promptAddon
    ? `${sharedBasePrompt}\n\n${promptAddon}`
    : agent.system_prompt;

  return {
    ...agent,
    system_prompt: systemPrompt,
    output_schema: agent.output_schema || {},
    qualification_config: agent.qualification_config || {},
  };
}
