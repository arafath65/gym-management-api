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

const selectAssignmentSql = `
  SELECT
    id,
    organization_id,
    member_id,
    program_id,
    branch_id,
    program_code_snapshot,
    program_name_snapshot,
    duration_value_snapshot,
    duration_unit_snapshot,
    DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
    DATE_FORMAT(expected_end_date, '%Y-%m-%d') AS expected_end_date,
    status,
    DATE_FORMAT(completed_on, '%Y-%m-%d') AS completed_on,
    DATE_FORMAT(cancelled_on, '%Y-%m-%d') AS cancelled_on,
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
  branch_id: Number(row.branch_id),
  program_code: row.program_code_snapshot,
  program_name: row.program_name_snapshot,
  duration_value: Number(row.duration_value_snapshot),
  duration_unit: row.duration_unit_snapshot,
  start_date: row.start_date,
  expected_end_date: row.expected_end_date,
  status: row.status,
  completed_on: row.completed_on,
  cancelled_on: row.cancelled_on,
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
      new Set(['program_id', 'start_date'])
    );

    const programId = parsePositiveId(req.body.program_id);

    if (!programId) {
      throw new ProgramAssignmentError(
        400,
        'INVALID_FITNESS_PROGRAM_ID',
        'A valid fitness program ID is required.'
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

    const program = await ensureProgram(
      connection,
      context,
      programId,
      true
    );

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
          branch_id,
          program_code_snapshot,
          program_name_snapshot,
          duration_value_snapshot,
          duration_unit_snapshot,
          start_date,
          expected_end_date,
          status,
          assigned_by_user_id
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        context.organizationId,
        context.memberId,
        programId,
        context.branchId,
        program.program_code,
        program.name,
        program.duration_value,
        program.duration_unit,
        startDate,
        expectedEndDate,
        context.userId,
      ]
    );

    const assignmentId = Number(insertResult.insertId);

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
        program_code: program.program_code,
        program_name: program.name,
        duration_value: Number(program.duration_value),
        duration_unit: program.duration_unit,
        start_date: startDate,
        expected_end_date: expectedEndDate,
        status: 'active',
        assigned_branch_id: context.branchId,
      },
      metadata: buildMemberAuditMetadata(member, {
        member_program_assignment: {
          assignment_id: assignmentId,
          program_id: programId,
          program_code: program.program_code,
          program_name: program.name,
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

// PATCH /api/members/:memberId/programs/:assignmentId/status
const updateMemberProgramAssignmentStatus = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    ensureObjectBody(req.body);

    ensureAllowedFields(req.body, new Set(['status']));

    const assignmentId = parsePositiveId(req.params.assignmentId);

    if (!assignmentId) {
      throw new ProgramAssignmentError(
        400,
        'INVALID_MEMBER_PROGRAM_ASSIGNMENT_ID',
        'Invalid program assignment ID.'
      );
    }

    const newStatus = req.body.status;

    if (!VALID_STATUSES.has(newStatus)) {
      throw new ProgramAssignmentError(
        400,
        'INVALID_MEMBER_PROGRAM_STATUS',
        'Status must be active, paused, completed or cancelled.'
      );
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const member = await ensureMember(connection, context, true);

    const current = await ensureAssignment(
      connection,
      context,
      assignmentId,
      true
    );

    if (current.status === newStatus) {
      await connection.commit();
      transactionStarted = false;

      return res.json({
        success: true,
        message: `Program assignment is already ${newStatus}.`,
        assignment: serializeAssignment(current),
      });
    }

    const allowedTransitions = {
      active: new Set(['paused', 'completed', 'cancelled']),
      paused: new Set(['active', 'completed', 'cancelled']),
      completed: new Set(),
      cancelled: new Set(),
    };

    if (!allowedTransitions[current.status]?.has(newStatus)) {
      throw new ProgramAssignmentError(
        409,
        'INVALID_MEMBER_PROGRAM_STATUS_TRANSITION',
        `A ${current.status} assignment cannot be changed to ${newStatus}.`
      );
    }

    let completedOn = null;
    let cancelledOn = null;

    if (newStatus === 'completed') {
      const [dateRows] = await connection.query(
        `SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today`
      );
      completedOn = dateRows[0].today;
    }

    if (newStatus === 'cancelled') {
      const [dateRows] = await connection.query(
        `SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today`
      );
      cancelledOn = dateRows[0].today;
    }

    await connection.query(
      `UPDATE member_program_assignments
       SET status = ?,
           completed_on = ?,
           cancelled_on = ?,
           updated_by_user_id = ?
       WHERE organization_id = ?
         AND member_id = ?
         AND id = ?`,
      [
        newStatus,
        completedOn,
        cancelledOn,
        context.userId,
        context.organizationId,
        context.memberId,
        assignmentId,
      ]
    );

    const updated = await ensureAssignment(
      connection,
      context,
      assignmentId
    );

    await writeAuditLog(connection, req, context, {
      action: 'MEMBER_PROGRAM_STATUS_CHANGED',
      entityType: 'member_program_assignment',
      entityId: assignmentId,
      description:
        `Changed member program assignment ${assignmentId} ` +
        `for member ${member.member_code} from ${current.status} to ${newStatus}.`,
      oldValues: {
        status: current.status,
        completed_on: current.completed_on,
        cancelled_on: current.cancelled_on,
      },
      newValues: {
        status: newStatus,
        completed_on: completedOn,
        cancelled_on: cancelledOn,
      },
      metadata: buildMemberAuditMetadata(member, {
        member_program_assignment: {
          assignment_id: assignmentId,
          program_id: Number(current.program_id),
          program_code: current.program_code_snapshot,
          status: newStatus,
          action_branch_id: context.branchId,
        },
      }),
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: `Program assignment updated to ${newStatus}.`,
      assignment: serializeAssignment(updated),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Program assignment status rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBER_PROGRAM_STATUS_UPDATE_FAILED',
      'Unable to update this program assignment.'
    );
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  listMemberProgramAssignments,
  assignFitnessProgramToMember,
  updateMemberProgramAssignmentStatus,
};