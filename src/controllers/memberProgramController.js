'use strict';

const db = require('../config/db');
const {
  writeAuditLog,
  buildMemberAuditMetadata,
} = require('../services/gymAuditService');

const VALID_UNITS = new Set(['day', 'week', 'month', 'year']);
const VALID_STATUSES = new Set([
  'active',
  'paused',
  'completed',
  'cancelled',
]);

class ProgramAssignmentError extends Error {
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
  const context = {
    memberId: parsePositiveId(req.params.memberId),
    organizationId: parsePositiveId(req.gymStaff?.organizationId),
    branchId: parsePositiveId(req.gymStaff?.branchId),
    userId: parsePositiveId(req.gymStaff?.userId),
  };

  if (
    !context.memberId ||
    !context.organizationId ||
    !context.branchId ||
    !context.userId
  ) {
    throw new ProgramAssignmentError(
      401,
      'MEMBER_PROGRAM_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const ensureObjectBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProgramAssignmentError(
      400,
      'INVALID_MEMBER_PROGRAM_REQUEST',
      'Request body must be a valid object.'
    );
  }
};

const ensureAllowedFields = (body, allowedFields) => {
  const unexpected = Object.keys(body).filter(
    (key) => !allowedFields.has(key)
  );

  if (unexpected.length > 0) {
    throw new ProgramAssignmentError(
      400,
      'UNSUPPORTED_MEMBER_PROGRAM_FIELDS',
      `Unsupported fields: ${unexpected.join(', ')}`
    );
  }
};

const parseDateOnly = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new ProgramAssignmentError(
      400,
      'INVALID_PROGRAM_START_DATE',
      'Start date must use YYYY-MM-DD format.'
    );
  }

  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new ProgramAssignmentError(
      400,
      'INVALID_PROGRAM_START_DATE',
      'Start date is not a valid calendar date.'
    );
  }

  return value;
};

const ensureMember = async (connection, context, forUpdate = false) => {
  const [rows] = await connection.query(
    `SELECT
       m.id,
       m.member_code,
       m.full_name,
       m.status,
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
    throw new ProgramAssignmentError(
      404,
      'MEMBER_NOT_FOUND',
      'Member was not found in this organization.'
    );
  }

  return rows[0];
};

const ensureProgram = async (
  connection,
  context,
  programId,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `SELECT
       id,
       program_code,
       name,
       duration_value,
       duration_unit,
       status
     FROM fitness_programs
     WHERE organization_id = ?
       AND id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [context.organizationId, programId]
  );

  if (rows.length === 0) {
    throw new ProgramAssignmentError(
      404,
      'FITNESS_PROGRAM_NOT_FOUND',
      'Fitness program was not found in this organization.'
    );
  }

  if (rows[0].status !== 'active') {
    throw new ProgramAssignmentError(
      409,
      'FITNESS_PROGRAM_INACTIVE',
      'An inactive fitness program cannot be assigned.'
    );
  }

  return rows[0];
};

