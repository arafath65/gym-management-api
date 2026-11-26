'use strict';

const db = require('../config/db');
const { decryptSriLankanNic } = require('../services/memberIdentityService');

const PAGE_SIZE = 25;

const maskNic = (last4) => last4 ? `${'*'.repeat(8)}${last4}` : null;

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

const dateToString = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);

  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return String(value).slice(0, 10);
};

const listMembers = async (req, res) => {
  try {
    // Both IDs come from the verified Gym Staff JWT/session.
    // Never use organisation or branch IDs supplied by the client.
    const organizationId = Number(req.gymStaff?.organizationId);
    const branchId = Number(req.gymStaff?.branchId);

    console.info("[MEMBER-LIST-DEBUG] Request received", {
      organizationId,
      activeBranchId: branchId,
      userId: Number(req.gymStaff?.userId),
      requestedPage: req.query.page ?? 1,
      status: req.query.status ?? "all",
    });

    if (
      !Number.isSafeInteger(organizationId) || organizationId <= 0 ||
      !Number.isSafeInteger(branchId) || branchId <= 0
    ) {
      return res.status(401).json({
        success: false,
        code: 'MEMBER_LIST_SESSION_CONTEXT_REQUIRED',
        message: 'A valid organisation and active branch session are required.',
      });
    }

    const status =
      typeof req.query.status === 'string'
        ? req.query.status.trim().toLowerCase()
        : 'all';

    if (!['all', 'active', 'inactive'].includes(status)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MEMBER_STATUS_FILTER',
        message: 'Status must be all, active or inactive.',
      });
    }

    const requestedPage =
      req.query.page === undefined ? 1 : Number(req.query.page);

    if (
      !Number.isSafeInteger(requestedPage) ||
      requestedPage < 1 ||
      requestedPage > 1000000
    ) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MEMBER_PAGE',
        message: 'Page must be a positive whole number.',
      });
    }

    // All includes active, inactive and blocked members.
    const statusSql = status === 'all' ? '' : ' AND status = ?';
    const countParams = [organizationId, branchId];

    if (status !== 'all') {
      countParams.push(status);
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM members
       WHERE organization_id = ?
         AND registration_branch_id = ?
         ${statusSql}`,
      countParams
    );

    const total = Number(countRows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * PAGE_SIZE;

    const [rows] = await db.query(
      `SELECT
         m.id,
         m.member_code,
         m.nic_type,
         m.nic_last4,
         m.nic_ciphertext,
         m.nic_iv,
         m.nic_auth_tag,
         m.full_name,
         DATE_FORMAT(m.date_of_birth, '%Y-%m-%d') AS date_of_birth,
         m.date_of_birth_source,
         m.date_of_birth_confirmed,
         m.gender,
         m.phone_primary,
         m.phone_secondary,
         m.email,
         m.address,
         m.city,
         m.emergency_contact_name,
         m.emergency_contact_relationship,
         m.emergency_contact_phone,
         m.status,
         m.registration_branch_id,
         m.preferred_branch_id,
         m.registration_source,
         m.referred_by,
         m.admission_fee_status,
         m.admission_fee_amount,
         m.admission_fee_currency,
         m.profile_photo_path,
         m.created_at,
         b.name AS registration_branch_name,
         b.branch_code AS registration_branch_code
       FROM members m
       INNER JOIN branches b
         ON b.organization_id = m.organization_id
        AND b.id = m.registration_branch_id
       WHERE m.organization_id = ?
         AND m.registration_branch_id = ?
         ${status === 'all' ? '' : 'AND m.status = ?'}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ? OFFSET ?`,
      [...countParams, PAGE_SIZE, offset]
    );

    const canRevealNic = (req.gymStaff?.permissions || []).includes('members.update');

    const members = rows.map((row) => ({
      id: Number(row.id),
      member_code: row.member_code,
      full_name: row.full_name,

      nic_type: row.nic_type,
      nic_masked: maskNic(row.nic_last4),
      ...(canRevealNic
        ? { nic: row.nic_ciphertext ? decryptSriLankanNic(row) : null }
        : {}),

      date_of_birth: dateToString(row.date_of_birth),
      date_of_birth_source: row.date_of_birth_source,
      date_of_birth_confirmed: Boolean(row.date_of_birth_confirmed),
      gender: row.gender,

      phone_primary_masked: maskPhone(row.phone_primary),
      phone_secondary_masked: maskPhone(row.phone_secondary),

      email: row.email,
      address: row.address,
      city: row.city,

      emergency_contact_name: row.emergency_contact_name,
      emergency_contact_relationship: row.emergency_contact_relationship,
      emergency_contact_phone_masked: maskPhone(row.emergency_contact_phone),

      status: row.status,

      registration_branch_id: Number(row.registration_branch_id),
      registration_branch_name: row.registration_branch_name,
      registration_branch_code: row.registration_branch_code,

      preferred_branch_id: row.preferred_branch_id == null
        ? null
        : Number(row.preferred_branch_id),

      registration_source: row.registration_source,
      referred_by: row.referred_by,

      admission_fee_status: row.admission_fee_status,
      admission_fee_amount: String(row.admission_fee_amount),
      admission_fee_currency: row.admission_fee_currency,
      has_profile_photo: Boolean(row.profile_photo_path),

      created_at: row.created_at,
    }));

    return res.json({
      success: true,

      context: {
        organization_id: organizationId,
        active_branch_id: branchId,
        active_branch_name: req.gymStaff?.branch?.name ?? null,
      },

      members,

      pagination: {
        page,
        page_size: PAGE_SIZE,
        total,
        total_pages: totalPages,
      },

      filters: {
        status,
      },
    });
  } catch (error) {
    console.error(
      'Member list error:',
      error.code || error.message
    );

    return res.status(500).json({
      success: false,
      code: 'MEMBER_LIST_SERVER_ERROR',
      message: 'Unable to load members for the active branch.',
    });
  }
};

module.exports = {
  listMembers,
};