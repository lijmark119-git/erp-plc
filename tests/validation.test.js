import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isValidBusinessCode,
  isValidEmail,
  isValidEmployeeNumber,
  isValidGender,
  isValidISODate,
  isValidNationalId,
  isValidPersonName,
  isValidPhone,
} from '../validation.js';

test('accepts valid ISO calendar dates and rejects normalized or malformed dates', () => {
  assert.equal(isValidISODate('2024-02-29'), true);
  assert.equal(isValidISODate('2025-02-29'), false);
  assert.equal(isValidISODate('2026-04-31'), false);
  assert.equal(isValidISODate('2026-4-01'), false);
});

test('accepts formatted international phone numbers and rejects letters or invalid lengths', () => {
  assert.equal(isValidPhone('+251 91 234 5678'), true);
  assert.equal(isValidPhone('(091) 234-5678'), true);
  assert.equal(isValidPhone(''), true);
  assert.equal(isValidPhone('091ABC5678'), false);
  assert.equal(isValidPhone('12345'), false);
});

test('accepts digit-only employee numbers and rejects letters', () => {
  assert.equal(isValidEmployeeNumber('20260001'), true);
  assert.equal(isValidEmployeeNumber(' 0007 '), true);
  assert.equal(isValidEmployeeNumber('EMP-2026-001'), false);
  assert.equal(isValidEmployeeNumber(''), false);
});

test('accepts international person names and rejects digits or symbols', () => {
  assert.equal(isValidPersonName('Selam Tadesse'), true);
  assert.equal(isValidPersonName("Anne-Marie O'Neil"), true);
  assert.equal(isValidPersonName('ሰላም ተደሰ'), true);
  assert.equal(isValidPersonName('Selam2'), false);
  assert.equal(isValidPersonName('@@'), false);
});

test('validates gender choices, numeric national IDs, emails, and business codes', () => {
  assert.equal(isValidGender('Female'), true);
  assert.equal(isValidGender('9'), false);
  assert.equal(isValidNationalId('123456789012'), true);
  assert.equal(isValidNationalId('NID-123456789'), false);
  assert.equal(isValidEmail('employee@plc.local'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidBusinessCode('MT-100'), true);
  assert.equal(isValidBusinessCode('   '), false);
});