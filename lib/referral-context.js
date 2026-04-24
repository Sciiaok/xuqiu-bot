function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanObjectEntries(entries) {
  return Object.fromEntries(
    entries.filter(([, value]) => value !== null && value !== undefined && value !== '')
  );
}

export function normalizeReferral(referral, capturedAt = new Date().toISOString()) {
  if (!referral || typeof referral !== 'object') {
    return null;
  }

  const sourceType = compactText(referral.source_type);
  const sourceId = compactText(referral.source_id);
  const normalized = cleanObjectEntries([
    ['source_type', sourceType || null],
    ['source_id', sourceId || null],
    ['ad_id', sourceType === 'ad' && sourceId ? sourceId : null],
    ['headline', compactText(referral.headline) || null],
    ['body', compactText(referral.body) || null],
    ['source_url', compactText(referral.source_url) || null],
    ['media_type', compactText(referral.media_type) || null],
    ['image_url', compactText(referral.image_url) || null],
    ['video_url', compactText(referral.video_url) || null],
    ['thumbnail_url', compactText(referral.thumbnail_url) || null],
    ['ctwa_clid', compactText(referral.ctwa_clid) || null],
    ['captured_at', capturedAt],
  ]);

  return Object.keys(normalized).length > 1 ? normalized : null;
}

export function mergeContactReferralMetadata(existingMetadata, referral) {
  const metadata = { ...(existingMetadata || {}) };
  if (!referral) return metadata;

  if (!metadata.first_referral) {
    metadata.first_referral = referral;
  }
  metadata.last_referral = referral;

  return metadata;
}

export function getReferralAdId(referral) {
  const explicitAdId = compactText(referral?.ad_id);
  if (explicitAdId) return explicitAdId;

  const sourceType = compactText(referral?.source_type);
  const sourceId = compactText(referral?.source_id);
  if (sourceType === 'ad' && sourceId) {
    return sourceId;
  }

  return null;
}

export function extractMetaAdIdFromMessageMetadata(metadata) {
  const explicitMetaAdId = compactText(metadata?.meta_ad_id);
  if (explicitMetaAdId) return explicitMetaAdId;

  const directReferralAdId = getReferralAdId(metadata?.referral);
  if (directReferralAdId) return directReferralAdId;

  const aggregatedMessages = Array.isArray(metadata?.aggregated_messages)
    ? metadata.aggregated_messages
    : [];

  for (let index = aggregatedMessages.length - 1; index >= 0; index -= 1) {
    const aggregatedReferralAdId = getReferralAdId(aggregatedMessages[index]?.metadata?.referral);
    if (aggregatedReferralAdId) return aggregatedReferralAdId;
  }

  return null;
}

/**
 * Format the referral object (Meta Click-to-WhatsApp) into a compact block
 * for the Claude runtime prompt. Returns null when there is nothing
 * worth telling the model about.
 *
 * Intentionally emits only signal-carrying fields: ad metadata Claude can
 * read (source_type, ad_id, headline, body, source_url, media_type).
 * Skips raw media URLs (Claude can't see them), thumbnail_url, and
 * ctwa_clid (tracking id) — those add tokens without adding signal.
 */
export function formatReferralContextForPrompt(referral) {
  if (!referral) return null;

  const lines = [];
  if (referral.source_type) lines.push(`source_type: ${referral.source_type}`);
  if (referral.ad_id)       lines.push(`ad_id: ${referral.ad_id}`);
  if (referral.headline)    lines.push(`headline: ${referral.headline}`);
  if (referral.body)        lines.push(`body: ${referral.body}`);
  if (referral.source_url)  lines.push(`source_url: ${referral.source_url}`);
  if (referral.media_type)  lines.push(`media_type: ${referral.media_type}`);

  return lines.length > 0 ? lines.join('\n') : null;
}
