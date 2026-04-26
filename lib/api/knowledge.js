/**
 * Frontend API client for /api/knowledge/*.
 * All functions throw on non-2xx.
 */
import { apiFetch, qs } from './http.js';

/* ── Health & Overview ────────────────────────────────── */

export async function getHealth(agentId) {
  return apiFetch(`/api/knowledge/health${qs({ agent_id: agentId })}`);
}

/* ── Gaps ─────────────────────────────────────────────── */

export async function listGaps(agentId, { status = 'open' } = {}) {
  const data = await apiFetch(`/api/knowledge/gaps${qs({ agent_id: agentId, status })}`);
  return data.gaps || [];
}

export async function updateGap(gapId, status, { resolvedBy } = {}) {
  return apiFetch('/api/knowledge/gaps', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gap_id: gapId, status, resolved_by: resolvedBy }),
  });
}

/* ── Documents ────────────────────────────────────────── */

export async function listDocuments(agentId) {
  const data = await apiFetch(`/api/knowledge/documents${qs({ agent_id: agentId })}`);
  return data.documents || [];
}

export async function uploadDocument(agentId, file, layer) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('agent_id', agentId);
  formData.append('layer', layer);
  // Note: FormData uploads use fetch directly (apiFetch assumes JSON or no body).
  const res = await fetch('/api/knowledge/upload', { method: 'POST', body: formData });
  const text = await res.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  }
  if (!res.ok) {
    const err = new Error(body?.error || `上传失败 (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function deleteDocument(docId) {
  return apiFetch(`/api/knowledge/documents${qs({ doc_id: docId })}`, { method: 'DELETE' });
}

export async function getDocumentDownloadUrl(docId) {
  const data = await apiFetch(`/api/knowledge/documents/download${qs({ doc_id: docId })}`);
  return data.url;
}

/* ── Teach (Conversational Input) ─────────────────────── */

/**
 * Extract + persist knowledge points from a free-text message. The `layer` hint
 * isn't sent — the server's LLM prompt classifies each extracted point into
 * one of the six layers on its own.
 */
export async function teach(agentId, message) {
  return apiFetch('/api/knowledge/teach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, message }),
  });
}

/* ── Assets (sendable images Medici can attach to a reply) ── */

export async function listAssets(agentId) {
  const data = await apiFetch(`/api/knowledge/assets${qs({ agent_id: agentId })}`);
  return data.assets || [];
}

export async function uploadAsset(agentId, file, description) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('agent_id', agentId);
  if (description) formData.append('description', description);
  const res = await fetch('/api/knowledge/assets', { method: 'POST', body: formData });
  const text = await res.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  }
  if (!res.ok) {
    const err = new Error(body?.error || `上传失败 (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function deleteAsset(assetId) {
  return apiFetch(`/api/knowledge/assets${qs({ asset_id: assetId })}`, { method: 'DELETE' });
}

/* ── Conflicts ────────────────────────────────────────── */

export async function resolveConflict(conflictId, strategy) {
  return apiFetch('/api/knowledge/conflicts/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conflict_id: conflictId, strategy }),
  });
}

