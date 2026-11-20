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
    return '*'.repeat(digits.length);
  }

  return (
    digits.slice(0, 2) +
    '*'.repeat(digits.length - 4) +
    digits.slice(-2)
  );
};

const searchBillingMembers = async (req, res) => {
  try {
    const organizationId = Number(req.gymStaff?.organizationId);
    const branchId = Number(req.gymStaff?.branchId);

    if (
      !Number.isSafeInteger(organizationId) ||
      organizationId <= 0 ||
      !Number.isSafeInteger(branchId) ||
      branchId <= 0
    ) {
      return res.status(401).json({
        success: false,
        code: 'GYM_ACTIVE_BRANCH_CONTEXT_REQUIRED',
        message: 'A valid Gym Staff organization and active branch are required.',
      });
    }

    const permissions = Array.isArray(req.gymStaff?.permissions)
      ? req.gymStaff.permissions
      : [];

    const canCollectCrossBranch = permissions.includes(
      'member_billing.payments.receive'
    );

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

    // NIC matching is exact and uses the registration HMAC key.
    // Partial NIC fragments are never searched.
    const nicHash = nic
      ? createNicLookupHash(nic.normalized)
      : null;

    const phoneSearch = normalizePhoneSearch(search);
    const likeSearch = `%${escapeLike(search)}%`;

    const matchConditions = [
      "m.full_name LIKE ? ESCAPE '!'",
      "m.member_code LIKE ? ESCAPE '!'",
    ];

    const matchParams = [
      likeSearch,
      likeSearch,
    ];

    if (phoneSearch.length >= 3) {
      matchConditions.push(
        'm.phone_primary_normalized LIKE ?',
        'm.phone_secondary_normalized LIKE ?'
      );

      matchParams.push(
        `%${phoneSearch}%`,
        `%${phoneSearch}%`
      );
    }

    if (nicHash) {
      matchConditions.push('m.nic_lookup_hash = ?');
      matchParams.push(nicHash);
    }

    // Staff with payment-receive permission can search across
    // registration branches. Other permitted billing users are
    // restricted to members registered at their active branch.
    const branchCondition = canCollectCrossBranch
      ? ''
      : 'AND m.registration_branch_id = ?';

    const queryParams = [
      organizationId,
      ...(canCollectCrossBranch ? [] : [branchId]),
      ...matchParams,
      nicHash || Buffer.alloc(32, 0),
      phoneSearch,
      phoneSearch,
    ];

    const [rows] = await db.query(
      `SELECT
         m.id,
         m.registration_branch_id,
         m.member_code,
         m.nic_type,
         m.nic_last4,
         m.full_name,
         m.phone_primary,
         m.phone_secondary,
         m.status,
         m.admission_fee_status,
         m.created_at,
         b.name AS registration_branch_name,
         b.branch_code AS registration_branch_code

       FROM members m

       LEFT JOIN branches b
         ON b.organization_id = m.organization_id
        AND b.id = m.registration_branch_id

       WHERE m.organization_id = ?
         AND m.status = 'active'
         ${branchCondition}
         AND (${matchConditions.join(' OR ')})

       ORDER BY
         CASE WHEN m.nic_lookup_hash = ? THEN 0 ELSE 1 END,
         CASE
           WHEN m.phone_primary_normalized = ?
             OR m.phone_secondary_normalized = ?
           THEN 0 ELSE 1
         END,
         m.full_name ASC,
         m.id DESC

       LIMIT ${MAX_SEARCH_RESULTS}`,
      queryParams
    );

    const members = rows.map((row) => ({
      id: Number(row.id),
      registration_branch_id: row.registration_branch_id == null
        ? null
        : Number(row.registration_branch_id),
      member_code: row.member_code,
      full_name: row.full_name,
      nic_type: row.nic_type,
      nic_masked: row.nic_last4
        ? `********${row.nic_last4}`
        : null,
      phone_primary_masked: maskPhone(row.phone_primary),
      phone_secondary_masked: maskPhone(row.phone_secondary),
      status: row.status,
      admission_fee_status: row.admission_fee_status,
      created_at: row.created_at,
      can_collect_cross_branch: canCollectCrossBranch,
    }));

    return res.json({
      success: true,
      members,
      count: members.length,
      limit: MAX_SEARCH_RESULTS,
      active_branch_id: branchId,
      cross_branch_search_allowed: canCollectCrossBranch,
    });

  } catch (error) {
    if (error.code === 'MEMBER_NIC_KEY_NOT_CONFIGURED') {
      return res.status(503).json({
        success: false,
        code: error.code,
        message: 'Member NIC search is not configured securely.',
      });
    }

    console.error('Billing member search error:', error.message);

    return res.status(500).json({
      success: false,
      code: 'MEMBER_BILLING_MEMBER_SEARCH_FAILED',
      message: 'Unable to search billing members.',
    });
  }
};

module.exports = {
  searchBillingMembers,
};