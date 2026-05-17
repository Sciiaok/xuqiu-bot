/**
 * Raw WhatsApp webhook payload dump — observability only.
 *
 * Insert one row per inbound POST /api/webhook. Called fire-and-forget from
 * the webhook route so failures never affect the message-processing path.
 *
 * Uses the admin (service-role) client because `webhook_dumps` has RLS on and
 * no policy — only server-side admin writes allowed by design.
 */
import { getSupabaseAdmin } from '../supabase-admin.js';

/**
 * @param {Object} args
 * @param {Date}   args.receivedAt  Timestamp when the webhook hit our edge.
 * @param {Object} args.payload     Raw Meta webhook body as parsed JSON.
 */
export async function dumpWebhookPayload({ receivedAt, payload }) {
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('webhook_dumps')
    .insert({
      received_at: receivedAt.toISOString(),
      payload,
    });
  if (error) throw error;
}
