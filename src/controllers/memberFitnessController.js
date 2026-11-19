'use strict';

const db = require('../config/db');
const {
  writeAuditLog,
  buildMemberAuditMetadata,
} = require('../services/gymAuditService');
const memberProgressPhotoStorage = require('../services/storage/memberProgressPhotoStorage');
const {
  MemberProgressPhotoValidationError,
  optimizeMemberProgressPhoto,
} = require('../services/storage/memberProgressPhotoProcessor');

const METRIC_FIELDS = [
  'height_cm',
  'weight_kg',
  'arms_cm',
  'waist_cm',
  'thigh_cm',
  'chest_cm',
  'hips_cm',
  'calves_cm',
];

const METRIC_LIMITS = {
  height_cm: 260,
  weight_kg: 500,
  arms_cm: 300,
  waist_cm: 300,
  thigh_cm: 300,
  chest_cm: 300,
  hips_cm: 300,
  calves_cm: 300,
};

const VALID_PHOTO_TYPES = new Set(['front', 'side', 'back']);

class FitnessHttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const getContext = (req) => {
  const memberId = parsePositiveId(req.params.memberId);
  const organizationId = parsePositiveId(req.gymStaff?.organizationId);
  const branchId = parsePositiveId(req.gymStaff?.branchId);
  const userId = parsePositiveId(req.gymStaff?.userId);

  if (!memberId || !organizationId || !branchId || !userId) {
    throw new FitnessHttpError(
      401,
      'MEMBER_FITNESS_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return { memberId, organizationId, branchId, userId };
};

const ensureObjectBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FitnessHttpError(400, 'INVALID_FITNESS_REQUEST', 'Request body must be a valid object.');
  }
};

const ensureAllowedFields = (body, allowedFields) => {
  const unexpected = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unexpected.length > 0) {
    throw new FitnessHttpError(
      400,
      'UNSUPPORTED_FITNESS_FIELDS',
      `Unsupported fields: ${unexpected.join(', ')}`
    );
  }
};

const parseDateOnly = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new FitnessHttpError(400, 'INVALID_MEASUREMENT_DATE', 'Measurement date must use YYYY-MM-DD format.');
  }

  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new FitnessHttpError(400, 'INVALID_MEASUREMENT_DATE', 'Measurement date is not a valid calendar date.');
  }

  return value;
};

const parseMetric = (field, value) => {
  if (value === null || value === '') return null;

  const text = String(value).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) {
    throw new FitnessHttpError(400, 'INVALID_FITNESS_MEASUREMENT', `${field} must be a positive number with up to 2 decimal places.`);
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > METRIC_LIMITS[field]) {
    throw new FitnessHttpError(400, 'INVALID_FITNESS_MEASUREMENT', `${field} must be greater than 0 and no more than ${METRIC_LIMITS[field]}.`);
  }

  return Math.round(parsed * 100) / 100;
};

const parseNotes = (value) => {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new FitnessHttpError(400, 'INVALID_FITNESS_NOTES', 'Assessment notes must be text.');
  }
  const notes = value.trim();
  if (notes.length > 2000) {
    throw new FitnessHttpError(400, 'FITNESS_NOTES_TOO_LONG', 'Assessment notes must not exceed 2000 characters.');
  }
  return notes || null;
};

const calculateBmi = (heightCm, weightKg) => {
  if (heightCm === null || weightKg === null) return null;
  const heightM = heightCm / 100;
  return Math.round((weightKg / (heightM * heightM)) * 100) / 100;
};

const hasAnyMetric = (values) => METRIC_FIELDS.some((field) => values[field] !== null);

const buildCreateValues = (body) => {
  ensureObjectBody(body);
  const allowed = new Set(['measurement_date', ...METRIC_FIELDS, 'notes']);
  ensureAllowedFields(body, allowed);

  const values = {
    measurement_date: parseDateOnly(body.measurement_date),
    notes: parseNotes(body.notes === undefined ? null : body.notes),
  };

  for (const field of METRIC_FIELDS) {
    values[field] = parseMetric(field, body[field] === undefined ? null : body[field]);
  }

  if (!hasAnyMetric(values) && !values.notes) {
    throw new FitnessHttpError(400, 'EMPTY_FITNESS_ASSESSMENT', 'Enter at least one measurement or an assessment note.');
  }

  values.bmi = calculateBmi(values.height_cm, values.weight_kg);
  return values;
};

