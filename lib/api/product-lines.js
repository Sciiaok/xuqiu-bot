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

/**
 * Lazy-create the product_line for a given WhatsApp phone_number_id. The slug
 * and display name are generated server-side from the WA account info.
 * Idempotent: clicking the same number twice returns the existing row.
 */
export async function createProductLineForPhoneNumber(phoneNumberId) {
  const data = await apiFetch('/api/product-lines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number_id: phoneNumberId }),
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

/** Fetches the Ogilvy-managed WA account list. */
export async function listWhatsAppAccounts({ force = false } = {}) {
  return apiFetch(`/api/ogilvy/whatsapp-accounts${qs({ force: force ? '1' : undefined })}`);
}
