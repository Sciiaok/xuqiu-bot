/**
 * Shared fetch wrapper: parses JSON, throws Error on non-2xx with server message.
 * All frontend API clients should use this to guarantee consistent error behavior.
 */
export async function apiFetch(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { _raw: text };
    }
  }
  if (!res.ok) {
    const message = body?.error || `请求失败 (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Build a querystring from an object of params, skipping undefined/null values.
 */
export function qs(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}