const asNullableNumber = (value) => value === null || value === undefined ? null : Number(value);

const buildUpdateValues = (body, current) => {
  ensureObjectBody(body);
  const allowed = new Set(['measurement_date', ...METRIC_FIELDS, 'notes']);
  ensureAllowedFields(body, allowed);

  if (Object.keys(body).length === 0) {
    throw new FitnessHttpError(400, 'EMPTY_FITNESS_UPDATE', 'Provide at least one field to update.');
  }

  const values = {
    measurement_date: Object.prototype.hasOwnProperty.call(body, 'measurement_date')
      ? parseDateOnly(body.measurement_date)
      : String(current.measurement_date).slice(0, 10),
    notes: Object.prototype.hasOwnProperty.call(body, 'notes')
      ? parseNotes(body.notes)
      : current.notes,
  };

  for (const field of METRIC_FIELDS) {
    values[field] = Object.prototype.hasOwnProperty.call(body, field)
      ? parseMetric(field, body[field])
      : asNullableNumber(current[field]);
  }

  if (!hasAnyMetric(values) && !values.notes) {
    throw new FitnessHttpError(400, 'EMPTY_FITNESS_ASSESSMENT', 'An assessment must contain at least one measurement or note.');
  }

  values.bmi = calculateBmi(values.height_cm, values.weight_kg);
  return values;
};

const selectAssessmentSql = `
  SELECT
    p.id,
    p.organization_id,
    p.member_id,
    p.branch_id,
    DATE_FORMAT(p.measurement_date, '%Y-%m-%d') AS measurement_date,
    p.height_cm,
    p.weight_kg,
    p.bmi,
    p.arms_cm,
    p.waist_cm,
    p.thigh_cm,
    p.chest_cm,
    p.hips_cm,
    p.calves_cm,
    p.notes,
    p.created_by_user_id,
    p.updated_by_user_id,
    p.created_at,
    p.updated_at
  FROM member_fitness_progress p
`;

const serializeAssessment = (row) => ({
  id: Number(row.id),
  member_id: Number(row.member_id),
  branch_id: Number(row.branch_id),
  measurement_date: row.measurement_date,
  height_cm: asNullableNumber(row.height_cm),
  weight_kg: asNullableNumber(row.weight_kg),
  bmi: asNullableNumber(row.bmi),
  arms_cm: asNullableNumber(row.arms_cm),
  waist_cm: asNullableNumber(row.waist_cm),
  thigh_cm: asNullableNumber(row.thigh_cm),
  chest_cm: asNullableNumber(row.chest_cm),
  hips_cm: asNullableNumber(row.hips_cm),
  calves_cm: asNullableNumber(row.calves_cm),
  notes: row.notes,
  created_by_user_id: Number(row.created_by_user_id),
  updated_by_user_id: row.updated_by_user_id == null ? null : Number(row.updated_by_user_id),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const ensureMember = async (connection, context, forUpdate = false) => {
  const [rows] = await connection.query(
    `SELECT
       m.id,
       m.member_code,
       m.registration_branch_id,
       b.name AS registration_branch_name,
       b.branch_code AS registration_branch_code
     FROM members m
     INNER JOIN branches b
       ON b.organization_id = m.organization_id
      AND b.id = m.registration_branch_id
     WHERE m.organization_id = ?
       AND m.id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [context.organizationId, context.memberId]
  );

  if (rows.length === 0) {
    throw new FitnessHttpError(404, 'MEMBER_NOT_FOUND', 'Member was not found in this organization.');
  }

  return rows[0];
};

const ensureAssessment = async (connection, context, progressId, forUpdate = false) => {
  const [rows] = await connection.query(
    `${selectAssessmentSql}
     INNER JOIN members m
       ON m.organization_id = p.organization_id
      AND m.id = p.member_id
     WHERE p.organization_id = ?
       AND p.member_id = ?
       AND p.id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [context.organizationId, context.memberId, progressId]
  );

  if (rows.length === 0) {
    throw new FitnessHttpError(404, 'FITNESS_ASSESSMENT_NOT_FOUND', 'Fitness assessment was not found for this member.');
  }

  return rows[0];
};

const audit = writeAuditLog;

const getErrorResponse = (res, error, fallbackCode, fallbackMessage) => {
  if (error instanceof FitnessHttpError) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  if (error && error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      code: 'FITNESS_PHOTO_ALREADY_EXISTS',
      message: 'A photo of this type already exists for this assessment. Please retry the replacement.',
    });
  }

  console.error(fallbackCode, error?.code || error?.message || error);
  return res.status(500).json({
    success: false,
    code: fallbackCode,
    message: fallbackMessage,
  });
};

