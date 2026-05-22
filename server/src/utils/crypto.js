import crypto from 'node:crypto';

// AES-256-GCM symmetric encryption keyed off SESSION_SECRET.
// The 32-byte key is derived lazily (on first encrypt/decrypt) via SHA-256 of
// SESSION_SECRET, so module load order vs. dotenv side-effects doesn't matter.
// Format produced by encrypt(): "<iv_hex>:<authTag_hex>:<ciphertext_hex>".
//
// Portfolio-grade. Production would use a proper KMS so the master key never
// lives in plaintext env vars.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — recommended for GCM

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('[crypto] SESSION_SECRET must be set to use encrypt/decrypt');
  }
  cachedKey = crypto.createHash('sha256').update(secret).digest();
  return cachedKey;
}

export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decrypt(payload) {
  if (payload == null) return null;
  const [ivHex, tagHex, ctHex] = String(payload).split(':');
  if (!ivHex || !tagHex || !ctHex) {
    throw new Error('[crypto] malformed encrypted payload');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
