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

export async function getWhatsAppMediaMetadata(mediaId) {
  const response = await fetch(
    `https://graph.facebook.com/${config.whatsapp.apiVersion}/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
      },
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => null);
    throw new Error(`WhatsApp media metadata error: ${JSON.stringify(err || { status: response.status })}`);
  }

  const data = await response.json();
  return {
    ...data,
    mime_type: normalizeMimeType(data.mime_type),
  };
}

export async function downloadWhatsAppMediaBuffer(mediaId) {
  const metadata = await getWhatsAppMediaMetadata(mediaId);
  const mediaResponse = await fetch(metadata.url, {
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
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
