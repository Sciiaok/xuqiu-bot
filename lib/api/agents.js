/**
 * Frontend API client for /api/agents.
 * All functions throw on non-2xx (see lib/api/http.js).
 */
import { apiFetch, qs } from './http.js';

export async function listAgents({ activeOnly = false } = {}) {
  const data = await apiFetch(`/api/agents${qs({ active: activeOnly ? 'true' : undefined })}`);
  return data.agents || [];
}

export async function getAgent(agentId) {
  const data = await apiFetch(`/api/agents/${agentId}`);
  return data.agent;
}

export async function createAgent(body) {
  const data = await apiFetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return data.agent;
}

export async function updateAgent(agentId, body) {
  const data = await apiFetch(`/api/agents/${agentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return data.agent;
}

export async function deleteAgent(agentId) {
  return apiFetch(`/api/agents/${agentId}`, { method: 'DELETE' });
}

/**
 * Toggle agent active state.
 * - `active: false` → DELETE endpoint (preserves the "last active agent" guard)
 * - `active: true`  → PUT endpoint with { isActive: true }
 */
export async function setAgentActive(agentId, active) {
  if (active) {
    return updateAgent(agentId, { isActive: true });
  }
  return deleteAgent(agentId);
}
