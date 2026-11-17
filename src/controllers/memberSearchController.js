'use strict';

const db = require('../config/db');

const {
  parseSriLankanNic,
  createNicLookupHash,
} = require('../services/memberIdentityService');

const MAX_SEARCH_RESULTS = 5;

const escapeLike = (value) =>
  value.replace(/[!%_]/g, (character) => `!${character}`);

const normalizePhoneSearch = (value) => {
  const digits = value.replace(/\D/g, '');

  if (digits.startsWith('0') && digits.length >= 2 && digits.length <= 10) {
    return `94${digits.slice(1)}`;
  }

  return digits;
};

const maskPhone = (value) => {
  if (!value) return null;

  const digits = String(value).replace(/\D/g, '');

  if (!digits) return null;

  if (digits.length <= 4) {
    return '•'.repeat(digits.length);
  }

  return (
    digits.slice(0, 2) +
    '•'.repeat(digits.length - 4) +
    digits.slice(-2)
  );
};

const searchMembers = async (req, res) => {
  try {
    const organizationId = Number(req.gymStaff?.organizationId);

    if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
      return res.status(401).json({
        success: false,
        code: 'GYM_ORGANIZATION_CONTEXT_REQUIRED',
        message: 'A valid Gym Staff organization session is required.',
      });
    }

    const search =
      typeof req.query.q === 'string'
        ? req.query.q.trim()
        : typeof req.query.search === 'string'
          ? req.query.search.trim()
          : '';

    if (search.length < 2) {
      return res.status(400).json({
        success: false,
        code: 'MEMBER_SEARCH_QUERY_TOO_SHORT',
        message: 'Enter at least 2 characters to search members.',
      });
    }

    if (search.length > 100) {
      return res.status(400).json({
        success: false,
        code: 'MEMBER_SEARCH_QUERY_TOO_LONG',
        message: 'Search must not exceed 100 characters.',
      });
    }

    const nic = parseSriLankanNic(search);

    // NIC lookup is exact and uses the same HMAC key used by registration.
    // Partial NIC fragments are deliberately not searchable.
    const nicHash = nic ? createNicLookupHash(nic.normalized) : null;

    const phoneSearch = normalizePhoneSearch(search);
    const likeSearch = `%${escapeLike(search)}%`;

    const matchConditions = ['full_name LIKE ? ESCAPE \'!\''];
    const matchParams = [likeSearch];

    if (phoneSearch.length >= 3) {
      matchConditions.push(
        'phone_primary_normalized LIKE ?',
        'phone_secondary_normalized LIKE ?'
      );

      matchParams.push(
        `%${phoneSearch}%`,
        `%${phoneSearch}%`
      );
    }

    if (nicHash) {
      matchConditions.push('nic_lookup_hash = ?');
      matchParams.push(nicHash);
    }

    const [rows] = await db.query(
      `SELECT
         id,
         member_code,
         nic_type,
         nic_last4,
         full_name,
         phone_primary,
         phone_secondary,
         status,
         admission_fee_status,
         created_at
       FROM members
       WHERE organization_id = ?
         AND (${matchConditions.join(' OR ')})
       ORDER BY
         CASE WHEN nic_lookup_hash = ? THEN 0 ELSE 1 END,
         CASE
           WHEN phone_primary_normalized = ?
             OR phone_secondary_normalized = ?
           THEN 0 ELSE 1
         END,
         full_name ASC,
         id DESC
       LIMIT 5`,
      [
        organizationId,
        ...matchParams,
        nicHash || Buffer.alloc(32, 0),
        phoneSearch,
        phoneSearch,
      ]
    );

    const members = rows.map((row) => ({
      id: Number(row.id),
      member_code: row.member_code,
      full_name: row.full_name,
      nic_type: row.nic_type,
      nic_masked: row.nic_last4
        ? `••••••••${row.nic_last4}`
        : null,
      phone_primary_masked: maskPhone(row.phone_primary),
      phone_secondary_masked: maskPhone(row.phone_secondary),
      status: row.status,
      admission_fee_status: row.admission_fee_status,
      created_at: row.created_at,
    }));

    return res.json({
      success: true,
      members,
      count: members.length,
      limit: MAX_SEARCH_RESULTS,
    });
  } catch (error) {
    if (error.code === 'MEMBER_NIC_KEY_NOT_CONFIGURED') {
      return res.status(503).json({
        success: false,
        code: error.code,
        message: 'Member NIC search is not configured securely.',
      });
    }

    console.error('Member search error:', error.message);

    return res.status(500).json({
      success: false,
      code: 'MEMBER_SEARCH_SERVER_ERROR',
      message: 'Unable to search members.',
    });
  }
};

module.exports = {
  searchMembers,
};