// Resolve program selections through the unified membership_plans catalog.
// The legacy fitness_programs row is retained as a compatibility reference
// for existing assignment history and its active-assignment uniqueness rule.
const ensureUnifiedProgram = async (
  connection,
  context,
  membershipPlanId,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `SELECT
       mp.id AS membership_plan_id,
       mp.plan_code AS program_code,
       mp.name,
       mp.duration_value,
       mp.duration_unit,
       mp.price,
       mp.currency_code,
       mp.price_configured,
       mp.status AS plan_status,
       mp.legacy_program_id,
       fp.id AS legacy_program_row_id,
       fp.status AS legacy_program_status
     FROM membership_plans mp
     LEFT JOIN fitness_programs fp
       ON fp.organization_id = mp.organization_id
      AND fp.id = mp.legacy_program_id
     WHERE mp.organization_id = ?
       AND mp.id = ?
       AND mp.plan_category = 'program'
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [context.organizationId, membershipPlanId]
  );

  if (rows.length === 0) {
    throw new ProgramAssignmentError(
      404,
      'UNIFIED_PROGRAM_NOT_FOUND',
      'Program was not found in the unified plan catalog.'
    );
  }

  const row = rows[0];
  if (row.plan_status !== 'active' || row.legacy_program_status !== 'active') {
    throw new ProgramAssignmentError(
      409,
      'UNIFIED_PROGRAM_INACTIVE',
      'An inactive program cannot be assigned.'
    );
  }

  if (!row.legacy_program_id || !row.legacy_program_row_id) {
    throw new ProgramAssignmentError(
      409,
      'UNIFIED_PROGRAM_LEGACY_LINK_MISSING',
      'This program is missing its legacy compatibility record. Refresh the catalog mapping before assigning it.'
    );
  }

  return {
    id: Number(row.legacy_program_row_id),
    membership_plan_id: Number(row.membership_plan_id),
    program_code: row.program_code,
    name: row.name,
    duration_value: Number(row.duration_value),
    duration_unit: row.duration_unit,
    price: row.price == null ? null : String(row.price),
    currency_code: row.currency_code || null,
    price_configured: Number(row.price_configured) === 1,
    status: row.plan_status,
  };
};

const selectAssignmentSql = `
  SELECT
    id,
    organization_id,
    member_id,
    program_id,
    membership_plan_id,
    branch_id,
    program_code_snapshot,
    program_name_snapshot,
    duration_value_snapshot,
    duration_unit_snapshot,
    fee_snapshot,
    currency_code_snapshot,
    price_configured_snapshot,
    DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
    DATE_FORMAT(expected_end_date, '%Y-%m-%d') AS expected_end_date,
    status,
    DATE_FORMAT(completed_on, '%Y-%m-%d') AS completed_on,
    DATE_FORMAT(cancelled_on, '%Y-%m-%d') AS cancelled_on,
    (
      SELECT DATE_FORMAT(pause_row.paused_on, '%Y-%m-%d')
      FROM member_program_assignment_pauses pause_row
      WHERE pause_row.organization_id = member_program_assignments.organization_id
        AND pause_row.assignment_id = member_program_assignments.id
        AND pause_row.resumed_at IS NULL
        AND pause_row.closed_at IS NULL
      ORDER BY pause_row.id DESC
      LIMIT 1
    ) AS current_pause_on,
    assigned_by_user_id,
    updated_by_user_id,
    created_at,
    updated_at
  FROM member_program_assignments
`;

const serializeAssignment = (row) => ({
  id: Number(row.id),
  member_id: Number(row.member_id),
  program_id: Number(row.program_id),
  membership_plan_id: row.membership_plan_id == null
    ? null
    : Number(row.membership_plan_id),
  branch_id: Number(row.branch_id),
  program_code: row.program_code_snapshot,
  program_name: row.program_name_snapshot,
  duration_value: Number(row.duration_value_snapshot),
  duration_unit: row.duration_unit_snapshot,
  fee: row.fee_snapshot == null ? null : String(row.fee_snapshot),
  currency_code: row.currency_code_snapshot || null,
  price_configured: Number(row.price_configured_snapshot) === 1,
  start_date: row.start_date,
  expected_end_date: row.expected_end_date,
  status: row.status,
  completed_on: row.completed_on,
  cancelled_on: row.cancelled_on,
  current_pause_on: row.current_pause_on,
  assigned_by_user_id: Number(row.assigned_by_user_id),
  updated_by_user_id: row.updated_by_user_id == null
    ? null
    : Number(row.updated_by_user_id),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const ensureAssignment = async (
  connection,
  context,
  assignmentId,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `${selectAssignmentSql}
     WHERE organization_id = ?
       AND member_id = ?
       AND id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [
      context.organizationId,
      context.memberId,
      assignmentId,
    ]
  );

  if (rows.length === 0) {
    throw new ProgramAssignmentError(
      404,
      'MEMBER_PROGRAM_ASSIGNMENT_NOT_FOUND',
      'Program assignment was not found for this member.'
    );
  }

  return rows[0];
};

const getErrorResponse = (
  res,
  error,
  fallbackCode,
  fallbackMessage
) => {
  if (error instanceof ProgramAssignmentError) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      code: 'MEMBER_PROGRAM_ALREADY_ASSIGNED',
      message: 'This member already has an active or paused assignment for this program.',
    });
  }

  if (
    error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' ||
    error.errno === 3819
  ) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_MEMBER_PROGRAM_ASSIGNMENT',
      message: 'Program assignment values do not satisfy the database rules.',
    });
  }

  console.error(`${fallbackCode}:`, error.code || '', error.message);

  return res.status(500).json({
    success: false,
    code: fallbackCode,
    message: fallbackMessage,
  });
};

const getExpectedEndDate = async (
  connection,
  startDate,
  durationValue,
  durationUnit
) => {
  if (!VALID_UNITS.has(durationUnit)) {
    throw new Error('Unsupported fitness program duration unit.');
  }

  // The duration unit is interpolated only after enum validation.
  const [rows] = await connection.query(
    `SELECT DATE_FORMAT(
       DATE_ADD(?, INTERVAL ? ${durationUnit}),
       '%Y-%m-%d'
     ) AS expected_end_date`,
    [startDate, durationValue]
  );

  if (!rows[0]?.expected_end_date) {
    throw new Error('Unable to calculate the program expected end date.');
  }

  return rows[0].expected_end_date;
};

