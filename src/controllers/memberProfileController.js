'use strict';

const db = require('../config/db');
const {
  normalizeSriLankanPhone,
  parseSriLankanNic,
  encryptSriLankanNic,
  decryptSriLankanNic,
} = require('../services/memberIdentityService');
const memberPhotoStorage = require('../services/storage/memberPhotoStorage');
const {
  MemberPhotoValidationError,
  optimizeMemberPhoto,
} = require('../services/storage/memberPhotoProcessor');

const REGISTRATION_SOURCES = new Set([
  'walk_in',
  'referral',
  'friend',
  'facebook',
  'social_media',
  'website',
  'other',
]);

const GENDERS = new Set(['male', 'female', 'other', 'not_specified']);

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const hasOwn = (object, key) =>
  Object.prototype.hasOwnProperty.call(object, key);

const formatDateFromDateObject = (value) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDateOnly = (value) => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }

  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    return undefined;
  }

  const today = formatDateFromDateObject(new Date());
  if (value > today) return undefined;
  return value;
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

const parseMoney = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;

  const raw = String(value).trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) return undefined;

  const [whole, fraction = ''] = raw.split('.');
  return `${String(Number(whole))}.${fraction.padEnd(2, '0')}`;
};

const normalizePhone = (value, label, errors) => {
  const raw = normalizeText(value, label, 30, errors);
  if (!raw) return { raw: null, normalized: null };

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

const maskPhone = (value) => {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length <= 4) return 'â€¢'.repeat(digits.length);
  return `${digits.slice(0, 2)}${'â€¢'.repeat(digits.length - 4)}${digits.slice(-2)}`;
};

const maskNic = (last4) => last4 ? `â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢${last4}` : null;

const getSessionContext = (req) => {
  const organizationId = Number(req.gymStaff?.organizationId);
  const branchId = Number(req.gymStaff?.branchId);
  const userId = Number(req.gymStaff?.userId);

  if (
    !Number.isSafeInteger(organizationId) || organizationId <= 0 ||
    !Number.isSafeInteger(branchId) || branchId <= 0 ||
    !Number.isSafeInteger(userId) || userId <= 0
  ) {
    return null;
  }

  return { organizationId, branchId, userId };
};

