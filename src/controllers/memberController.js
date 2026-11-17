'use strict';

const db = require('../config/db');

const {
  parseSriLankanNic,
  decodeSriLankanNic,
  normalizeSriLankanPhone,
  createNicLookupHash,
  encryptSriLankanNic,
} = require('../services/memberIdentityService');

const ALLOWED_FIELDS = new Set([
  'nic',
  'full_name',
  'date_of_birth',
  'date_of_birth_confirmed',
  'gender',
  'phone_primary',
  'phone_secondary',
  'email',
  'address',
  'city',
  'emergency_contact_name',
  'emergency_contact_relationship',
  'emergency_contact_phone',
  'preferred_branch_id',
  'registration_source',
  'referred_by',
  'admission_fee_amount',
  'admission_fee_currency',
  'admission_fee_waived',
]);

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const normalizeText = (value, label, maximumLength, errors) => {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value !== 'string') {
    errors.push(`${label} must be text.`);
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length > maximumLength) {
    errors.push(`${label} must not exceed ${maximumLength} characters.`);
    return null;
  }

  return trimmed || null;
};

const parseDateOnly = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }

  if (value > new Date().toISOString().slice(0, 10)) {
    return null;
  }

  return value;
};

const normalizePhoneField = (value, label, errors) => {
  const raw = normalizeText(value, label, 30, errors);

  if (!raw) {
    return {
      raw: null,
      normalized: null,
    };
  }

  if (!/^[+\d\s().-]+$/.test(raw)) {
    errors.push(`${label} contains invalid characters.`);
    return { raw: null, normalized: null };
  }

  const normalized = normalizeSriLankanPhone(raw);

  if (!normalized || normalized.length < 7 || normalized.length > 15) {
    errors.push(`${label} must contain a valid phone number.`);
    return { raw: null, normalized: null };
  }

  return { raw, normalized };
};

const parseMoney = (value) => {
  if (value === undefined || value === null || value === '') {
    return '0.00';
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const raw = String(value).trim();

  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) {
    return null;
  }

  const [whole, fraction = ''] = raw.split('.');
  return `${String(Number(whole))}.${fraction.padEnd(2, '0')}`;
};

const maskPhone = (value) => {
  if (!value) return null;

  const digits = String(value).replace(/\D/g, '');

  if (digits.length <= 4) {
    return '•'.repeat(digits.length);
  }

  return `${digits.slice(0, 3)}${'•'.repeat(Math.max(1, digits.length - 5))}${digits.slice(-2)}`;
};

const dateToString = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

const getMemberResponse = (row) => ({
  id: Number(row.id),
  member_code: row.member_code,
  full_name: row.full_name,
  nic_type: row.nic_type,
  nic_masked: row.nic_last4
    ? `••••••••${row.nic_last4}`
    : null,
  date_of_birth: dateToString(row.date_of_birth),
  date_of_birth_source: row.date_of_birth_source,
  date_of_birth_confirmed: Boolean(row.date_of_birth_confirmed),
  gender: row.gender,
  phone_primary_masked: maskPhone(row.phone_primary),
  phone_secondary_masked: maskPhone(row.phone_secondary),
  email: row.email,
  city: row.city,
  status: row.status,
  registration_branch_id: Number(row.registration_branch_id),
  preferred_branch_id: row.preferred_branch_id == null
    ? null
    : Number(row.preferred_branch_id),
  registration_source: row.registration_source,
  admission_fee_status: row.admission_fee_status,
  admission_fee_amount: String(row.admission_fee_amount),
  admission_fee_currency: row.admission_fee_currency,
  created_at: row.created_at,
});

const rollbackResponse = async (
  connection,
  res,
  statusCode,
  code,
  message,
  additional = {}
) => {
  await connection.rollback();

  return res.status(statusCode).json({
    success: false,
    code,
    message,
    ...additional,
  });
};

