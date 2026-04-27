import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Meta system_user_token 加密 / 解密。
 *
 * Format: [12 bytes IV][16 bytes auth tag][ciphertext]
 * 算法 AES-256-GCM。密钥从 META_TOKEN_ENCRYPTION_KEY 取，64 字符 hex（=32 字节）。
 *
 * 存储约定：encrypt 返回 `\x{hex}` 字符串，可直接作为 bytea 列值给 supabase-js
 * 插入（PostgREST 会按 hex 解码成字节存进 bytea）。**不要直接传 Buffer** ——
 * supabase-js 会把 Buffer JSON 序列化成 `{"type":"Buffer","data":[...]}`，
 * 写进去就是损坏的字节，AES-GCM auth tag 解密时会失败。
 *
 * decrypt 接受 supabase-js 读出来的所有常见形态：
 *   - `\x{hex}` 字符串（默认 bytea_output=hex）
 *   - Buffer / Uint8Array（少见，自定义 client）
 *   - 纯 hex 字符串（无 \x 前缀）
 *
 * 生成新密钥：
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * 不要换密钥 —— 已加密数据会无法解密。
 */

function getKey() {
  const raw = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('META_TOKEN_ENCRYPTION_KEY env var is not set');
  }
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== 32) {
    throw new Error(`META_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars), got ${buf.length} bytes`);
  }
  return buf;
}

/**
 * 加密 plaintext，返回 PostgREST bytea 兼容的 `\x{hex}` 字符串。
 */
export function encryptToken(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('encryptToken: plaintext must be a non-empty string');
  }
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return '\\x' + Buffer.concat([iv, tag, ciphertext]).toString('hex');
}

/**
 * 解密 supabase-js 读出来的字段，返回明文 string。
 * 输入兼容 \x{hex} 字符串 / Buffer / Uint8Array / 纯 hex 字符串。
 */
export function decryptToken(input) {
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (input instanceof Uint8Array) {
    buf = Buffer.from(input);
  } else if (typeof input === 'string') {
    const hex = input.startsWith('\\x') ? input.slice(2) : input;
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('decryptToken: input string is not a valid hex / \\x-prefixed bytea representation');
    }
    buf = Buffer.from(hex, 'hex');
  } else {
    throw new Error('decryptToken: unsupported input format');
  }
  if (buf.length < 12 + 16 + 1) {
    throw new Error('decryptToken: ciphertext too short');
  }
  const key = getKey();
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function isEncryptionConfigured() {
  return Boolean(process.env.META_TOKEN_ENCRYPTION_KEY);
}