// GET /api/members/:memberId/programs/catalog
// The member assignment screen reads only Program category rows from the
// unified membership_plans catalog. The legacy fitness_programs table remains
// an internal compatibility mirror, not the source of the UI list.
const listAvailableUnifiedPrograms = async (req, res) => {
  try {
    const context = getContext(req);
    await ensureMember(db, context);

    const [rows] = await db.query(
      `SELECT
         id,
         plan_code AS program_code,
         name,
         program_category AS category,
         description,
         duration_value,
         duration_unit,
         instructions,
         price,
         currency_code,
         price_configured,
         status
       FROM membership_plans
       WHERE organization_id = ?
         AND plan_category = 'program'
         AND status = 'active'
       ORDER BY name ASC, id DESC`,
      [context.organizationId]
    );

    return res.json({
      success: true,
      programs: rows.map((row) => ({
        id: Number(row.id),
        membership_plan_id: Number(row.id),
        program_code: row.program_code,
        name: row.name,
        category: row.category,
        description: row.description,
        duration_value: Number(row.duration_value),
        duration_unit: row.duration_unit,
        instructions: row.instructions,
        price: String(row.price),
        currency_code: row.currency_code,
        price_configured: Boolean(row.price_configured),
        status: row.status,
      })),
    });
  } catch (error) {
    return getErrorResponse(
      res,
      error,
      'MEMBER_PROGRAM_CATALOG_FAILED',
      'Unable to load Programs from the unified catalog.'
    );
  }
};

// GET /api/members/:memberId/programs
const listMemberProgramAssignments = async (req, res) => {
  try {
    const context = getContext(req);

    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.page_size ?? 20);

    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 50
    ) {
      throw new ProgramAssignmentError(
        400,
        'INVALID_MEMBER_PROGRAM_PAGINATION',
        'Page must be positive and page_size must be between 1 and 50.'
      );
    }

    const filters = [
      'organization_id = ?',
      'member_id = ?',
    ];

    const params = [
      context.organizationId,
      context.memberId,
    ];

    if (req.query.status !== undefined) {
      if (!VALID_STATUSES.has(req.query.status)) {
        throw new ProgramAssignmentError(
          400,
          'INVALID_MEMBER_PROGRAM_STATUS_FILTER',
          'Invalid program assignment status filter.'
        );
      }

      filters.push('status = ?');
      params.push(req.query.status);
    }

    await ensureMember(db, context);

    const whereSql = `WHERE ${filters.join(' AND ')}`;

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM member_program_assignments
       ${whereSql}`,
      params
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const resolvedPage = Math.min(page, totalPages);
    const offset = (resolvedPage - 1) * pageSize;

    const [rows] = await db.query(
      `${selectAssignmentSql}
       ${whereSql}
       ORDER BY start_date DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return res.json({
      success: true,
      member_id: context.memberId,
      assignments: rows.map(serializeAssignment),
      pagination: {
        page: resolvedPage,
        page_size: pageSize,
        total,
        total_pages: totalPages,
      },
    });
  } catch (error) {
    return getErrorResponse(
      res,
      error,
      'MEMBER_PROGRAM_LIST_FAILED',
      'Unable to load member program assignments.'
    );
  }
};

