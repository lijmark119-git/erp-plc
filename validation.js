export function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isValidPhone(value) {
  if (typeof value !== 'string') return false;
  const phone = value.trim();
  if (!phone) return true;
  if (!/^\+?[0-9(). -]+$/.test(phone)) return false;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

export function isValidEmployeeNumber(value) {
  return typeof value === 'string' && /^\d{1,20}$/.test(value.trim());
}

export function isValidPersonName(value) {
  if (typeof value !== 'string') return false;
  const name = value.normalize('NFC').trim();
  return /^[\p{L}\p{M}]+(?:[ .'-][\p{L}\p{M}]+)*\.?$/u.test(name);
}

const GENDER_VALUES = new Set(['Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say']);

export function isValidGender(value) {
  return typeof value === 'string' && GENDER_VALUES.has(value.trim());
}

export function isValidNationalId(value) {
  return typeof value === 'string' && /^\d{6,20}$/.test(value.trim());
}

export function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  return !email || (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

export function isValidBusinessCode(value, maxLength = 80) {
  if (typeof value !== 'string') return false;
  const code = value.trim();
  return code.length > 0 && code.length <= maxLength && /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(code);
}