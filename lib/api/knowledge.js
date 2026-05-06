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

export async function uploadAsset(agentId, file, description, tags = {}) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('agent_id', agentId);
  if (description) formData.append('description', description);
  // Optional structured tags — see Wave 1A
  for (const k of ['view', 'color', 'scenario', 'language', 'asset_type']) {
    if (tags[k]) formData.append(k, tags[k]);
  }
  if (tags.linked_skus) {
    formData.append('linked_skus',
      Array.isArray(tags.linked_skus) ? tags.linked_skus.join(',') : tags.linked_skus);
  }
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

/* ── Excel template import (structured, bypasses LLM extraction) ── */

export async function importTemplate(agentId, file, templateKind) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('agent_id', agentId);
  formData.append('template_kind', templateKind);
  const res = await fetch('/api/knowledge/import-template', { method: 'POST', body: formData });
  const text = await res.text();
  let body = {};
  if (text) { try { body = JSON.parse(text); } catch { body = { _raw: text }; } }
  if (!res.ok) {
    const err = new Error(body?.error || `导入失败 (${res.status})`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

/* ── QA snippets ───────────────────────────────────────── */

export async function listQaSnippets(agentId, { includeInactive = false } = {}) {
  const data = await apiFetch(`/api/knowledge/qa-snippets${qs({ agent_id: agentId, include_inactive: includeInactive ? 'true' : '' })}`);
  return data.snippets || [];
}

export async function createQaSnippet(agentId, { questions, answer, applicableWhen, priority }) {
  return apiFetch('/api/knowledge/qa-snippets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      questions, answer,
      applicable_when: applicableWhen,
      priority,
    }),
  });
}

export async function updateQaSnippet(agentId, snippetId, patch) {
  return apiFetch('/api/knowledge/qa-snippets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, snippet_id: snippetId, ...patch }),
  });
}

export async function deleteQaSnippet(agentId, snippetId) {
  return apiFetch(`/api/knowledge/qa-snippets${qs({ agent_id: agentId, snippet_id: snippetId })}`, { method: 'DELETE' });
}

/* ── Pending review ──────────────────────────────────── */

export async function listPendingReview(agentId, { status = 'pending' } = {}) {
  const data = await apiFetch(`/api/knowledge/pending-review${qs({ agent_id: agentId, status })}`);
  return data.items || [];
}

export async function resolvePendingReview(agentId, reviewId, action, { note } = {}) {
  return apiFetch('/api/knowledge/pending-review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, review_id: reviewId, action, note }),
  });
}

/* ── Corrections ─────────────────────────────────────── */

export async function listCorrections(agentId, { status = 'pending' } = {}) {
  const data = await apiFetch(`/api/knowledge/corrections${qs({ agent_id: agentId, status })}`);
  return data.items || [];
}

export async function recordCorrection(agentId, payload) {
  return apiFetch('/api/knowledge/corrections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, ...payload }),
  });
}

export async function resolveCorrection(agentId, correctionId, action, { overrides } = {}) {
  return apiFetch('/api/knowledge/corrections', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, correction_id: correctionId, action, overrides }),
  });
}

