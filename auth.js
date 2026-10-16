import crypto from 'node:crypto';

const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_KEY_LENGTH = 64;
const PBKDF2_DIGEST = 'sha256';
const SESSION_ALGORITHM = 'aes-256-gcm';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST).toString('hex');
  return `${PBKDF2_ITERATIONS}:${salt}:${derivedKey}`;
}

export async function verifyPassword(password, storedPassword) {
  if (!storedPassword || typeof storedPassword !== 'string') return false;

  const [iterationsText, salt, expectedKey] = storedPassword.split(':');
  if (!iterationsText || !salt || !expectedKey) return false;

  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  const actualKey = crypto.pbkdf2Sync(password, salt, iterations, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actualKey), Buffer.from(expectedKey));
}

export function createSessionToken(session, secret = process.env.SESSION_SECRET || 'development-only-change-me', ttlSeconds = 28_800) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(SESSION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ ...session, expiresAt }))), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64url');
}

export function verifySessionToken(token, secret = process.env.SESSION_SECRET || 'development-only-change-me', ttlSeconds = 28_800) {
  if (!token || typeof token !== 'string') return null;

  try {
    const key = crypto.createHash('sha256').update(secret).digest();
    const decoded = Buffer.from(token, 'base64url');
    if (decoded.length < 28) return null;

    const iv = decoded.subarray(0, 12);
    const authTag = decoded.subarray(12, 28);
    const encrypted = decoded.subarray(28);
    const decipher = crypto.createDecipheriv(SESSION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const session = JSON.parse(plaintext);

    if (!session.userId || !session.role || !Number.isFinite(session.expiresAt)) return null;
    if (session.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    if (ttlSeconds <= 0) return null;

    return session;
  } catch {
    return null;
  }
}
