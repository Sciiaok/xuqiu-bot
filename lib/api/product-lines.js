/** Frontend API client for /api/product-lines. Throws on non-2xx. */
import { apiFetch, qs } from './http.js';

export async function listProductLines({ activeOnly = false } = {}) {
  const data = await apiFetch(`/api/product-lines${qs({ active: activeOnly ? 'true' : undefined })}`);
  return data.lines || [];
}

export async function getProductLine(id) {
  const data = await apiFetch(`/api/product-lines/${id}`);
  return data.line;
}

export async function createProductLine(body) {
  const data = await apiFetch('/api/product-lines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return data.line;
}

export async function updateProductLine(id, body) {
  const data = await apiFetch(`/api/product-lines/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return data.line;
}

export async function deleteProductLine(id) {
  return apiFetch(`/api/product-lines/${id}`, { method: 'DELETE' });
}

export async function setProductLineActive(id, active) {
  if (active) return updateProductLine(id, { is_active: true });
  return deleteProductLine(id);
}

/** Fetches the autopilot-managed WA account list for the binding dropdown. */
export async function listWhatsAppAccounts({ force = false } = {}) {
  return apiFetch(`/api/autopilot/whatsapp-accounts${qs({ force: force ? '1' : undefined })}`);
}