// POST /api/members/:memberId/programs
const assignFitnessProgramToMember = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    ensureObjectBody(req.body);

    ensureAllowedFields(
      req.body,
      new Set(['membership_plan_id', 'program_id', 'start_date'])
    );

    const requestedMembershipPlanId = parsePositiveId(req.body.membership_plan_id);
    const requestedLegacyProgramId = parsePositiveId(req.body.program_id);

    if (Boolean(requestedMembershipPlanId) === Boolean(requestedLegacyProgramId)) {
      throw new ProgramAssignmentError(
        400,
        'INVALID_UNIFIED_PROGRAM_ID',
        'Provide exactly one valid membership_plan_id from the unified Programs catalog.'
      );
    }

    const suppliedStartDate = req.body.start_date == null
      ? null
      : parseDateOnly(req.body.start_date);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    // Lock the member row to serialize concurrent assignment requests
    // for this member.
    const member = await ensureMember(connection, context, true);

    if (member.status !== 'active') {
      throw new ProgramAssignmentError(
        409,
        'MEMBER_NOT_ACTIVE',
        'A fitness program can only be assigned to an active member.'
      );
    }

    let program;
    let programId;
    let membershipPlanId = null;

    if (requestedMembershipPlanId) {
      program = await ensureUnifiedProgram(
        connection,
        context,
        requestedMembershipPlanId,
        true
      );
      programId = Number(program.id);
      membershipPlanId = Number(program.membership_plan_id);
    } else {
      // Backward compatibility for existing clients using legacy program_id.
      programId = requestedLegacyProgramId;
      program = await ensureProgram(connection, context, programId, true);
      const [mappingRows] = await connection.query(
        `SELECT id, price, currency_code, price_configured
         FROM membership_plans
         WHERE organization_id = ?
           AND plan_category = 'program'
           AND legacy_program_id = ?
         LIMIT 1`,
        [context.organizationId, programId]
      );

      membershipPlanId = mappingRows.length
        ? Number(mappingRows[0].id)
        : null;

      program = {
        ...program,
        price: mappingRows.length && mappingRows[0].price != null
          ? String(mappingRows[0].price)
          : null,
        currency_code: mappingRows[0]?.currency_code || null,
        price_configured: mappingRows.length
          && Number(mappingRows[0].price_configured) === 1,
      };
    }

    let startDate = suppliedStartDate;

    if (!startDate) {
      const [dateRows] = await connection.query(
        `SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today`
      );
      startDate = dateRows[0].today;
    }

    const expectedEndDate = await getExpectedEndDate(
      connection,
      startDate,
      Number(program.duration_value),
      program.duration_unit
    );

    const [insertResult] = await connection.query(
      `INSERT INTO member_program_assignments
        (
          organization_id,
          member_id,
          program_id,
          membership_plan_id,
          branch_id,
          program_code_snapshot,
          program_name_snapshot,
          duration_value_snapshot,
          duration_unit_snapshot,
          fee_snapshot,
          currency_code_snapshot,
          price_configured_snapshot,
          start_date,
          expected_end_date,
          status,
          assigned_by_user_id
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        context.organizationId,
        context.memberId,
        programId,
        membershipPlanId,
        context.branchId,
        program.program_code,
        program.name,
        program.duration_value,
        program.duration_unit,
        program.price_configured ? program.price : null,
        program.currency_code,
        program.price_configured ? 1 : 0,
        startDate,
        expectedEndDate,
        context.userId,
      ]
    );

    const assignmentId = Number(insertResult.insertId);

    let programInvoiceNumber = null;
    const programPriceConfigured = program.price_configured === true
      || Number(program.price_configured) === 1;

    if (programPriceConfigured) {
      if (
        program.price == null ||
        !/^\d{1,10}(\.\d{1,2})?$/.test(String(program.price)) ||
        !program.currency_code
      ) {
        throw new ProgramAssignmentError(
          409,
          'INVALID_PROGRAM_FEE_CONFIGURATION',
          'The selected program has an invalid configured fee or currency.'
        );
      }

      const [invoiceYearRows] = await connection.query(
        'SELECT YEAR(CURRENT_DATE()) AS invoice_year'
      );

      const invoiceYear = Number(invoiceYearRows[0]?.invoice_year);

      if (!Number.isInteger(invoiceYear) || invoiceYear < 2000) {
        throw new Error('Unable to determine program invoice year.');
      }

      programInvoiceNumber =
        `PGI-${invoiceYear}-${String(assignmentId).padStart(8, '0')}`;

      await connection.query(
        `INSERT INTO member_program_invoices
          (
            organization_id,
            assignment_id,
            member_id,
            branch_id,
            invoice_number,
            program_code_snapshot,
            program_name_snapshot,
            member_code_snapshot,
            member_name_snapshot,
            invoice_date,
            due_date,
            total_amount,
            currency_code,
            status,
            created_by_user_id,
            updated_by_user_id
          )
         VALUES
          (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_DATE(),
            CURRENT_DATE(), ?, ?, 'issued', ?, ?
          )`,
        [
          context.organizationId,
          assignmentId,
          context.memberId,
          context.branchId,
          programInvoiceNumber,
          program.program_code,
          program.name,
          member.member_code,
          member.full_name,
          String(program.price),
          program.currency_code,
          context.userId,
          context.userId,
        ]
      );
    }

    const assignment = await ensureAssignment(
      connection,
      context,
      assignmentId
    );

    await writeAuditLog(connection, req, context, {
      action: 'MEMBER_PROGRAM_ASSIGNED',
      entityType: 'member_program_assignment',
      entityId: assignmentId,
      description:
        `Assigned fitness program ${program.program_code} to member ${member.member_code}; ` +
        `assignment_id=${assignmentId}; start_date=${startDate}; ` +
        `expected_end_date=${expectedEndDate}.`,
      oldValues: {
        record_exists: false,
      },
      newValues: {
        record_exists: true,
        program_id: programId,
        membership_plan_id: membershipPlanId,
        program_code: program.program_code,
        program_name: program.name,
        duration_value: Number(program.duration_value),
        duration_unit: program.duration_unit,
        fee: programPriceConfigured ? String(program.price) : null,
        currency_code: program.currency_code || null,
        invoice_number: programInvoiceNumber,
        start_date: startDate,
        expected_end_date: expectedEndDate,
        status: 'active',
        assigned_branch_id: context.branchId,
      },
      metadata: buildMemberAuditMetadata(member, {
        member_program_assignment: {
          assignment_id: assignmentId,
          program_id: programId,
          membership_plan_id: membershipPlanId,
          program_code: program.program_code,
          program_name: program.name,
          fee: programPriceConfigured ? String(program.price) : null,
          currency_code: program.currency_code || null,
          invoice_number: programInvoiceNumber,
          assigned_branch_id: context.branchId,
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Fitness program assigned to member successfully.',
      assignment: serializeAssignment(assignment),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Program assignment rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBER_PROGRAM_ASSIGN_FAILED',
      'Unable to assign this fitness program to the member.'
    );
  } finally {
    if (connection) connection.release();
  }
};

// Helpers for the pause/resume lifecycle.
const parseAssignmentId = (req) => {
  const assignmentId = parsePositiveId(req.params.assignmentId);
  if (!assignmentId) {
    throw new ProgramAssignmentError(
      400,
      'INVALID_MEMBER_PROGRAM_ASSIGNMENT_ID',
      'Invalid program assignment ID.'
    );
  }
  return assignmentId;
};

const parseOptionalReason = (value, fieldName = 'reason') => {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 500) {
    throw new ProgramAssignmentError(
      400,
      'INVALID_PROGRAM_ACTION_REASON',
      `${fieldName} must be text with a maximum of 500 characters.`
    );
  }
  return value.trim() || null;
};

const hasStaffPermission = (req, permissionKey) =>
  Array.isArray(req.gymStaff?.permissions) &&
  req.gymStaff.permissions.includes(permissionKey);

const getOpenPause = async (connection, context, assignmentId, forUpdate = false) => {
  const [rows] = await connection.query(
    `SELECT
       id,
       organization_id,
       assignment_id,
       DATE_FORMAT(paused_on, '%Y-%m-%d') AS paused_on,
       paused_at,
       pause_reason,
       DATE_FORMAT(original_expected_end_date, '%Y-%m-%d') AS original_expected_end_date
     FROM member_program_assignment_pauses
     WHERE organization_id = ?
       AND assignment_id = ?
       AND resumed_at IS NULL
       AND closed_at IS NULL
     ORDER BY id DESC
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [context.organizationId, assignmentId]
  );
  return rows[0] || null;
};

