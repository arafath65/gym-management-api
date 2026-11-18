'use strict';

const crypto = require('node:crypto');

const keyFromEnvironment = (name) => {
  const value = process.env[name];

  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    const error = new Error(`${name} is not configured correctly.`);
    error.code = 'MEMBER_NIC_KEY_NOT_CONFIGURED';
    throw error;
  }

  return Buffer.from(value, 'hex');
};

const parseSriLankanNic = (value) => {
  if (typeof value !== 'string') return null;

  const normalized = value.replace(/[\s-]/g, '').toUpperCase();

  if (/^\d{9}[VX]$/.test(normalized)) {
    return {
      normalized,
      type: 'old',
      last4: normalized.slice(-4),
    };
  }

  if (/^\d{12}$/.test(normalized)) {
    return {
      normalized,
      type: 'new',
      last4: normalized.slice(-4),
    };
  }

  return null;
};

const isLeapYear = (year) =>
  year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);

const dateFromDayOfYear = (year, dayOfYear) => {
  if (
    !Number.isInteger(dayOfYear) ||
    dayOfYear < 1 ||
    dayOfYear > 366
  ) {
    return null;
  }

  // NIC day numbers use a fixed leap-year reference calendar.
  const referenceDate = new Date(Date.UTC(2000, 0, dayOfYear));
  const month = referenceDate.getUTCMonth();
  const day = referenceDate.getUTCDate();

  // February 29 is invalid in a non-leap birth year.
  if (month === 1 && day === 29 && !isLeapYear(year)) {
    return null;
  }

  const date = new Date(Date.UTC(year, month, day));
  const dateString = date.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  if (dateString > today) return null;

  return dateString;
};
const decodeSriLankanNic = (value) => {
  const nic = parseSriLankanNic(value);

  if (!nic) {
    const error = new Error('Invalid Sri Lankan NIC format.');
    error.code = 'INVALID_SRI_LANKAN_NIC';
    throw error;
  }

  const digits = nic.normalized.replace(/[VX]$/, '');

  let dayOfYear;
  let years;

  if (nic.type === 'old') {
    const twoDigitYear = Number(digits.slice(0, 2));
    dayOfYear = Number(digits.slice(2, 5));

    const currentYear = new Date().getUTCFullYear();

    years = [
      1900 + twoDigitYear,
      2000 + twoDigitYear,
    ].filter((year) =>
      year <= currentYear && year >= currentYear - 125
    );
  } else {
    const year = Number(digits.slice(0, 4));
    dayOfYear = Number(digits.slice(4, 7));

    years = [year];
  }

  const isFemale = dayOfYear > 500;

  if (isFemale) {
    dayOfYear -= 500;
  }

  const candidates = years
    .map((year) => dateFromDayOfYear(year, dayOfYear))
    .filter(Boolean)
    .sort();

  if (candidates.length === 0) {
    const error = new Error('NIC does not contain a valid birth date.');
    error.code = 'INVALID_SRI_LANKAN_NIC_DATE';
    throw error;
  }

  return {
    type: nic.type,
    gender: isFemale ? 'female' : 'male',
    dateOfBirthCandidates: candidates,
    requiresCenturyConfirmation:
      nic.type === 'old' && candidates.length > 1,
  };
};

const normalizeSriLankanPhone = (value) => {
  if (value == null) return null;

  const digits = String(value).replace(/\D/g, '');

  if (!digits) return null;

  if (/^0\d{9}$/.test(digits)) {
    return `94${digits.slice(1)}`;
  }

  if (/^94\d{9}$/.test(digits)) {
    return digits;
  }

  return digits;
};

const createNicLookupHash = (value) => {
  const nic = parseSriLankanNic(value);

  if (!nic) {
    const error = new Error('Invalid Sri Lankan NIC format.');
    error.code = 'INVALID_SRI_LANKAN_NIC';
    throw error;
  }

  return crypto
    .createHmac('sha256', keyFromEnvironment('MEMBER_NIC_LOOKUP_SECRET'))
    .update(nic.normalized, 'utf8')
    .digest();
};

const encryptSriLankanNic = (value) => {
  const nic = parseSriLankanNic(value);

  if (!nic) {
    const error = new Error('Invalid Sri Lankan NIC format.');
    error.code = 'INVALID_SRI_LANKAN_NIC';
    throw error;
  }

  const key = keyFromEnvironment('MEMBER_NIC_ENCRYPTION_KEY');
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(nic.normalized, 'utf8'),
    cipher.final(),
  ]);

  return {
    nicType: nic.type,
    nicCiphertext: ciphertext,
    nicIv: iv,
    nicAuthTag: cipher.getAuthTag(),
    nicLookupHash: createNicLookupHash(nic.normalized),
    nicLast4: nic.last4,
  };
};

const decryptSriLankanNic = (record) => {
  if (!record) throw new Error('Encrypted NIC record is required.');

  const key = keyFromEnvironment('MEMBER_NIC_ENCRYPTION_KEY');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.nic_iv)
  );

  decipher.setAuthTag(Buffer.from(record.nic_auth_tag));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.nic_ciphertext)),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
};

module.exports = {
  parseSriLankanNic,
  decodeSriLankanNic,
  normalizeSriLankanPhone,
  createNicLookupHash,
  encryptSriLankanNic,
  decryptSriLankanNic,
};