const writeMemberAuditLog = async (connection, req, member) => {
  const organizationId = Number(req.gymStaff.organizationId);
  const userId = Number(req.gymStaff.userId);
  const branchId = Number(req.gymStaff.branchId);

  const safeValues = {
    member_code: member.member_code,
    status: member.status,
    registration_branch_id: member.registration_branch_id,
    preferred_branch_id: member.preferred_branch_id,
    admission_fee_status: member.admission_fee_status,
    admission_fee_amount: String(member.admission_fee_amount),
    admission_fee_currency: member.admission_fee_currency,
    nic_type: member.nic_type,
    nic_last4: member.nic_last4,
  };

  await connection.query(
    `INSERT INTO audit_logs
      (
        organization_id,
        branch_id,
        user_id,
        action,
        entity_type,
        entity_id,
        description,
        ip_address,
        user_agent
      )
     VALUES (?, ?, ?, 'MEMBER_REGISTERED', 'member', ?, ?, ?, ?)`,
    [
      organizationId,
      branchId,
      userId,
      member.id,
      `Registered member ${member.member_code} | new_values=${JSON.stringify(safeValues)}`,
      req.ip || null,
      req.get('user-agent')
        ? req.get('user-agent').substring(0, 500)
        : null,
    ]
  );
};

const createMember = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(req.gymStaff?.organizationId);
    const userId = Number(req.gymStaff?.userId);
    const branchId = Number(req.gymStaff?.branchId);

    if (
      !Number.isSafeInteger(organizationId) || organizationId <= 0 ||
      !Number.isSafeInteger(userId) || userId <= 0 ||
      !Number.isSafeInteger(branchId) || branchId <= 0
    ) {
      return res.status(401).json({
        success: false,
        code: 'MEMBER_SESSION_CONTEXT_REQUIRED',
        message: 'A valid Gym Staff session and active branch are required.',
      });
    }

    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MEMBER_REQUEST',
        message: 'Request body must be a valid object.',
      });
    }

    const unknownFields = Object.keys(body).filter(
      (key) => !ALLOWED_FIELDS.has(key)
    );

    if (unknownFields.length > 0) {
      return res.status(400).json({
        success: false,
        code: 'UNSUPPORTED_MEMBER_FIELDS',
        message: `Unsupported field(s): ${unknownFields.join(', ')}`,
      });
    }

    const errors = [];

    const fullName = normalizeText(
      body.full_name,
      'Full name',
      150,
      errors
    );

    if (!fullName) {
      errors.push('Full name is required.');
    }

    const email = normalizeText(body.email, 'Email', 150, errors);

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Email address is invalid.');
    }

    const address = normalizeText(body.address, 'Address', 5000, errors);
    const city = normalizeText(body.city, 'City', 100, errors);

    const emergencyContactName = normalizeText(
      body.emergency_contact_name,
      'Emergency contact name',
      150,
      errors
    );

    const emergencyContactRelationship = normalizeText(
      body.emergency_contact_relationship,
      'Emergency contact relationship',
      80,
      errors
    );

    const referredBy = normalizeText(
      body.referred_by,
      'Referred by',
      150,
      errors
    );

    const primaryPhone = normalizePhoneField(
      body.phone_primary,
      'Primary phone',
      errors
    );

    const secondaryPhone = normalizePhoneField(
      body.phone_secondary,
      'Secondary phone',
      errors
    );

    const emergencyPhone = normalizePhoneField(
      body.emergency_contact_phone,
      'Emergency contact phone',
      errors
    );

    const registrationSource =
      body.registration_source === undefined
        ? 'walk_in'
        : body.registration_source;

    if (!['walk_in', 'referral', 'facebook', 'website', 'other'].includes(registrationSource)) {
      errors.push('Registration source is invalid.');
    }

    const genderInput = body.gender;

    if (
      genderInput !== undefined &&
      !['male', 'female', 'other', 'not_specified'].includes(genderInput)
    ) {
      errors.push('Gender must be male, female, other or not_specified.');
    }

    if (
      body.date_of_birth_confirmed !== undefined &&
      typeof body.date_of_birth_confirmed !== 'boolean'
    ) {
      errors.push('date_of_birth_confirmed must be true or false.');
    }

    const dobConfirmed = body.date_of_birth_confirmed === true;
    const dobProvided =
      body.date_of_birth !== undefined &&
      body.date_of_birth !== null &&
      body.date_of_birth !== '';

    let dateOfBirth = null;

    if (dobProvided) {
      dateOfBirth = parseDateOnly(body.date_of_birth);

      if (!dateOfBirth) {
        errors.push('Date of birth must be a valid date in YYYY-MM-DD format and cannot be in the future.');
      }
    }

    if (dobConfirmed && !dobProvided) {
      errors.push('A date of birth is required when it is marked as confirmed.');
    }

    const admissionAmount = parseMoney(body.admission_fee_amount);

    if (admissionAmount === null) {
      errors.push('Admission fee must be a non-negative amount with up to two decimal places.');
    }

    const admissionCurrency =
      body.admission_fee_currency === undefined ||
      body.admission_fee_currency === ''
        ? 'LKR'
        : body.admission_fee_currency;

    if (
      typeof admissionCurrency !== 'string' ||
      !/^[A-Za-z]{3}$/.test(admissionCurrency.trim())
    ) {
      errors.push('Admission fee currency must contain exactly three letters.');
    }

    const admissionWaived =
      body.admission_fee_waived === undefined
        ? false
        : body.admission_fee_waived;

    if (typeof admissionWaived !== 'boolean') {
      errors.push('admission_fee_waived must be true or false.');
    }

    const preferredBranchId =
      body.preferred_branch_id === undefined ||
      body.preferred_branch_id === null ||
      body.preferred_branch_id === ''
        ? null
        : parsePositiveId(body.preferred_branch_id);

    if (
      body.preferred_branch_id !== undefined &&
      body.preferred_branch_id !== null &&
      body.preferred_branch_id !== '' &&
      preferredBranchId === null
    ) {
      errors.push('Preferred branch ID is invalid.');
    }

    if (preferredBranchId !== null) {
      const accessibleBranches = Array.isArray(req.gymStaff.branches)
        ? req.gymStaff.branches
        : [];

      const hasAccess = accessibleBranches.some(
        (branch) => Number(branch.id) === preferredBranchId
      );

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          code: 'MEMBER_PREFERRED_BRANCH_ACCESS_DENIED',
          message: 'You do not have access to the selected preferred branch.',
        });
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MEMBER_DETAILS',
        message: 'Please correct the member details.',
        errors,
      });
    }

    // NIC is optional. When supplied, validate, decode and encrypt it
    // before opening a database transaction.
    let nicDetails = null;
    let encryptedNic = null;

    const nicInput =
      body.nic === undefined || body.nic === null
        ? ''
        : body.nic;

    if (typeof nicInput !== 'string') {
      return res.status(400).json({
        success: false,
        code: 'INVALID_SRI_LANKAN_NIC',
        message: 'NIC must be text.',
      });
    }

    if (nicInput.trim()) {
      const nic = parseSriLankanNic(nicInput);

      if (!nic) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_SRI_LANKAN_NIC',
          message: 'Enter a valid old or new Sri Lankan NIC.',
        });
      }

      nicDetails = decodeSriLankanNic(nic.normalized);
      encryptedNic = encryptSriLankanNic(nic.normalized);
    }

    let dobSource = dateOfBirth ? 'manual' : null;

    if (nicDetails) {
      const candidates = nicDetails.dateOfBirthCandidates;
      const matchesNicDate = dateOfBirth
        ? candidates.includes(dateOfBirth)
        : false;

      if (!dateOfBirth && nicDetails.requiresCenturyConfirmation) {
        return res.status(422).json({
          success: false,
          code: 'MEMBER_DOB_CENTURY_CONFIRMATION_REQUIRED',
          message: 'This old NIC has more than one possible birth year. Select and confirm the correct date of birth.',
          date_of_birth_candidates: candidates,
        });
      }

      if (
        nicDetails.requiresCenturyConfirmation &&
        (!dateOfBirth || !dobConfirmed)
      ) {
        return res.status(422).json({
          success: false,
          code: 'MEMBER_DOB_CENTURY_CONFIRMATION_REQUIRED',
          message: 'Confirm the correct century and date of birth before registering this member.',
          date_of_birth_candidates: candidates,
        });
      }

      if (
        dateOfBirth &&
        !matchesNicDate &&
        !dobConfirmed
      ) {
        return res.status(422).json({
          success: false,
          code: 'MEMBER_DOB_MANUAL_CONFIRMATION_REQUIRED',
          message: 'The entered date of birth differs from the NIC decoded date. Confirm the manually entered date.',
          date_of_birth_candidates: candidates,
        });
      }

      if (!dateOfBirth) {
        dateOfBirth = candidates[0];
        dobSource = 'nic_decoded';
      } else if (matchesNicDate) {
        dobSource = 'nic_decoded';
      } else {
        dobSource = 'manual';
      }
    }

    const gender =
      genderInput === undefined
        ? nicDetails?.gender || 'not_specified'
        : genderInput;

    const admissionFeeStatus = admissionWaived
      ? 'waived'
      : Number(admissionAmount) > 0
        ? 'pending'
        : 'not_charged';

    const normalizedAdmissionCurrency = admissionCurrency.trim().toUpperCase();

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    // Lock the organization row to serialize member-code generation.
    const [organizations] = await connection.query(
      `SELECT id, status
       FROM organizations
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId]
    );

    if (organizations.length === 0) {
      return await rollbackResponse(
        connection, res, 404,
        'ORGANIZATION_NOT_FOUND',
        'Organization not found.'
      );
    }

    if (organizations[0].status !== 'active') {
      return await rollbackResponse(
        connection, res, 403,
        'ORGANIZATION_INACTIVE',
        'Cannot register members for an inactive organization.'
      );
    }

    // Registration branch comes only from the authenticated active session.
    const [branches] = await connection.query(
      `SELECT id, name, status
       FROM branches
       WHERE organization_id = ?
         AND id = ?
         AND status = 'active'
       LIMIT 1
       FOR UPDATE`,
      [organizationId, branchId]
    );

    if (branches.length === 0) {
      return await rollbackResponse(
        connection, res, 403,
        'MEMBER_REGISTRATION_BRANCH_INVALID',
        'Your active branch is not available for member registration.'
      );
    }

    if (preferredBranchId !== null) {
      const [preferredBranches] = await connection.query(
        `SELECT id
         FROM branches
         WHERE organization_id = ?
           AND id = ?
           AND status = 'active'
         LIMIT 1`,
        [organizationId, preferredBranchId]
      );

      if (preferredBranches.length === 0) {
        return await rollbackResponse(
          connection, res, 400,
          'MEMBER_PREFERRED_BRANCH_INVALID',
          'The preferred branch is not active in this organization.'
        );
      }
    }

    // Check NIC duplication within this organization.
    // The unique index remains the final protection against concurrent requests.
    if (encryptedNic) {
      const [existingMembers] = await connection.query(
        `SELECT id, member_code, full_name, status
         FROM members
         WHERE organization_id = ?
           AND nic_lookup_hash = ?
         LIMIT 1
         FOR UPDATE`,
        [organizationId, encryptedNic.nicLookupHash]
      );

      if (existingMembers.length > 0) {
        return await rollbackResponse(
          connection, res, 409,
          'MEMBER_NIC_ALREADY_REGISTERED',
          'A member with this NIC already exists. Search for the existing member instead of registering a duplicate.'
        );
      }
    }

    // MBR-000001, MBR-000002, etc.
    const [sequenceRows] = await connection.query(
      `SELECT
         COALESCE(
           MAX(CAST(SUBSTRING(member_code, 5) AS UNSIGNED)),
           0
         ) + 1 AS next_number
       FROM members
       WHERE organization_id = ?
         AND member_code REGEXP '^MBR-[0-9]+$'`,
      [organizationId]
    );

    const nextNumber = Number(sequenceRows[0].next_number);

    if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) {
      throw new Error('Unable to generate the next member code.');
    }

    const memberCode = `MBR-${String(nextNumber).padStart(6, '0')}`;

    const [insertResult] = await connection.query(
      `INSERT INTO members
        (
          organization_id,
          member_code,
          nic_type,
          nic_ciphertext,
          nic_iv,
          nic_auth_tag,
          nic_lookup_hash,
          nic_last4,
          full_name,
          date_of_birth,
          date_of_birth_source,
          date_of_birth_confirmed,
          gender,
          phone_primary,
          phone_primary_normalized,
          phone_secondary,
          phone_secondary_normalized,
          email,
          address,
          city,
          emergency_contact_name,
          emergency_contact_relationship,
          emergency_contact_phone,
          emergency_contact_phone_normalized,
          registration_branch_id,
          preferred_branch_id,
          registration_source,
          referred_by,
          status,
          admission_fee_status,
          admission_fee_amount,
          admission_fee_currency,
          admission_fee_recorded_at,
          created_by_user_id
        )
       VALUES
        (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          'active',
          ?, ?, ?,
          CASE WHEN ? = 'waived' THEN CURRENT_TIMESTAMP ELSE NULL END,
          ?
        )`,
      [
        organizationId,
        memberCode,
        encryptedNic?.nicType ?? null,
        encryptedNic?.nicCiphertext ?? null,
        encryptedNic?.nicIv ?? null,
        encryptedNic?.nicAuthTag ?? null,
        encryptedNic?.nicLookupHash ?? null,
        encryptedNic?.nicLast4 ?? null,
        fullName,
        dateOfBirth,
        dobSource,
        dobConfirmed,
        gender,
        primaryPhone.raw,
        primaryPhone.normalized,
        secondaryPhone.raw,
        secondaryPhone.normalized,
        email,
        address,
        city,
        emergencyContactName,
        emergencyContactRelationship,
        emergencyPhone.raw,
        emergencyPhone.normalized,
        branchId,
        preferredBranchId,
        registrationSource,
        referredBy,
        admissionFeeStatus,
        admissionAmount,
        normalizedAdmissionCurrency,
        admissionFeeStatus,
        userId,
      ]
    );

    const memberId = Number(insertResult.insertId);

    const [createdRows] = await connection.query(
      `SELECT
         id,
         member_code,
         nic_type,
         nic_last4,
         full_name,
         date_of_birth,
         date_of_birth_source,
         date_of_birth_confirmed,
         gender,
         phone_primary,
         phone_secondary,
         email,
         city,
         status,
         registration_branch_id,
         preferred_branch_id,
         registration_source,
         admission_fee_status,
         admission_fee_amount,
         admission_fee_currency,
         created_at
       FROM members
       WHERE organization_id = ?
         AND id = ?
       LIMIT 1`,
      [organizationId, memberId]
    );

    if (createdRows.length === 0) {
      throw new Error('Member registration could not be confirmed after insertion.');
    }

    const memberRow = createdRows[0];

    // Audit is part of the same transaction as the member insert.
    await writeMemberAuditLog(connection, req, {
      ...memberRow,
      id: memberId,
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Member registered successfully.',
      member: getMemberResponse(memberRow),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Member registration rollback failed:', rollbackError.message);
      }
    }

    if (error.code === 'MEMBER_NIC_KEY_NOT_CONFIGURED') {
      return res.status(503).json({
        success: false,
        code: error.code,
        message: 'NIC encryption is not configured. Contact the system administrator.',
      });
    }

    if (
      error.code === 'INVALID_SRI_LANKAN_NIC' ||
      error.code === 'INVALID_SRI_LANKAN_NIC_DATE'
    ) {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        code: 'MEMBER_DUPLICATE_CONFLICT',
        message: 'A member with this NIC or member code already exists. Search existing members before retrying.',
      });
    }

    if (
      error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' ||
      error.errno === 3819
    ) {
      return res.status(400).json({
        success: false,
        code: 'MEMBER_DATABASE_VALIDATION_FAILED',
        message: 'Member details do not satisfy the database rules.',
      });
    }

    if (
      error.code === 'ER_NO_REFERENCED_ROW_2' ||
      error.code === 'ER_ROW_IS_REFERENCED_2'
    ) {
      return res.status(409).json({
        success: false,
        code: 'MEMBER_REFERENCE_CONFLICT',
        message: 'A referenced branch or staff record is no longer available.',
      });
    }

    console.error('Member registration error:', error.code || error.message);

    return res.status(500).json({
      success: false,
      code: 'MEMBER_REGISTRATION_SERVER_ERROR',
      message: 'Unable to register this member.',
    });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  searchMembers: require('./memberSearchController').searchMembers,
  createMember,
};