const listAssessments = async (req, res) => {
  try {
    const context = getContext(req);
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const pageSize = req.query.page_size === undefined ? 20 : Number(req.query.page_size);

    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_PAGE', 'Page must be a positive whole number.');
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_PAGE_SIZE', 'Page size must be between 1 and 50.');
    }

    await ensureMember(db, context);

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM member_fitness_progress p
       WHERE p.organization_id = ? AND p.member_id = ?`,
      [context.organizationId, context.memberId]
    );
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const resolvedPage = Math.min(page, totalPages);
    const offset = (resolvedPage - 1) * pageSize;

    const [rows] = await db.query(
      `${selectAssessmentSql}
       WHERE p.organization_id = ? AND p.member_id = ?
       ORDER BY p.measurement_date DESC, p.id DESC
       LIMIT ? OFFSET ?`,
      [context.organizationId, context.memberId, pageSize, offset]
    );

    return res.json({
      success: true,
      member_id: context.memberId,
      assessments: rows.map(serializeAssessment),
      pagination: {
        page: resolvedPage,
        page_size: pageSize,
        total,
        total_pages: totalPages,
      },
    });
  } catch (error) {
    return getErrorResponse(res, error, 'MEMBER_FITNESS_LIST_FAILED', 'Unable to load fitness assessments.');
  }
};

const getAssessment = async (req, res) => {
  try {
    const context = getContext(req);
    const progressId = parsePositiveId(req.params.progressId);
    if (!progressId) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_ASSESSMENT_ID', 'Invalid fitness assessment ID.');
    }

    await ensureMember(db, context);
    const row = await ensureAssessment(db, context, progressId);
    return res.json({ success: true, assessment: serializeAssessment(row) });
  } catch (error) {
    return getErrorResponse(res, error, 'MEMBER_FITNESS_DETAIL_FAILED', 'Unable to load this fitness assessment.');
  }
};

const createAssessment = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const values = buildCreateValues(req.body);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const member = await ensureMember(connection, context, true);

    const [result] = await connection.query(
      `INSERT INTO member_fitness_progress
        (
          organization_id, member_id, branch_id, measurement_date,
          height_cm, weight_kg, bmi, arms_cm, waist_cm, thigh_cm,
          chest_cm, hips_cm, calves_cm, notes, created_by_user_id
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        context.organizationId,
        context.memberId,
        context.branchId,
        values.measurement_date,
        values.height_cm,
        values.weight_kg,
        values.bmi,
        values.arms_cm,
        values.waist_cm,
        values.thigh_cm,
        values.chest_cm,
        values.hips_cm,
        values.calves_cm,
        values.notes,
        context.userId,
      ]
    );

    const progressId = Number(result.insertId);
    const [rows] = await connection.query(
      `${selectAssessmentSql}
       WHERE p.organization_id = ? AND p.member_id = ? AND p.id = ?
       LIMIT 1`,
      [context.organizationId, context.memberId, progressId]
    );

    const recordedFields = [
      'measurement_date',
      ...METRIC_FIELDS.filter((field) => values[field] !== null),
      ...(values.bmi !== null && values.bmi !== undefined ? ['bmi'] : []),
      ...(values.notes ? ['notes'] : []),
    ];

    await audit(connection, req, context, {
      action: 'MEMBER_FITNESS_CREATED',
      entityType: 'member_fitness_progress',
      entityId: progressId,
      description: `Created fitness assessment ${progressId} for member ${member.member_code}; recorded_fields=${recordedFields.join(',')}. Measurement values and notes are excluded.`,
      oldValues: { record_exists: false },
      newValues: {
        record_exists: true,
        recorded_fields: recordedFields,
      },
      metadata: buildMemberAuditMetadata(member, {
        fitness_assessment: {
          progress_id: progressId,
          assessment_branch_id: Number(rows[0].branch_id),
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Fitness assessment created successfully.',
      assessment: serializeAssessment(rows[0]),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Create fitness assessment rollback failed:', rollbackError.message);
      }
    }
    return getErrorResponse(res, error, 'MEMBER_FITNESS_CREATE_FAILED', 'Unable to create this fitness assessment.');
  } finally {
    if (connection) connection.release();
  }
};

const updateAssessment = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const progressId = parsePositiveId(req.params.progressId);
    if (!progressId) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_ASSESSMENT_ID', 'Invalid fitness assessment ID.');
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const member = await ensureMember(connection, context, true);
    const current = await ensureAssessment(connection, context, progressId, true);
    const values = buildUpdateValues(req.body, current);

    const changedFields = [];
    for (const field of ['measurement_date', ...METRIC_FIELDS, 'bmi', 'notes']) {
      const oldValue = field === 'measurement_date'
        ? String(current.measurement_date).slice(0, 10)
        : field === 'notes'
          ? current.notes
          : asNullableNumber(current[field]);
      const newValue = values[field];
      if (oldValue !== newValue) changedFields.push(field);
    }

    await connection.query(
      `UPDATE member_fitness_progress
       SET measurement_date = ?,
           height_cm = ?, weight_kg = ?, bmi = ?,
           arms_cm = ?, waist_cm = ?, thigh_cm = ?, chest_cm = ?,
           hips_cm = ?, calves_cm = ?, notes = ?, updated_by_user_id = ?
       WHERE organization_id = ? AND member_id = ? AND id = ?`,
      [
        values.measurement_date,
        values.height_cm,
        values.weight_kg,
        values.bmi,
        values.arms_cm,
        values.waist_cm,
        values.thigh_cm,
        values.chest_cm,
        values.hips_cm,
        values.calves_cm,
        values.notes,
        context.userId,
        context.organizationId,
        context.memberId,
        progressId,
      ]
    );

    const [rows] = await connection.query(
      `${selectAssessmentSql}
       WHERE p.organization_id = ? AND p.member_id = ? AND p.id = ?
       LIMIT 1`,
      [context.organizationId, context.memberId, progressId]
    );

    await audit(connection, req, context, {
      action: 'MEMBER_FITNESS_UPDATED',
      entityType: 'member_fitness_progress',
      entityId: progressId,
      description: `Updated fitness assessment ${progressId} for member ${member.member_code}; changed_fields=${changedFields.join(',') || 'none'}. Measurement values and notes are excluded.`,
      oldValues: {
        record_exists: true,
        changed_fields: changedFields,
      },
      newValues: {
        record_exists: true,
        changed_fields: changedFields,
      },
      metadata: buildMemberAuditMetadata(member, {
        fitness_assessment: {
          progress_id: progressId,
          assessment_branch_id: Number(current.branch_id),
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Fitness assessment updated successfully.',
      assessment: serializeAssessment(rows[0]),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Update fitness assessment rollback failed:', rollbackError.message);
      }
    }
    return getErrorResponse(res, error, 'MEMBER_FITNESS_UPDATE_FAILED', 'Unable to update this fitness assessment.');
  } finally {
    if (connection) connection.release();
  }
};

const deleteAssessment = async (req, res) => {
  let connection;
  let transactionStarted = false;
  let context;

  try {
    context = getContext(req);
    const progressId = parsePositiveId(req.params.progressId);
    if (!progressId) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_ASSESSMENT_ID', 'Invalid fitness assessment ID.');
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const member = await ensureMember(connection, context, true);
    const assessment = await ensureAssessment(connection, context, progressId, true);

    const [photos] = await connection.query(
      `SELECT id, photo_type, storage_path
       FROM member_progress_photos
       WHERE organization_id = ? AND member_id = ? AND progress_id = ?
       FOR UPDATE`,
      [context.organizationId, context.memberId, progressId]
    );
    const grantedPermissions = new Set(req.gymStaff?.permissions || []);
    if (photos.length > 0 && !grantedPermissions.has('member_fitness.photos.manage')) {
      throw new FitnessHttpError(403, 'FITNESS_PHOTO_MANAGE_PERMISSION_REQUIRED', 'You need photo management permission to delete an assessment that contains photos.');
    }

    await connection.query(
      `DELETE FROM member_progress_photos
       WHERE organization_id = ? AND member_id = ? AND progress_id = ?`,
      [context.organizationId, context.memberId, progressId]
    );

    await connection.query(
      `DELETE FROM member_fitness_progress
       WHERE organization_id = ? AND member_id = ? AND id = ?`,
      [context.organizationId, context.memberId, progressId]
    );

    await audit(connection, req, context, {
      action: 'MEMBER_FITNESS_DELETED',
      entityType: 'member_fitness_progress',
      entityId: progressId,
      description: `Deleted fitness assessment ${progressId} for member ${member.member_code}.`,
      oldValues: {
        record_exists: true,
        photo_slots: photos.map((row) => row.photo_type),
      },
      newValues: { record_exists: false },
      metadata: buildMemberAuditMetadata(member, {
        fitness_assessment: {
          progress_id: progressId,
          assessment_branch_id: Number(assessment.branch_id),
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;

    for (const photo of photos) {
      try {
        await memberProgressPhotoStorage.deleteMemberProgressPhoto(
          context.organizationId,
          context.memberId,
          progressId,
          photo.storage_path
        );
      } catch (cleanupError) {
        console.error('Deleted assessment photo cleanup failed:', cleanupError.message);
      }
    }

    return res.json({
      success: true,
      message: 'Fitness assessment and its photos were deleted successfully.',
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Delete fitness assessment rollback failed:', rollbackError.message);
      }
    }
    return getErrorResponse(res, error, 'MEMBER_FITNESS_DELETE_FAILED', 'Unable to delete this fitness assessment.');
  } finally {
    if (connection) connection.release();
  }
};

const listAssessmentPhotos = async (req, res) => {
  try {
    const context = getContext(req);
    const progressId = parsePositiveId(req.params.progressId);
    if (!progressId) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_ASSESSMENT_ID', 'Invalid fitness assessment ID.');
    }

    await ensureMember(db, context);
    await ensureAssessment(db, context, progressId);

    const [rows] = await db.query(
      `SELECT id, photo_type, created_at
       FROM member_progress_photos
       WHERE organization_id = ? AND member_id = ? AND progress_id = ?
       ORDER BY FIELD(photo_type, 'front', 'side', 'back')`,
      [context.organizationId, context.memberId, progressId]
    );

    const saved = new Map(rows.map((row) => [row.photo_type, row]));
    const photos = ['front', 'side', 'back'].map((photoType) => {
      const row = saved.get(photoType);
      return {
        photo_type: photoType,
        has_photo: Boolean(row),
        photo_id: row ? Number(row.id) : null,
        created_at: row ? row.created_at : null,
        image_path: row
          ? `/api/members/${context.memberId}/fitness/${progressId}/photos/${photoType}`
          : null,
      };
    });

    return res.json({ success: true, photos });
  } catch (error) {
    return getErrorResponse(res, error, 'MEMBER_FITNESS_PHOTO_LIST_FAILED', 'Unable to load assessment photos.');
  }
};

const getAssessmentPhoto = async (req, res) => {
  try {
    const context = getContext(req);
    const progressId = parsePositiveId(req.params.progressId);
    const photoType = String(req.params.photoType || '').toLowerCase();
    if (!progressId) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_ASSESSMENT_ID', 'Invalid fitness assessment ID.');
    }
    if (!VALID_PHOTO_TYPES.has(photoType)) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_PHOTO_TYPE', 'Photo type must be front, side or back.');
    }

    await ensureMember(db, context);
    await ensureAssessment(db, context, progressId);

    const [rows] = await db.query(
      `SELECT storage_path
       FROM member_progress_photos
       WHERE organization_id = ? AND member_id = ? AND progress_id = ? AND photo_type = ?
       LIMIT 1`,
      [context.organizationId, context.memberId, progressId, photoType]
    );
    if (rows.length === 0) {
      throw new FitnessHttpError(404, 'MEMBER_FITNESS_PHOTO_NOT_FOUND', 'This assessment photo has not been uploaded.');
    }

    let imageBuffer;
    try {
      imageBuffer = await memberProgressPhotoStorage.readMemberProgressPhoto(
        context.organizationId,
        context.memberId,
        progressId,
        rows[0].storage_path
      );
    } catch (readError) {
      if (readError.code === 'ENOENT') {
        throw new FitnessHttpError(404, 'MEMBER_FITNESS_PHOTO_FILE_MISSING', 'The stored assessment photo is unavailable.');
      }
      throw readError;
    }

    res.set({
      'Content-Type': 'image/webp',
      'Content-Length': String(imageBuffer.length),
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(200).send(imageBuffer);
  } catch (error) {
    return getErrorResponse(res, error, 'MEMBER_FITNESS_PHOTO_READ_FAILED', 'Unable to retrieve this assessment photo.');
  }
};

const uploadAssessmentPhoto = async (req, res) => {
  let connection;
  let transactionStarted = false;
  let rollbackCompleted = false;
  let context;
  let newPhotoPath = null;
  let oldPhotoPath = null;

  try {
    context = getContext(req);
    const progressId = parsePositiveId(req.params.progressId);
    const photoType = String(req.params.photoType || '').toLowerCase();
    if (!progressId) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_ASSESSMENT_ID', 'Invalid fitness assessment ID.');
    }
    if (!VALID_PHOTO_TYPES.has(photoType)) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_PHOTO_TYPE', 'Photo type must be front, side or back.');
    }
    if (!req.file?.buffer) {
      throw new FitnessHttpError(400, 'MEMBER_FITNESS_PHOTO_REQUIRED', 'Select a front, side or back assessment photo.');
    }

    let processed;
    try {
      processed = await optimizeMemberProgressPhoto(req.file.buffer);
    } catch (error) {
      if (error instanceof MemberProgressPhotoValidationError) throw error;
      throw new FitnessHttpError(400, 'INVALID_MEMBER_FITNESS_PHOTO', 'The selected image could not be processed.');
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const member = await ensureMember(connection, context, true);
    const assessment = await ensureAssessment(connection, context, progressId, true);

    const [existingRows] = await connection.query(
      `SELECT id, storage_path
       FROM member_progress_photos
       WHERE organization_id = ? AND member_id = ? AND progress_id = ? AND photo_type = ?
       LIMIT 1 FOR UPDATE`,
      [context.organizationId, context.memberId, progressId, photoType]
    );
    oldPhotoPath = existingRows[0]?.storage_path || null;

    newPhotoPath = await memberProgressPhotoStorage.saveMemberProgressPhoto(
      context.organizationId,
      context.memberId,
      progressId,
      photoType,
      processed.buffer
    );

    await connection.query(
      `INSERT INTO member_progress_photos
        (organization_id, member_id, progress_id, photo_type, storage_path, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         storage_path = VALUES(storage_path),
         created_by_user_id = VALUES(created_by_user_id),
         created_at = CURRENT_TIMESTAMP`,
      [
        context.organizationId,
        context.memberId,
        progressId,
        photoType,
        newPhotoPath,
        context.userId,
      ]
    );

    const [photoRows] = await connection.query(
      `SELECT id FROM member_progress_photos
       WHERE organization_id = ? AND member_id = ? AND progress_id = ? AND photo_type = ?
       LIMIT 1`,
      [context.organizationId, context.memberId, progressId, photoType]
    );

    await audit(connection, req, context, {
      action: oldPhotoPath ? 'MEMBER_FITNESS_PHOTO_REPLACED' : 'MEMBER_FITNESS_PHOTO_UPLOADED',
      entityType: 'member_fitness_photo',
      entityId: Number(photoRows[0].id),
      description: `${oldPhotoPath ? 'Replaced' : 'Uploaded'} ${photoType} photo for fitness assessment ${progressId}.`,
      oldValues: { has_photo: Boolean(oldPhotoPath) },
      newValues: { has_photo: true },
      metadata: buildMemberAuditMetadata(member, {
        fitness_assessment: {
          progress_id: progressId,
          assessment_branch_id: Number(assessment.branch_id),
        },
        fitness_photo: {
          photo_id: Number(photoRows[0].id),
          photo_type: photoType,
          format: processed.format,
          width: processed.width,
          height: processed.height,
          size_bytes: processed.sizeBytes,
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;

    if (oldPhotoPath) {
      try {
        await memberProgressPhotoStorage.deleteMemberProgressPhoto(
          context.organizationId,
          context.memberId,
          progressId,
          oldPhotoPath
        );
      } catch (cleanupError) {
        console.error('Replaced member fitness photo cleanup failed:', cleanupError.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: oldPhotoPath ? 'Assessment photo replaced successfully.' : 'Assessment photo uploaded successfully.',
      photo: {
        id: Number(photoRows[0].id),
        photo_type: photoType,
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
        console.error('Member fitness photo rollback failed:', rollbackError.message);
      }
    }

    if (newPhotoPath && rollbackCompleted && context) {
      try {
        await memberProgressPhotoStorage.deleteMemberProgressPhoto(
          context.organizationId,
          context.memberId,
          Number(req.params.progressId),
          newPhotoPath
        );
      } catch (cleanupError) {
        console.error('New member fitness photo cleanup failed:', cleanupError.message);
      }
    }

    if (error instanceof MemberProgressPhotoValidationError) {
      return res.status(error.statusCode || 400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    return getErrorResponse(res, error, 'MEMBER_FITNESS_PHOTO_UPLOAD_FAILED', 'Unable to upload this assessment photo.');
  } finally {
    if (connection) connection.release();
  }
};

const deleteAssessmentPhoto = async (req, res) => {
  let connection;
  let transactionStarted = false;
  let context;
  let photoPath = null;

  try {
    context = getContext(req);
    const progressId = parsePositiveId(req.params.progressId);
    const photoType = String(req.params.photoType || '').toLowerCase();
    if (!progressId) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_ASSESSMENT_ID', 'Invalid fitness assessment ID.');
    }
    if (!VALID_PHOTO_TYPES.has(photoType)) {
      throw new FitnessHttpError(400, 'INVALID_FITNESS_PHOTO_TYPE', 'Photo type must be front, side or back.');
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const member = await ensureMember(connection, context, true);
    const assessment = await ensureAssessment(connection, context, progressId, true);

    const [rows] = await connection.query(
      `SELECT id, storage_path
       FROM member_progress_photos
       WHERE organization_id = ? AND member_id = ? AND progress_id = ? AND photo_type = ?
       LIMIT 1 FOR UPDATE`,
      [context.organizationId, context.memberId, progressId, photoType]
    );

    if (rows.length === 0) {
      throw new FitnessHttpError(404, 'MEMBER_FITNESS_PHOTO_NOT_FOUND', 'This assessment photo has not been uploaded.');
    }

    photoPath = rows[0].storage_path;
    await connection.query(
      `DELETE FROM member_progress_photos WHERE id = ? AND organization_id = ?`,
      [rows[0].id, context.organizationId]
    );

    await audit(connection, req, context, {
      action: 'MEMBER_FITNESS_PHOTO_DELETED',
      entityType: 'member_fitness_photo',
      entityId: Number(rows[0].id),
      description: `Deleted ${photoType} photo from fitness assessment ${progressId}.`,
      oldValues: { has_photo: true },
      newValues: { has_photo: false },
      metadata: buildMemberAuditMetadata(member, {
        fitness_assessment: {
          progress_id: progressId,
          assessment_branch_id: Number(assessment.branch_id),
        },
        fitness_photo: {
          photo_id: Number(rows[0].id),
          photo_type: photoType,
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;

    try {
      await memberProgressPhotoStorage.deleteMemberProgressPhoto(
        context.organizationId,
        context.memberId,
        progressId,
        photoPath
      );
    } catch (cleanupError) {
      console.error('Removed member fitness photo cleanup failed:', cleanupError.message);
    }

    return res.json({ success: true, message: 'Assessment photo deleted successfully.' });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Delete member fitness photo rollback failed:', rollbackError.message);
      }
    }
    return getErrorResponse(res, error, 'MEMBER_FITNESS_PHOTO_DELETE_FAILED', 'Unable to delete this assessment photo.');
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  listAssessments,
  getAssessment,
  createAssessment,
  updateAssessment,
  deleteAssessment,
  listAssessmentPhotos,
  getAssessmentPhoto,
  uploadAssessmentPhoto,
  deleteAssessmentPhoto,
};