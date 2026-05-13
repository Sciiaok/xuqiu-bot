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

/**
 * Async upload: POST returns in <2s with `{document_id, status, dedup, ...}`.
 * Caller subscribes to progress via `subscribeUploadProgress(document_id, ...)`.
 *
 * `status` is one of:
 *   - 'processing' (new upload, dedup=false): subscribe to SSE for progress
 *   - 'ready'      (dedup=true): identical file already in KB, no work to do
 *   - 'processing' (dedup=true): same file being uploaded right now in another
 *                                tab/session — subscribe to its progress
 */
export async function uploadDocument(agentId, file, layer) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('agent_id', agentId);
  formData.append('layer', layer);
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

/**
 * Subscribe to upload progress for a document via SSE.
 *
 * Returns a `() => void` cleanup function — call it to abort the connection
 * (e.g. in a useEffect cleanup or after a terminal event).
 *
 * Handlers:
 *   - onProgress({ stage, ...stage-specific data })
 *       stages: 'parsing' | 'extracting' | 'embedding' | 'structured' | 'images'
 *       'embedding' includes { done, total }
 *       'structured' includes { kind: 'product'|'logistics', count }
 *   - onDone({ knowledge_points, conflicts, images, replayed? })
 *   - onError({ message, replayed?, orphan? })
 */
export function subscribeUploadProgress(docId, { onProgress, onDone, onError } = {}) {
  const es = new EventSource(`/api/knowledge/upload/stream${qs({ doc_id: docId })}`);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };
  es.addEventListener('progress', (e) => {
    try { onProgress?.(JSON.parse(e.data)); } catch {}
  });
  es.addEventListener('done', (e) => {
    let data = {};
    try { data = JSON.parse(e.data); } catch {}
    onDone?.(data);
    close();
  });
  es.addEventListener('error', (e) => {
    // EventSource fires 'error' both for SSE error events and for transport
    // failures. Synthetic SSE 'error' has data; transport errors don't.
    let data = null;
    if (e.data) {
      try { data = JSON.parse(e.data); } catch {}
    }
    if (data) {
      onError?.(data);
      close();
    } else if (es.readyState === EventSource.CLOSED) {
      onError?.({ message: '连接已断开' });
      close();
    }
    // Otherwise EventSource will auto-reconnect.
  });
  return close;
}

export async function deleteDocument(docId) {
  return apiFetch(`/api/knowledge/documents${qs({ doc_id: docId })}`, { method: 'DELETE' });
}

/**
 * 重新解析一份已上传的文档（按 storage 里的原文件再跑一遍抽取管道）。
 * 后端清掉旧 KP / products / shipping_routes，把 status 设回 'processing'，
 * 然后按和 upload 完全一致的 SSE 事件流回吐进度。
 *
 * 返回 { document_id, status:'processing', filename, layer } —— 调用方可以
 * 立即 subscribeUploadProgress(document_id, ...) 订阅进度。
 */
export async function reparseDocument(docId) {
  return apiFetch(`/api/knowledge/documents/reparse${qs({ doc_id: docId })}`, { method: 'POST' });
}

export async function getDocumentDownloadUrl(docId) {
  const data = await apiFetch(`/api/knowledge/documents/download${qs({ doc_id: docId })}`);
  return data.url;
}

/* ── Teach (Conversational Input — 2-step: extract → user confirms → commit) ── */

/**
 * Step 1: LLM extracts discrete knowledge points from free text. NO write.
 * Returns { reply, extracted_knowledge: [...] }.
 */
export async function teachExtract(agentId, message) {
  return apiFetch('/api/knowledge/teach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, message }),
  });
}

/**
 * Step 2: persist the items the user confirmed (possibly edited).
 * Returns { inserted_count }.
 */
export async function teachCommit(agentId, items) {
  return apiFetch('/api/knowledge/teach/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, items }),
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

export async function patchAsset(assetId, patch) {
  return apiFetch(`/api/knowledge/assets${qs({ asset_id: assetId })}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/* ── Conflicts ────────────────────────────────────────── */

export async function resolveConflict(conflictId, strategy) {
  return apiFetch('/api/knowledge/conflicts/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conflict_id: conflictId, strategy }),
  });
}

/* ── QA snippets ───────────────────────────────────────── */

export async function listQaSnippets(agentId, { includeInactive = false } = {}) {
  const data = await apiFetch(`/api/knowledge/qa-snippets${qs({ agent_id: agentId, include_inactive: includeInactive ? 'true' : '' })}`);
  return data.snippets || [];
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

