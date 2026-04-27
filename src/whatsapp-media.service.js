import { config } from './config.js';

const MIME_EXTENSION_MAP = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

const CLAUDE_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function normalizeMimeType(mimeType) {
  if (!mimeType) return null;
  if (mimeType === 'image/jpg') return 'image/jpeg';
  return mimeType;
}

function defaultExtensionForMimeType(mimeType) {
  return MIME_EXTENSION_MAP[normalizeMimeType(mimeType)] || 'bin';
}

export function buildMediaFilename(type, mimeType, mediaId, filename) {
  if (filename) return filename;

  const safeType = type || 'media';
  const suffix = mediaId ? mediaId.slice(-8) : Date.now().toString(36);
  const ext = defaultExtensionForMimeType(mimeType);
  return `whatsapp-${safeType}-${suffix}.${ext}`;
}

export function buildInboundMediaPlaceholder({ type, filename, caption }) {
  const base = `[${type}: ${filename}]`;
  return caption ? `${base} ${caption}` : base;
}

export function buildWhatsAppMediaProxyUrl(mediaId) {
  return `/api/media/whatsapp/${mediaId}`;
}

export function isClaudeSupportedImageMimeType(mimeType) {
  return CLAUDE_SUPPORTED_IMAGE_MIME_TYPES.has(normalizeMimeType(mimeType));
}

// Tag the Graph API's "object does not exist" signal so callers can map it
// to HTTP 410 Gone instead of an opaque 5xx. WhatsApp Cloud API only keeps
// media for a limited window (days to ~2 weeks); once rotated out, Meta
// returns code 100 subcode 33, which is expected and not a bug on our side.
export class WhatsAppMediaGoneError extends Error {
  constructor(mediaId, graphError) {
    super(`WhatsApp media ${mediaId} is no longer available`);
    this.name = 'WhatsAppMediaGoneError';
    this.mediaId = mediaId;
    this.graphError = graphError;
  }
}

function isMediaGoneError(graphError) {
  const e = graphError?.error;
  return e?.code === 100 && e?.error_subcode === 33;
}

/**
 * Token 必须由 caller 显式传入。caller 自己按 tenant / phoneNumberId 解析。
 * 无 env fallback。
 */
function requireToken(token) {
  if (!token) {
    throw new Error('whatsapp-media: token required (caller must resolve from tenant context)');
  }
  return token;
}

export async function getWhatsAppMediaMetadata(mediaId, { token } = {}) {
  const accessToken = requireToken(token);
  const response = await fetch(
    `https://graph.facebook.com/${config.whatsapp.apiVersion}/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => null);
    if (isMediaGoneError(err)) {
      throw new WhatsAppMediaGoneError(mediaId, err);
    }
    throw new Error(`WhatsApp media metadata error: ${JSON.stringify(err || { status: response.status })}`);
  }

  const data = await response.json();
  return {
    ...data,
    mime_type: normalizeMimeType(data.mime_type),
  };
}

export async function downloadWhatsAppMediaBuffer(mediaId, { token } = {}) {
  const accessToken = requireToken(token);
  const metadata = await getWhatsAppMediaMetadata(mediaId, { token: accessToken });
  const mediaResponse = await fetch(metadata.url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!mediaResponse.ok) {
    throw new Error(`WhatsApp media download failed: HTTP ${mediaResponse.status}`);
  }

  const buffer = Buffer.from(await mediaResponse.arrayBuffer());
  const mimeType = normalizeMimeType(
    metadata.mime_type || mediaResponse.headers.get('content-type')
  );

  return {
    buffer,
    mimeType,
    metadata,
  };
}
