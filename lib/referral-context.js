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

function formatAdContextEntry(entry) {
  if (typeof entry === 'string') {
    return compactText(entry);
  }

  if (!entry || typeof entry !== 'object') {
    return '';
  }

  const label = compactText(entry.label || entry.name || entry.title);
  const context = compactText(entry.context || entry.prompt || entry.description);

  return [label, context].filter(Boolean).join(': ');
}

export function resolveAgentAdContext(agent, adId) {
  const normalizedAdId = compactText(adId);
  if (!normalizedAdId) return '';

  const mapping = agent?.ad_context_map;
  if (!mapping) return '';

  if (Array.isArray(mapping)) {
    const matched = mapping.find((entry) => compactText(entry?.ad_id || entry?.id) === normalizedAdId);
    return formatAdContextEntry(matched).slice(0, 320);
  }

  if (typeof mapping === 'object') {
    const matched = mapping[normalizedAdId];
    return formatAdContextEntry(matched).slice(0, 320);
  }

  return '';
}

export function countAgentAdContexts(agent) {
  const mapping = agent?.ad_context_map;
  if (!mapping) return 0;
  if (Array.isArray(mapping)) return mapping.length;
  if (typeof mapping === 'object') return Object.keys(mapping).length;
  return 0;
}

export function formatReferralContextForPrompt(referral) {
  if (!referral) {
    return 'No inbound referral context.';
  }

  const lines = [
    `source_type: ${referral.source_type || 'unknown'}`,
    `source_id: ${referral.source_id || 'unknown'}`,
  ];

  if (referral.ad_id) lines.push(`ad_id: ${referral.ad_id}`);
  if (referral.headline) lines.push(`headline: ${referral.headline}`);
  if (referral.body) lines.push(`body: ${referral.body}`);
  if (referral.source_url) lines.push(`source_url: ${referral.source_url}`);
  if (referral.media_type) lines.push(`media_type: ${referral.media_type}`);
  if (referral.ctwa_clid) lines.push(`ctwa_clid: ${referral.ctwa_clid}`);

  return lines.join('\n');
}