const getMemberRow = async (executor, context, memberId, forUpdate = false) => {
  const [rows] = await executor.query(
    `SELECT
       m.*,
       DATE_FORMAT(m.date_of_birth, '%Y-%m-%d') AS date_of_birth_text,
       b.name AS registration_branch_name,
       b.branch_code AS registration_branch_code
     FROM members m
     INNER JOIN branches b
       ON b.organization_id = m.organization_id
      AND b.id = m.registration_branch_id
     WHERE m.organization_id = ?
       AND m.registration_branch_id = ?
       AND m.id = ?
     LIMIT 1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [context.organizationId, context.branchId, memberId]
  );

  return rows[0] || null;
};

const toMemberResponse = (row, { includeNic = false } = {}) => ({
  id: Number(row.id),
  member_code: row.member_code,
  full_name: row.full_name,
  nic_type: row.nic_type,
  ...(includeNic ? { nic: row.nic_ciphertext ? decryptSriLankanNic(row) : null } : {}),
  nic_masked: maskNic(row.nic_last4),
  date_of_birth: row.date_of_birth_text ?? null,
  date_of_birth_source: row.date_of_birth_source,
  date_of_birth_confirmed: Boolean(row.date_of_birth_confirmed),
  gender: row.gender,
  phone_primary: row.phone_primary,
  phone_secondary: row.phone_secondary,
  phone_primary_masked: maskPhone(row.phone_primary),
  phone_secondary_masked: maskPhone(row.phone_secondary),
  email: row.email,
  address: row.address,
  city: row.city,
  emergency_contact_name: row.emergency_contact_name,
  emergency_contact_relationship: row.emergency_contact_relationship,
  emergency_contact_phone: row.emergency_contact_phone,
  emergency_contact_phone_masked: maskPhone(row.emergency_contact_phone),
  registration_branch_id: Number(row.registration_branch_id),
  registration_branch_name: row.registration_branch_name,
  registration_branch_code: row.registration_branch_code,
  preferred_branch_id: row.preferred_branch_id == null
    ? null
    : Number(row.preferred_branch_id),
  registration_source: row.registration_source,
  referred_by: row.referred_by,
  status: row.status,
  admission_fee_status: row.admission_fee_status,
  admission_fee_amount: String(row.admission_fee_amount),
  admission_fee_currency: row.admission_fee_currency,
  has_profile_photo: Boolean(row.profile_photo_path),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const writeMemberAudit = async (connection, req, context, memberId, action, description) => {
  const userAgent = req.get('user-agent');
  await connection.query(
    `INSERT INTO audit_logs
       (organization_id, branch_id, user_id, action, entity_type,
        entity_id, description, ip_address, user_agent)
     VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?)`,
    [
      context.organizationId,
      context.branchId,
      context.userId,
      action,
      memberId,
      description,
      req.ip || null,
      userAgent ? userAgent.substring(0, 500) : null,
    ]
  );
};

const respondMemberNotFound = (res) => res.status(404).json({
  success: false,
  code: 'MEMBER_NOT_FOUND',
  message: 'Member not found in the active branch.',
});

const getMember = async (req, res) => {
  try {
    const context = getSessionContext(req);
    const memberId = parsePositiveId(req.params.memberId);

    if (!context) {
      return res.status(401).json({
        success: false,
        code: 'MEMBER_SESSION_CONTEXT_REQUIRED',
        message: 'A valid Gym Staff session and active branch are required.',
      });
    }
    if (!memberId) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MEMBER_ID',
        message: 'Member ID is invalid.',
      });
    }

    const row = await getMemberRow(db, context, memberId);
    if (!row) return respondMemberNotFound(res);

    return res.json({ success: true, member: toMemberResponse(row, { includeNic: true }) });
  } catch (error) {
    console.error('Get member profile error:', error.code || error.message);
    return res.status(500).json({
      success: false,
      code: 'MEMBER_PROFILE_READ_FAILED',
      message: 'Unable to load this member profile.',
    });
  }
};

const updateMember = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getSessionContext(req);
    const memberId = parsePositiveId(req.params.memberId);

    if (!context) {
      return res.status(401).json({
        success: false,
        code: 'MEMBER_SESSION_CONTEXT_REQUIRED',
        message: 'A valid Gym Staff session and active branch are required.',
      });
    }
    if (!memberId) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MEMBER_ID',
        message: 'Member ID is invalid.',
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

    const allowed = new Set([
      'full_name', 'date_of_birth', 'date_of_birth_confirmed', 'gender',
      'phone_primary', 'phone_secondary', 'email', 'address', 'city',
      'emergency_contact_name', 'emergency_contact_relationship',
      'emergency_contact_phone', 'registration_source', 'referred_by',
      'nic', 'admission_fee_amount', 'admission_fee_currency',
      'admission_fee_waived',
    ]);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) {
      return res.status(400).json({
        success: false,
        code: 'UNSUPPORTED_MEMBER_FIELDS',
        message: `Unsupported field(s): ${unknown.join(', ')}`,
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const oldRow = await getMemberRow(connection, context, memberId, true);
    if (!oldRow) {
      await connection.rollback();
      transactionStarted = false;
      return respondMemberNotFound(res);
    }

    const errors = [];

    // Keep the encrypted NIC tuple intact unless the caller explicitly changes it.
    let nicFields = {
      nic_type: oldRow.nic_type,
      nic_ciphertext: oldRow.nic_ciphertext,
      nic_iv: oldRow.nic_iv,
      nic_auth_tag: oldRow.nic_auth_tag,
      nic_lookup_hash: oldRow.nic_lookup_hash,
      nic_last4: oldRow.nic_last4,
    };
    let nicChanged = false;

    if (hasOwn(body, 'nic')) {
      if (body.nic !== null && typeof body.nic !== 'string') {
        errors.push('NIC must be text.');
      } else {
        const nicInput = (body.nic ?? '').trim();
        if (!nicInput) {
          nicChanged = Boolean(oldRow.nic_ciphertext);
          nicFields = {
            nic_type: null,
            nic_ciphertext: null,
            nic_iv: null,
            nic_auth_tag: null,
            nic_lookup_hash: null,
            nic_last4: null,
          };
        } else {
          const parsedNic = parseSriLankanNic(nicInput);
          if (!parsedNic) {
            errors.push('Enter a valid old or new Sri Lankan NIC.');
          } else {
            const existingNic = oldRow.nic_ciphertext
              ? decryptSriLankanNic(oldRow)
              : null;
            if (parsedNic.normalized !== existingNic) {
              const encrypted = encryptSriLankanNic(parsedNic.normalized);
              nicChanged = true;
              nicFields = {
                nic_type: encrypted.nicType,
                nic_ciphertext: encrypted.nicCiphertext,
                nic_iv: encrypted.nicIv,
                nic_auth_tag: encrypted.nicAuthTag,
                nic_lookup_hash: encrypted.nicLookupHash,
                nic_last4: encrypted.nicLast4,
              };
            }
          }
        }
      }
    }

    const fullName = hasOwn(body, 'full_name')
      ? normalizeText(body.full_name, 'Full name', 150, errors)
      : oldRow.full_name;
    if (!fullName) errors.push('Full name is required.');

    let dateOfBirth = oldRow.date_of_birth_text;
    if (hasOwn(body, 'date_of_birth')) {
      dateOfBirth = parseDateOnly(body.date_of_birth);
      if (dateOfBirth === undefined) {
        errors.push('Date of birth must be a valid date in YYYY-MM-DD format and cannot be in the future.');
      }
    }

    let dobConfirmed = Boolean(oldRow.date_of_birth_confirmed);
    if (hasOwn(body, 'date_of_birth_confirmed')) {
      if (typeof body.date_of_birth_confirmed !== 'boolean') {
        errors.push('date_of_birth_confirmed must be true or false.');
      } else {
        dobConfirmed = body.date_of_birth_confirmed;
      }
    }

    let gender = oldRow.gender;
    if (hasOwn(body, 'gender')) {
      gender = body.gender === '' ? null : body.gender;
      if (gender !== null && !GENDERS.has(gender)) {
        errors.push('Gender is invalid.');
      }
    }

    const phonePrimary = hasOwn(body, 'phone_primary')
      ? normalizePhone(body.phone_primary, 'Primary phone', errors)
      : { raw: oldRow.phone_primary, normalized: oldRow.phone_primary_normalized };
    const phoneSecondary = hasOwn(body, 'phone_secondary')
      ? normalizePhone(body.phone_secondary, 'Secondary phone', errors)
      : { raw: oldRow.phone_secondary, normalized: oldRow.phone_secondary_normalized };
    const emergencyPhone = hasOwn(body, 'emergency_contact_phone')
      ? normalizePhone(body.emergency_contact_phone, 'Emergency contact phone', errors)
      : { raw: oldRow.emergency_contact_phone, normalized: oldRow.emergency_contact_phone_normalized };

    const email = hasOwn(body, 'email')
      ? normalizeText(body.email, 'Email', 150, errors)
      : oldRow.email;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Email address is invalid.');
    }

    const address = hasOwn(body, 'address')
      ? normalizeText(body.address, 'Address', 5000, errors)
      : oldRow.address;
    const city = hasOwn(body, 'city')
      ? normalizeText(body.city, 'City', 100, errors)
      : oldRow.city;
    const emergencyName = hasOwn(body, 'emergency_contact_name')
      ? normalizeText(body.emergency_contact_name, 'Emergency contact name', 150, errors)
      : oldRow.emergency_contact_name;
    const emergencyRelationship = hasOwn(body, 'emergency_contact_relationship')
      ? normalizeText(body.emergency_contact_relationship, 'Emergency contact relationship', 80, errors)
      : oldRow.emergency_contact_relationship;
    const referredBy = hasOwn(body, 'referred_by')
      ? normalizeText(body.referred_by, 'Referred by', 150, errors)
      : oldRow.referred_by;

    const registrationSource = hasOwn(body, 'registration_source')
      ? body.registration_source
      : oldRow.registration_source;
    if (!REGISTRATION_SOURCES.has(registrationSource)) {
      errors.push('Registration source is invalid.');
    }

    let admissionFeeAmount = String(oldRow.admission_fee_amount);
    if (hasOwn(body, 'admission_fee_amount')) {
      const parsedAmount = parseMoney(body.admission_fee_amount);
      if (parsedAmount === undefined) {
        errors.push('Admission fee must be a non-negative amount with up to two decimal places.');
      } else {
        admissionFeeAmount = parsedAmount ?? '0.00';
      }
    }

    let admissionFeeCurrency = oldRow.admission_fee_currency;
    if (hasOwn(body, 'admission_fee_currency')) {
      if (
        typeof body.admission_fee_currency !== 'string' ||
        !/^[A-Za-z]{3}$/.test(body.admission_fee_currency.trim())
      ) {
        errors.push('Admission fee currency must contain exactly three letters.');
      } else {
        admissionFeeCurrency = body.admission_fee_currency.trim().toUpperCase();
      }
    }

    let admissionFeeWaived = oldRow.admission_fee_status === 'waived';
    if (hasOwn(body, 'admission_fee_waived')) {
      if (typeof body.admission_fee_waived !== 'boolean') {
        errors.push('admission_fee_waived must be true or false.');
      } else {
        admissionFeeWaived = body.admission_fee_waived;
      }
    }

    let admissionFeeStatus = oldRow.admission_fee_status;
    if (oldRow.admission_fee_status === 'paid') {
      if (admissionFeeWaived) {
        errors.push('An admission fee already marked paid cannot be waived here.');
      }
      admissionFeeStatus = 'paid';
    } else if (admissionFeeWaived) {
      admissionFeeStatus = 'waived';
    } else if (
      oldRow.admission_fee_status === 'waived' ||
      oldRow.admission_fee_status === 'pending' ||
      oldRow.admission_fee_status === 'not_charged'
    ) {
      admissionFeeStatus = Number(admissionFeeAmount) > 0 ? 'pending' : 'not_charged';
    }

    if (errors.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(400).json({
        success: false,
        code: 'INVALID_MEMBER_DETAILS',
        message: 'Please correct the member details.',
        errors,
      });
    }

    if (nicChanged && nicFields.nic_lookup_hash) {
      const [duplicateNicRows] = await connection.query(
        `SELECT id
         FROM members
         WHERE organization_id = ?
           AND nic_lookup_hash = ?
           AND id <> ?
         LIMIT 1`,
        [context.organizationId, nicFields.nic_lookup_hash, memberId]
      );

      if (duplicateNicRows.length > 0) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(409).json({
          success: false,
          code: 'MEMBER_DUPLICATE_NIC',
          message: 'This NIC is already registered to another member in this organization.',
        });
      }
    }

    const dobSource = dateOfBirth === null
      ? null
      : dateOfBirth === oldRow.date_of_birth_text
        ? oldRow.date_of_birth_source
        : 'manual';

    await connection.query(
      `UPDATE members
       SET nic_type = ?,
           nic_ciphertext = ?,
           nic_iv = ?,
           nic_auth_tag = ?,
           nic_lookup_hash = ?,
           nic_last4 = ?,
           full_name = ?,
           date_of_birth = ?,
           date_of_birth_source = ?,
           date_of_birth_confirmed = ?,
           gender = ?,
           phone_primary = ?,
           phone_primary_normalized = ?,
           phone_secondary = ?,
           phone_secondary_normalized = ?,
           email = ?,
           address = ?,
           city = ?,
           emergency_contact_name = ?,
           emergency_contact_relationship = ?,
           emergency_contact_phone = ?,
           emergency_contact_phone_normalized = ?,
           registration_source = ?,
           referred_by = ?,
           admission_fee_amount = ?,
           admission_fee_currency = ?,
           admission_fee_recorded_at = CASE
             WHEN ? = 'waived' AND admission_fee_status <> 'waived' THEN CURRENT_TIMESTAMP
             WHEN ? <> 'waived' AND admission_fee_status = 'waived' THEN NULL
             ELSE admission_fee_recorded_at
           END,
           admission_fee_status = ?,
           updated_by_user_id = ?
       WHERE organization_id = ?
         AND registration_branch_id = ?
         AND id = ?`,
      [
        nicFields.nic_type,
        nicFields.nic_ciphertext,
        nicFields.nic_iv,
        nicFields.nic_auth_tag,
        nicFields.nic_lookup_hash,
        nicFields.nic_last4,
        fullName,
        dateOfBirth,
        dobSource,
        dobConfirmed,
        gender,
        phonePrimary.raw,
        phonePrimary.normalized,
        phoneSecondary.raw,
        phoneSecondary.normalized,
        email,
        address,
        city,
        emergencyName,
        emergencyRelationship,
        emergencyPhone.raw,
        emergencyPhone.normalized,
        registrationSource,
        referredBy,
        admissionFeeAmount,
        admissionFeeCurrency,
        admissionFeeStatus,
        admissionFeeStatus,
        admissionFeeStatus,
        context.userId,
        context.organizationId,
        context.branchId,
        memberId,
      ]
    );

    const updatedRow = await getMemberRow(connection, context, memberId);
    if (!updatedRow) throw new Error('Updated member could not be reloaded.');

    await writeMemberAudit(
      connection,
      req,
      context,
      memberId,
      'MEMBER_UPDATED',
      `Updated member ${updatedRow.member_code}.`
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Member profile updated successfully.',
      member: toMemberResponse(updatedRow, { includeNic: true }),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Member update rollback failed:', rollbackError.message);
      }
    }
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        code: 'MEMBER_DUPLICATE_NIC',
        message: 'This NIC is already registered to another member in this organization.',
      });
    }
    if (error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' || error.errno === 3819) {
      return res.status(400).json({
        success: false,
        code: 'MEMBER_DATABASE_VALIDATION_FAILED',
        message: 'Member details do not satisfy the database rules.',
      });
    }
    console.error('Update member error:', error.code || error.message);
    return res.status(500).json({
      success: false,
      code: 'MEMBER_UPDATE_FAILED',
      message: 'Unable to update this member.',
    });
  } finally {
    if (connection) connection.release();
  }
};

const changeMemberStatus = async (req, res, targetStatus) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getSessionContext(req);
    const memberId = parsePositiveId(req.params.memberId);
    if (!context) {
      return res.status(401).json({
        success: false,
        code: 'MEMBER_SESSION_CONTEXT_REQUIRED',
        message: 'A valid Gym Staff session and active branch are required.',
      });
    }
    if (!memberId) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MEMBER_ID',
        message: 'Member ID is invalid.',
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const row = await getMemberRow(connection, context, memberId, true);
    if (!row) {
      await connection.rollback();
      transactionStarted = false;
      return respondMemberNotFound(res);
    }

    if (row.status === 'blocked') {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({
        success: false,
        code: 'MEMBER_BLOCKED',
        message: 'Blocked members cannot be activated or deactivated from this screen.',
      });
    }

    if (row.status === targetStatus) {
      await connection.rollback();
      transactionStarted = false;
      return res.json({
        success: true,
        message: targetStatus === 'active' ? 'Member is already active.' : 'Member is already inactive.',
        member: toMemberResponse(row),
      });
    }

    await connection.query(
      `UPDATE members
       SET status = ?, updated_by_user_id = ?
       WHERE organization_id = ?
         AND registration_branch_id = ?
         AND id = ?`,
      [targetStatus, context.userId, context.organizationId, context.branchId, memberId]
    );

    const updatedRow = await getMemberRow(connection, context, memberId);
    await writeMemberAudit(
      connection,
      req,
      context,
      memberId,
      targetStatus === 'inactive' ? 'MEMBER_DEACTIVATED' : 'MEMBER_REACTIVATED',
      `${targetStatus === 'inactive' ? 'Deactivated' : 'Reactivated'} member ${row.member_code}.`
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: targetStatus === 'inactive'
        ? 'Member deactivated successfully.'
        : 'Member reactivated successfully.',
      member: toMemberResponse(updatedRow),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Member status rollback failed:', rollbackError.message);
      }
    }
    console.error('Change member status error:', error.code || error.message);
    return res.status(500).json({
      success: false,
      code: 'MEMBER_STATUS_UPDATE_FAILED',
      message: 'Unable to change this member status.',
    });
  } finally {
    if (connection) connection.release();
  }
};

const deactivateMember = (req, res) => changeMemberStatus(req, res, 'inactive');
const reactivateMember = (req, res) => changeMemberStatus(req, res, 'active');

const getMemberPhoto = async (req, res) => {
  try {
    const context = getSessionContext(req);
    const memberId = parsePositiveId(req.params.memberId);
    if (!context || !memberId) {
      return res.status(context ? 400 : 401).json({
        success: false,
        code: context ? 'INVALID_MEMBER_ID' : 'MEMBER_SESSION_CONTEXT_REQUIRED',
        message: context ? 'Member ID is invalid.' : 'A valid Gym Staff session is required.',
      });
    }

    const row = await getMemberRow(db, context, memberId);
    if (!row) return respondMemberNotFound(res);
    if (!row.profile_photo_path) {
      return res.status(404).json({
        success: false,
        code: 'MEMBER_PHOTO_NOT_FOUND',
        message: 'This member does not have a profile photo.',
      });
    }

    const buffer = await memberPhotoStorage.readMemberPhoto(
      context.organizationId,
      memberId,
      row.profile_photo_path
    );

    return res.status(200).set({
      'Content-Type': 'image/webp',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    }).send(buffer);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({
        success: false,
        code: 'MEMBER_PHOTO_FILE_NOT_FOUND',
        message: 'The member photo file is unavailable.',
      });
    }
    console.error('Get member photo error:', error.code || error.message);
    return res.status(500).json({
      success: false,
      code: 'MEMBER_PHOTO_READ_FAILED',
      message: 'Unable to retrieve this member photo.',
    });
  }
};

const uploadMemberPhoto = async (req, res) => {
  let connection;
  let transactionStarted = false;
  let newPhotoPath = null;
  let rollbackCompleted = false;

  const context = getSessionContext(req);
  const memberId = parsePositiveId(req.params.memberId);

  try {
    if (!context || !memberId) {
      return res.status(context ? 400 : 401).json({
        success: false,
        code: context ? 'INVALID_MEMBER_ID' : 'MEMBER_SESSION_CONTEXT_REQUIRED',
        message: context ? 'Member ID is invalid.' : 'A valid Gym Staff session is required.',
      });
    }
    if (!req.file || !Buffer.isBuffer(req.file.buffer)) {
      return res.status(400).json({
        success: false,
        code: 'MEMBER_PHOTO_REQUIRED',
        message: 'Please select a member photo.',
      });
    }

    let processed;
    try {
      processed = await optimizeMemberPhoto(req.file.buffer);
    } catch (error) {
      if (error instanceof MemberPhotoValidationError) {
        return res.status(error.statusCode || 400).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const row = await getMemberRow(connection, context, memberId, true);
    if (!row) {
      await connection.rollback();
      transactionStarted = false;
      return respondMemberNotFound(res);
    }

    const oldPhotoPath = row.profile_photo_path || null;
    newPhotoPath = await memberPhotoStorage.saveMemberPhoto(
      context.organizationId,
      memberId,
      processed.buffer
    );

    await connection.query(
      `UPDATE members
       SET profile_photo_path = ?, updated_by_user_id = ?
       WHERE organization_id = ?
         AND registration_branch_id = ?
         AND id = ?`,
      [newPhotoPath, context.userId, context.organizationId, context.branchId, memberId]
    );

    await writeMemberAudit(
      connection,
      req,
      context,
      memberId,
      'MEMBER_PHOTO_UPDATED',
      `Updated profile photo for member ${row.member_code}.`
    );

    await connection.commit();
    transactionStarted = false;

    if (oldPhotoPath) {
      try {
        await memberPhotoStorage.deleteMemberPhoto(
          context.organizationId,
          memberId,
          oldPhotoPath
        );
      } catch (cleanupError) {
        console.error('Old member photo cleanup failed:', cleanupError.message);
      }
    }

    return res.json({
      success: true,
      message: 'Member profile photo uploaded successfully.',
      has_profile_photo: true,
      image: {
        format: processed.format,
        width: processed.width,
        height: processed.height,
        size_bytes: processed.sizeBytes,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
        rollbackCompleted = true;
      } catch (rollbackError) {
        console.error('Member photo upload rollback failed:', rollbackError.message);
      }
    }

    if (newPhotoPath && rollbackCompleted) {
      try {
        await memberPhotoStorage.deleteMemberPhoto(
          context.organizationId,
          memberId,
          newPhotoPath
        );
      } catch (cleanupError) {
        console.error('New member photo cleanup failed:', cleanupError.message);
      }
    }

    console.error('Upload member photo error:', error.code || error.message);
    return res.status(500).json({
      success: false,
      code: 'MEMBER_PHOTO_UPLOAD_FAILED',
      message: 'Unable to upload this member photo.',
    });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getMember,
  updateMember,
  deactivateMember,
  reactivateMember,
  getMemberPhoto,
  uploadMemberPhoto,
};