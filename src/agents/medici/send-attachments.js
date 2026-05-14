/**
 * Medici — outbound attachment delivery.
 *
 * Bridges Medici's `attachments[]` envelope decisions into actual WhatsApp
 * media sends. Called from queue-processor *after* the text reply lands so
 * the customer sees: text bubble first, then image bubble(s).
 *
 * Each attachment names a `kb_assets.id` from the AVAILABLE ASSETS list
 * Medici saw in the dynamic context. We:
 *   1. Look the row up.
 *   2. Download the file from the `kb-assets` storage bucket.
 *   3. POST it to WhatsApp via sendMedia.
 *   4. Persist an assistant message so the inbox UI shows the attachment.
 *
 * Failures on a single asset are logged and skipped — the customer still
 * got the text reply, partial delivery is better than throwing away the turn.
 */

import supabase from '../../../lib/supabase.js';
import { sendMedia } from '../../whatsapp.service.js';
import { createMessage } from '../../../lib/repositories/message.repository.js';
import { filterAttachmentsBySkuContext } from './attachment-guard.js';

const STORAGE_BUCKET = 'kb-assets';

function asMediaType(mimeType) {
  if (!mimeType) return null;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

async function fetchAsset(assetId) {
  const { data: row, error } = await supabase
    .from('kb_assets')
    .select('id, agent_id, filename, storage_path, mime_type, is_sendable, linked_skus, description')
    .eq('id', assetId)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error(`asset not found: ${assetId}`);
  if (!row.is_sendable) throw new Error(`asset not sendable: ${assetId}`);

  const { data: file, error: dlError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(row.storage_path);
  if (dlError) throw dlError;
  const buffer = Buffer.from(await file.arrayBuffer());
  return { row, buffer };
}

/**
 * Pre-fetch only the {id, linked_skus} we need for the guard. Cheaper than
 * downloading every asset just to validate; the survivors go through
 * fetchAsset() in the main loop.
 */
async function fetchAssetMetaForGuard(assetIds) {
  if (assetIds.length === 0) return new Map();
  const { data: rows, error } = await supabase
    .from('kb_assets')
    .select('id, linked_skus')
    .in('id', assetIds);
  if (error || !rows) return new Map();
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Send each attachment WhatsApp-side and record a corresponding assistant
 * message. Returns counts so callers can log a summary.
 */
export async function sendMediciAttachments({
  attachments,
  conversationId,
  tenantId,
  waId,
  phoneNumberId,
  productContext,
  logger,
}) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { sent: 0, failed: 0, dropped: 0 };
  }
  if (!tenantId) {
    throw new Error('sendMediciAttachments: tenantId required');
  }

  // SKU/brand guard — drop attachments that obviously don't match the
  // conversation's product context. See attachment-guard.js.
  const assetIds = attachments.map((a) => a?.asset_id).filter(Boolean);
  const assetMetaById = await fetchAssetMetaForGuard(assetIds);
  const { kept, dropped } = filterAttachmentsBySkuContext(
    attachments,
    assetMetaById,
    productContext || {},
    logger,
  );
  const droppedCount = dropped.length;
  const safeAttachments = kept;

  let sent = 0;
  let failed = 0;

  for (const att of safeAttachments) {
    const assetId = att?.asset_id;
    const caption = typeof att?.caption === 'string' ? att.caption : '';
    if (!assetId) {
      failed++;
      continue;
    }

    try {
      const { row, buffer } = await fetchAsset(assetId);
      const mediaType = asMediaType(row.mime_type);
      if (!mediaType) {
        throw new Error(`unsupported mime_type for outbound: ${row.mime_type}`);
      }

      await sendMedia(
        waId,
        mediaType,
        buffer,
        row.mime_type,
        row.filename,
        caption,
        phoneNumberId,
      );

      const messageContent = caption
        ? `[${mediaType}: ${row.filename}] ${caption}`
        : `[${mediaType}: ${row.filename}]`;

      await createMessage({
        tenantId,
        conversationId,
        role: 'assistant',
        content: messageContent,
        sentBy: 'bot',
        metadata: {
          media_type: mediaType,
          filename: row.filename,
          kb_asset_id: row.id,
        },
      });

      sent++;
      logger?.info?.('queue.attachment.sent', {
        asset_id: row.id,
        filename: row.filename,
        mime_type: row.mime_type,
      });
    } catch (err) {
      failed++;
      logger?.warn?.('queue.attachment.failed', {
        asset_id: assetId,
        error: err.message,
      });
    }
  }

  return { sent, failed, dropped: droppedCount };
}