const calculatePausePreview = async (connection, pause) => {
  const [rows] = await connection.query(
    `SELECT
       DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today,
       GREATEST(DATEDIFF(CURRENT_DATE(), ?), 0) AS frozen_days,
       DATE_FORMAT(
         DATE_ADD(
           ?,
           INTERVAL GREATEST(DATEDIFF(CURRENT_DATE(), ?), 0) DAY
         ),
         '%Y-%m-%d'
       ) AS proposed_expected_end_date`,
    [
      pause.paused_on,
      pause.original_expected_end_date,
      pause.paused_on,
    ]
  );
  return rows[0];
};

// POST /api/members/:memberId/programs/:assignmentId/pause
const pauseMemberProgramAssignment = async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const context = getContext(req);
    ensureObjectBody(req.body);
    ensureAllowedFields(req.body, new Set(['reason']));
    const assignmentId = parseAssignmentId(req);
    const reason = parseOptionalReason(req.body.reason, 'Pause reason');

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const member = await ensureMember(connection, context, true);
    const current = await ensureAssignment(connection, context, assignmentId, true);

    if (current.status !== 'active') {
      throw new ProgramAssignmentError(
        409,
        'PROGRAM_NOT_ACTIVE',
        'Only an active program can be paused.'
      );
    }

    const existingOpenPause = await getOpenPause(
      connection,
      context,
      assignmentId,
      true
    );
    if (existingOpenPause) {
      throw new ProgramAssignmentError(
        409,
        'PROGRAM_ALREADY_PAUSED',
        'This program already has an open pause period.'
      );
    }

    await connection.query(
      `INSERT INTO member_program_assignment_pauses
        (
          organization_id,
          assignment_id,
          paused_on,
          paused_at,
          pause_reason,
          paused_by_user_id,
          original_expected_end_date
        )
       VALUES (?, ?, CURRENT_DATE(), CURRENT_TIMESTAMP(), ?, ?, ?)`,
      [
        context.organizationId,
        assignmentId,
        reason,
        context.userId,
        current.expected_end_date,
      ]
    );

    await connection.query(
      `UPDATE member_program_assignments
       SET status = 'paused', updated_by_user_id = ?
       WHERE organization_id = ? AND member_id = ? AND id = ?`,
      [context.userId, context.organizationId, context.memberId, assignmentId]
    );

    const updated = await ensureAssignment(connection, context, assignmentId);
    await writeAuditLog(connection, req, context, {
      action: 'MEMBER_PROGRAM_PAUSED',
      entityType: 'member_program_assignment',
      entityId: assignmentId,
      description:
        `Paused program assignment ${assignmentId} for member ${member.member_code}.` +
        (reason ? ` Reason: ${reason}` : ''),
      oldValues: {
        status: current.status,
        expected_end_date: current.expected_end_date,
      },
      newValues: {
        status: 'paused',
        paused_on: updated.current_pause_on,
        pause_reason: reason,
        expected_end_date: current.expected_end_date,
      },
      metadata: buildMemberAuditMetadata(member, {
        member_program_assignment: {
          assignment_id: assignmentId,
          program_code: current.program_code_snapshot,
          action: 'pause',
          branch_id: context.branchId,
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;
    return res.json({
      success: true,
      message: 'Program paused successfully.',
      assignment: serializeAssignment(updated),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Program pause rollback failed:', rollbackError.message);
      }
    }
    return getErrorResponse(
      res, error, 'MEMBER_PROGRAM_PAUSE_FAILED',
      'Unable to pause this program.'
    );
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/members/:memberId/programs/:assignmentId/resume-preview
const getMemberProgramResumePreview = async (req, res) => {
  try {
    const context = getContext(req);
    const assignmentId = parseAssignmentId(req);
    const assignment = await ensureAssignment(db, context, assignmentId);
    if (assignment.status !== 'paused') {
      throw new ProgramAssignmentError(
        409,
        'PROGRAM_NOT_PAUSED',
        'Only a paused program can be resumed.'
      );
    }
    const pause = await getOpenPause(db, context, assignmentId);
    if (!pause) {
      throw new ProgramAssignmentError(
        409,
        'OPEN_PROGRAM_PAUSE_NOT_FOUND',
        'The active pause record is missing. Contact an administrator before resuming.'
      );
    }
    const calculated = await calculatePausePreview(db, pause);
    return res.json({
      success: true,
      preview: {
        assignment_id: assignmentId,
        paused_on: pause.paused_on,
        today: calculated.today,
        frozen_days: Number(calculated.frozen_days || 0),
        current_expected_end_date: assignment.expected_end_date,
        proposed_expected_end_date: calculated.proposed_expected_end_date,
        can_approve_extension: hasStaffPermission(
          req,
          'member_programs.pause_extension.approve'
        ),
      },
    });
  } catch (error) {
    return getErrorResponse(
      res, error, 'MEMBER_PROGRAM_RESUME_PREVIEW_FAILED',
      'Unable to calculate the program resume dates.'
    );
  }
};

// POST /api/members/:memberId/programs/:assignmentId/resume
// The server recalculates frozen calendar days; client-supplied dates are never accepted.
const resumeMemberProgramAssignment = async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const context = getContext(req);
    ensureObjectBody(req.body);
    ensureAllowedFields(req.body, new Set(['extend_end_date']));
    const assignmentId = parseAssignmentId(req);
    if (typeof req.body.extend_end_date !== 'boolean') {
      throw new ProgramAssignmentError(
        400,
        'RESUME_EXTENSION_DECISION_REQUIRED',
        'Choose whether to extend the program end date.'
      );
    }
    const extendEndDate = req.body.extend_end_date;
    if (
      extendEndDate &&
      !hasStaffPermission(req, 'member_programs.pause_extension.approve')
    ) {
      throw new ProgramAssignmentError(
        403,
        'PROGRAM_EXTENSION_APPROVAL_REQUIRED',
        'You do not have permission to approve a program end-date extension.'
      );
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const member = await ensureMember(connection, context, true);
    const current = await ensureAssignment(connection, context, assignmentId, true);
    if (current.status !== 'paused') {
      throw new ProgramAssignmentError(
        409,
        'PROGRAM_NOT_PAUSED',
        'Only a paused program can be resumed.'
      );
    }

    const pause = await getOpenPause(connection, context, assignmentId, true);
    if (!pause) {
      throw new ProgramAssignmentError(
        409,
        'OPEN_PROGRAM_PAUSE_NOT_FOUND',
        'The active pause record is missing. Contact an administrator before resuming.'
      );
    }

    const calculated = await calculatePausePreview(connection, pause);
    const frozenDays = Number(calculated.frozen_days || 0);
    if (extendEndDate && frozenDays === 0) {
      throw new ProgramAssignmentError(
        409,
        'NO_PROGRAM_DAYS_TO_EXTEND',
        'There are no completed calendar days in this pause period to add to the program end date.'
      );
    }
    const finalEndDate = extendEndDate
      ? calculated.proposed_expected_end_date
      : current.expected_end_date;
    const decision = extendEndDate ? 'extended' : 'not_extended';

    await connection.query(
      `UPDATE member_program_assignment_pauses
       SET resumed_on = CURRENT_DATE(),
           resumed_at = CURRENT_TIMESTAMP(),
           frozen_days = ?,
           extension_decision = ?,
           proposed_expected_end_date = ?,
           final_expected_end_date = ?,
           resumed_by_user_id = ?
       WHERE organization_id = ?
         AND assignment_id = ?
         AND id = ?
         AND resumed_at IS NULL
         AND closed_at IS NULL`,
      [
        frozenDays,
        decision,
        calculated.proposed_expected_end_date,
        finalEndDate,
        context.userId,
        context.organizationId,
        assignmentId,
        pause.id,
      ]
    );

    await connection.query(
      `UPDATE member_program_assignments
       SET status = 'active',
           expected_end_date = ?,
           updated_by_user_id = ?
       WHERE organization_id = ? AND member_id = ? AND id = ?`,
      [finalEndDate, context.userId, context.organizationId, context.memberId, assignmentId]
    );

    const updated = await ensureAssignment(connection, context, assignmentId);
    await writeAuditLog(connection, req, context, {
      action: 'MEMBER_PROGRAM_RESUMED',
      entityType: 'member_program_assignment',
      entityId: assignmentId,
      description:
        `Resumed program assignment ${assignmentId} for member ${member.member_code}; ` +
        `frozen_days=${frozenDays}; extension_decision=${decision}; ` +
        `previous_end_date=${current.expected_end_date}; final_end_date=${finalEndDate}.`,
      oldValues: {
        status: current.status,
        expected_end_date: current.expected_end_date,
      },
      newValues: {
        status: 'active',
        frozen_days: frozenDays,
        extension_decision: decision,
        proposed_expected_end_date: calculated.proposed_expected_end_date,
        expected_end_date: finalEndDate,
      },
      metadata: buildMemberAuditMetadata(member, {
        member_program_assignment: {
          assignment_id: assignmentId,
          program_code: current.program_code_snapshot,
          action: 'resume',
          frozen_days: frozenDays,
          extension_decision: decision,
          final_expected_end_date: finalEndDate,
          branch_id: context.branchId,
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;
    return res.json({
      success: true,
      message: extendEndDate
        ? `Program resumed and extended by ${frozenDays} calendar day(s).`
        : 'Program resumed without extending its end date.',
      frozen_days: frozenDays,
      extension_decision: decision,
      proposed_expected_end_date: calculated.proposed_expected_end_date,
      assignment: serializeAssignment(updated),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Program resume rollback failed:', rollbackError.message);
      }
    }
    return getErrorResponse(
      res, error, 'MEMBER_PROGRAM_RESUME_FAILED',
      'Unable to resume this program.'
    );
  } finally {
    if (connection) connection.release();
  }
};

const finishMemberProgramAssignment = async (req, res, terminalStatus) => {
  let connection;
  let transactionStarted = false;
  try {
    const context = getContext(req);
    ensureObjectBody(req.body);
    ensureAllowedFields(req.body, new Set(['reason']));
    const assignmentId = parseAssignmentId(req);
    const reason = parseOptionalReason(req.body.reason, 'Action reason');

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const member = await ensureMember(connection, context, true);
    const current = await ensureAssignment(connection, context, assignmentId, true);
    if (!['active', 'paused'].includes(current.status)) {
      throw new ProgramAssignmentError(
        409,
        'PROGRAM_ALREADY_FINALIZED',
        `A ${current.status} program cannot be ${terminalStatus}.`
      );
    }

    if (current.status === 'paused') {
      const pause = await getOpenPause(connection, context, assignmentId, true);
      if (!pause) {
        throw new ProgramAssignmentError(
          409,
          'OPEN_PROGRAM_PAUSE_NOT_FOUND',
          'The active pause record is missing. Contact an administrator before finalizing this program.'
        );
      }
      const closedDecision = terminalStatus === 'completed'
        ? 'completed_while_paused'
        : 'cancelled_while_paused';
      await connection.query(
        `UPDATE member_program_assignment_pauses
         SET closed_on = CURRENT_DATE(),
             closed_at = CURRENT_TIMESTAMP(),
             closed_by_user_id = ?,
             frozen_days = GREATEST(DATEDIFF(CURRENT_DATE(), paused_on), 0),
             extension_decision = ?,
             proposed_expected_end_date = DATE_FORMAT(
               DATE_ADD(
                 original_expected_end_date,
                 INTERVAL GREATEST(DATEDIFF(CURRENT_DATE(), paused_on), 0) DAY
               ),
               '%Y-%m-%d'
             ),
             final_expected_end_date = ?
         WHERE organization_id = ?
           AND assignment_id = ?
           AND id = ?
           AND resumed_at IS NULL
           AND closed_at IS NULL`,
        [
          context.userId,
          closedDecision,
          current.expected_end_date,
          context.organizationId,
          assignmentId,
          pause.id,
        ]
      );
    }

    const [dateRows] = await connection.query(
      `SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today`
    );
    const today = dateRows[0].today;
    const completedOn = terminalStatus === 'completed' ? today : null;
    const cancelledOn = terminalStatus === 'cancelled' ? today : null;

    await connection.query(
      `UPDATE member_program_assignments
       SET status = ?,
           completed_on = ?,
           cancelled_on = ?,
           updated_by_user_id = ?
       WHERE organization_id = ? AND member_id = ? AND id = ?`,
      [
        terminalStatus,
        completedOn,
        cancelledOn,
        context.userId,
        context.organizationId,
        context.memberId,
        assignmentId,
      ]
    );

    const updated = await ensureAssignment(connection, context, assignmentId);
    await writeAuditLog(connection, req, context, {
      action: terminalStatus === 'completed'
        ? 'MEMBER_PROGRAM_COMPLETED'
        : 'MEMBER_PROGRAM_CANCELLED',
      entityType: 'member_program_assignment',
      entityId: assignmentId,
      description:
        `${terminalStatus === 'completed' ? 'Completed' : 'Cancelled'} program assignment ` +
        `${assignmentId} for member ${member.member_code}.` +
        (reason ? ` Reason: ${reason}` : ''),
      oldValues: {
        status: current.status,
        expected_end_date: current.expected_end_date,
      },
      newValues: {
        status: terminalStatus,
        completed_on: completedOn,
        cancelled_on: cancelledOn,
        pause_closed_without_extension: current.status === 'paused',
        reason,
      },
      metadata: buildMemberAuditMetadata(member, {
        member_program_assignment: {
          assignment_id: assignmentId,
          program_code: current.program_code_snapshot,
          action: terminalStatus,
          branch_id: context.branchId,
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;
    return res.json({
      success: true,
      message: `Program ${terminalStatus} successfully.`,
      assignment: serializeAssignment(updated),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Program finalization rollback failed:', rollbackError.message);
      }
    }
    return getErrorResponse(
      res,
      error,
      terminalStatus === 'completed'
        ? 'MEMBER_PROGRAM_COMPLETE_FAILED'
        : 'MEMBER_PROGRAM_CANCEL_FAILED',
      `Unable to ${terminalStatus} this program.`
    );
  } finally {
    if (connection) connection.release();
  }
};

// POST /api/members/:memberId/programs/:assignmentId/complete
const completeMemberProgramAssignment = (req, res) =>
  finishMemberProgramAssignment(req, res, 'completed');

// POST /api/members/:memberId/programs/:assignmentId/cancel
const cancelMemberProgramAssignment = (req, res) =>
  finishMemberProgramAssignment(req, res, 'cancelled');

// GET /api/members/:memberId/programs/:assignmentId/pause-history
const listMemberProgramPauseHistory = async (req, res) => {
  try {
    const context = getContext(req);
    const assignmentId = parseAssignmentId(req);
    await ensureAssignment(db, context, assignmentId);
    const [rows] = await db.query(
      `SELECT
         id,
         DATE_FORMAT(paused_on, '%Y-%m-%d') AS paused_on,
         DATE_FORMAT(resumed_on, '%Y-%m-%d') AS resumed_on,
         DATE_FORMAT(closed_on, '%Y-%m-%d') AS closed_on,
         pause_reason,
         frozen_days,
         extension_decision,
         DATE_FORMAT(original_expected_end_date, '%Y-%m-%d') AS original_expected_end_date,
         DATE_FORMAT(proposed_expected_end_date, '%Y-%m-%d') AS proposed_expected_end_date,
         DATE_FORMAT(final_expected_end_date, '%Y-%m-%d') AS final_expected_end_date,
         paused_by_user_id,
         resumed_by_user_id,
         closed_by_user_id
       FROM member_program_assignment_pauses
       WHERE organization_id = ? AND assignment_id = ?
       ORDER BY id DESC`,
      [context.organizationId, assignmentId]
    );
    return res.json({ success: true, history: rows });
  } catch (error) {
    return getErrorResponse(
      res, error, 'MEMBER_PROGRAM_PAUSE_HISTORY_FAILED',
      'Unable to load program pause history.'
    );
  }
};

module.exports = {
  listAvailableUnifiedPrograms,
  listMemberProgramAssignments,
  assignFitnessProgramToMember,
  pauseMemberProgramAssignment,
  getMemberProgramResumePreview,
  resumeMemberProgramAssignment,
  completeMemberProgramAssignment,
  cancelMemberProgramAssignment,
  listMemberProgramPauseHistory,
};