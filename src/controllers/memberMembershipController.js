'use strict';

const db = require('../config/db');
const {
  writeAuditLog,
  buildMemberAuditMetadata,
} = require('../services/gymAuditService');

const VALID_UNITS = new Set(['day', 'week', 'month', 'year']);

class MembershipError extends Error {
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
    throw new MembershipError(
      401,
      'MEMBER_MEMBERSHIP_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const ensureObjectBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MembershipError(
      400,
      'INVALID_MEMBER_MEMBERSHIP_REQUEST',
      'Request body must be a valid object.'
    );
  }
};

const ensureAllowedFields = (body, allowed) => {
  const unexpected = Object.keys(body).filter((key) => !allowed.has(key));

  if (unexpected.length) {
    throw new MembershipError(
      400,
      'UNSUPPORTED_MEMBER_MEMBERSHIP_FIELDS',
      `Unsupported fields: ${unexpected.join(', ')}`
    );
  }
};

const parseDateOnly = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new MembershipError(
      400,
      'INVALID_MEMBERSHIP_DATE',
      'Date must use YYYY-MM-DD format.'
    );
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new MembershipError(
      400,
      'INVALID_MEMBERSHIP_DATE',
      'Date is not a valid calendar date.'
    );
  }

  return value;
};

const normalizeNotes = (value) => {
  if (value == null || value === '') return null;

  if (typeof value !== 'string' || value.trim().length > 1000) {
    throw new MembershipError(
      400,
      'INVALID_MEMBERSHIP_NOTES',
      'Notes must be text with a maximum of 1000 characters.'
    );
  }

  return value.trim() || null;
};

const getToday = async (connection) => {
  const [rows] = await connection.query(
    "SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today"
  );

  return rows[0].today;
};

const addDateInterval = async (
  connection,
  startDate,
  value,
  unit
) => {
  if (!VALID_UNITS.has(unit)) {
    throw new MembershipError(
      400,
      'INVALID_MEMBERSHIP_INTERVAL',
      'Membership duration or billing interval is invalid.'
    );
  }

  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 65535) {
    throw new MembershipError(
      400,
      'INVALID_MEMBERSHIP_INTERVAL',
      'Membership interval must be a positive whole number.'
    );
  }

  const [rows] = await connection.query(
    `SELECT DATE_FORMAT(
       DATE_ADD(?, INTERVAL ? ${unit}),
       '%Y-%m-%d'
     ) AS calculated_date`,
    [startDate, amount]
  );

  if (!rows[0]?.calculated_date) {
    throw new Error('Unable to calculate membership dates.');
  }

  return rows[0].calculated_date;
};

const getMemberRows = async (
  connection,
  context,
  memberIds,
  forUpdate = false
) => {
  const uniqueIds = [...new Set(memberIds)].sort((a, b) => a - b);

  const placeholders = uniqueIds.map(() => '?').join(', ');

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
       AND m.id IN (${placeholders})
     ORDER BY m.id ASC${forUpdate ? ' FOR UPDATE' : ''}`,
    [context.organizationId, ...uniqueIds]
  );

  if (rows.length !== uniqueIds.length) {
    throw new MembershipError(
      404,
      'MEMBERSHIP_MEMBER_NOT_FOUND',
      'One or more selected members were not found in this organization.'
    );
  }

  const result = new Map();

  for (const row of rows) {
    if (row.status !== 'active') {
      throw new MembershipError(
        409,
        'MEMBERSHIP_MEMBER_NOT_ACTIVE',
        `Member ${row.member_code} must be active to receive a membership.`
      );
    }

    result.set(Number(row.id), row);
  }

  return result;
};

const ensureMemberExists = async (connection, context) => {
  const [rows] = await connection.query(
    `SELECT id
     FROM members
     WHERE organization_id = ?
       AND id = ?
     LIMIT 1`,
    [context.organizationId, context.memberId]
  );

  if (!rows.length) {
    throw new MembershipError(
      404,
      'MEMBER_NOT_FOUND',
      'Member was not found in this organization.'
    );
  }
};

const getPlan = async (
  connection,
  organizationId,
  planId,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `SELECT
       id,
       organization_id,
       plan_code,
       name,
       package_type,
       validity_type,
       duration_value,
       duration_unit,
       billing_interval_value,
       billing_interval_unit,
       price,
       currency_code,
       included_members,
       paying_members,
       status
     FROM membership_plans
     WHERE organization_id = ?
       AND id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [organizationId, planId]
  );

  if (!rows.length) {
    throw new MembershipError(
      404,
      'MEMBERSHIP_PLAN_NOT_FOUND',
      'Membership plan was not found in this organization.'
    );
  }

  if (rows[0].status !== 'active') {
    throw new MembershipError(
      409,
      'MEMBERSHIP_PLAN_INACTIVE',
      'An inactive membership plan cannot be assigned.'
    );
  }

  return rows[0];
};

const calculateMembershipDates = async (
  connection,
  plan,
  startDate
) => {
  if (plan.validity_type === 'fixed') {
    const endDate = await addDateInterval(
      connection,
      startDate,
      plan.duration_value,
      plan.duration_unit
    );

    return {
      endDate,
      nextBillingDate: null,
    };
  }

  if (plan.validity_type === 'ongoing') {
    const nextBillingDate = await addDateInterval(
      connection,
      startDate,
      plan.billing_interval_value,
      plan.billing_interval_unit
    );

    return {
      endDate: null,
      nextBillingDate,
    };
  }

  throw new MembershipError(
    400,
    'INVALID_MEMBERSHIP_VALIDITY',
    'Unsupported membership validity type.'
  );
};

/*
 * Membership ranges use an exclusive end date:
 * end_date is the first date outside the assigned period.
 *
 * A following membership may start on the previous membership's
 * end_date without creating an overlap.
 */
const ensureNoOverlappingMemberships = async (
  connection,
  context,
  memberIds,
  startDate,
  endDate
) => {
  const uniqueIds = [...new Set(memberIds)];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const endBoundary = endDate || '9999-12-31';

  const [rows] = await connection.query(
    `SELECT
       mm.member_id,
       m.id AS membership_id,
       m.start_date,
       m.end_date
     FROM member_membership_members mm
     INNER JOIN member_memberships m
       ON m.organization_id = mm.organization_id
      AND m.id = mm.membership_id
     WHERE mm.organization_id = ?
       AND mm.member_id IN (${placeholders})
       AND mm.status = 'active'
       AND m.status = 'active'
       AND m.start_date < ?
       AND (m.end_date IS NULL OR m.end_date > ?)
     LIMIT 1
     FOR UPDATE`,
    [
      context.organizationId,
      ...uniqueIds,
      endBoundary,
      startDate,
    ]
  );

  if (rows.length) {
    throw new MembershipError(
      409,
      'MEMBER_MEMBERSHIP_PERIOD_OVERLAP',
      'One or more selected members already have a membership covering this period.'
    );
  }
};

const membershipSelectSql = `
  SELECT
    m.id,
    m.organization_id,
    m.membership_plan_id,
    m.branch_id,
    m.primary_member_id,
    m.renewed_from_membership_id,

    m.plan_code_snapshot,
    m.plan_name_snapshot,
    m.package_type_snapshot,
    m.validity_type_snapshot,

    m.duration_value_snapshot,
    m.duration_unit_snapshot,
    m.billing_interval_value_snapshot,
    m.billing_interval_unit_snapshot,

    m.price_snapshot,
    m.currency_code_snapshot,
    m.included_members_snapshot,
    m.paying_members_snapshot,

    DATE_FORMAT(m.start_date, '%Y-%m-%d') AS start_date,
    DATE_FORMAT(m.end_date, '%Y-%m-%d') AS end_date,
    DATE_FORMAT(m.next_billing_date, '%Y-%m-%d') AS next_billing_date,
    DATE_FORMAT(m.cancelled_on, '%Y-%m-%d') AS cancelled_on,

    m.status,

    CASE
      WHEN m.status = 'active' AND m.start_date > CURRENT_DATE()
        THEN 'scheduled'
      WHEN m.status = 'active'
       AND m.end_date IS NOT NULL
       AND m.end_date <= CURRENT_DATE()
        THEN 'expired'
      ELSE m.status
    END AS effective_status,

    m.cancellation_reason,
    m.notes,
    m.created_by_user_id,
    m.updated_by_user_id,
    m.created_at,
    m.updated_at
  FROM member_memberships m
`;

const getMembershipHeader = async (
  connection,
  context,
  membershipId,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `${membershipSelectSql}
     WHERE m.organization_id = ?
       AND m.id = ?
       AND EXISTS (
         SELECT 1
         FROM member_membership_members requested_member
         WHERE requested_member.organization_id = m.organization_id
           AND requested_member.membership_id = m.id
           AND requested_member.member_id = ?
       )
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [
      context.organizationId,
      membershipId,
      context.memberId,
    ]
  );

  if (!rows.length) {
    throw new MembershipError(
      404,
      'MEMBER_MEMBERSHIP_NOT_FOUND',
      'Membership was not found for this member.'
    );
  }

  return rows[0];
};

const getMembershipParticipants = async (
  connection,
  organizationId,
  membershipIds
) => {
  if (!membershipIds.length) return new Map();

  const placeholders = membershipIds.map(() => '?').join(', ');

  const [rows] = await connection.query(
    `SELECT
       mm.membership_id,
       mm.member_id,
       mm.member_role,
       mm.status,
       DATE_FORMAT(mm.joined_on, '%Y-%m-%d') AS joined_on,
       DATE_FORMAT(mm.ended_on, '%Y-%m-%d') AS ended_on,
       m.member_code,
       m.full_name
     FROM member_membership_members mm
     INNER JOIN members m
       ON m.organization_id = mm.organization_id
      AND m.id = mm.member_id
     WHERE mm.organization_id = ?
       AND mm.membership_id IN (${placeholders})
     ORDER BY mm.membership_id, mm.member_role, mm.member_id`,
    [organizationId, ...membershipIds]
  );

  const grouped = new Map();

  for (const row of rows) {
    const id = Number(row.membership_id);

    if (!grouped.has(id)) grouped.set(id, []);

    grouped.get(id).push({
      member_id: Number(row.member_id),
      member_code: row.member_code,
      full_name: row.full_name,
      member_role: row.member_role,
      status: row.status,
      joined_on: row.joined_on,
      ended_on: row.ended_on,
    });
  }

  return grouped;
};

const serializeMembership = (row, participants = []) => ({
  id: Number(row.id),
  plan_id: Number(row.membership_plan_id),
  branch_id: Number(row.branch_id),
  primary_member_id: Number(row.primary_member_id),

  requested_member_role: row.requested_member_role || null,

  renewed_from_membership_id:
    row.renewed_from_membership_id == null
      ? null
      : Number(row.renewed_from_membership_id),

  plan_code: row.plan_code_snapshot,
  plan_name: row.plan_name_snapshot,
  package_type: row.package_type_snapshot,
  validity_type: row.validity_type_snapshot,

  duration_value: row.duration_value_snapshot == null
    ? null
    : Number(row.duration_value_snapshot),

  duration_unit: row.duration_unit_snapshot,

  billing_interval_value: row.billing_interval_value_snapshot == null
    ? null
    : Number(row.billing_interval_value_snapshot),

  billing_interval_unit: row.billing_interval_unit_snapshot,

  price: String(row.price_snapshot),
  currency_code: row.currency_code_snapshot,
  included_members: Number(row.included_members_snapshot),
  paying_members: Number(row.paying_members_snapshot),

  start_date: row.start_date,
  end_date: row.end_date,
  next_billing_date: row.next_billing_date,

  status: row.effective_status || row.status,
  recorded_status: row.status,

  cancelled_on: row.cancelled_on,
  cancellation_reason: row.cancellation_reason,
  notes: row.notes,

  participants,

  created_by_user_id: Number(row.created_by_user_id),
  updated_by_user_id: Number(row.updated_by_user_id),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const getMembershipResponse = async (
  connection,
  context,
  membershipId
) => {
  const row = await getMembershipHeader(
    connection,
    context,
    membershipId
  );

  const grouped = await getMembershipParticipants(
    connection,
    context.organizationId,
    [membershipId]
  );

  return serializeMembership(row, grouped.get(Number(membershipId)) || []);
};

const writeMembershipAudit = async (
  connection,
  req,
  context,
  member,
  entry
) => {
  await writeAuditLog(
    connection,
    req,
    {
      organizationId: context.organizationId,
      branchId: context.branchId,
      userId: context.userId,
    },
    {
      ...entry,
      entityType: 'member_membership',
      metadata: buildMemberAuditMetadata(member, entry.metadata || {}),
    }
  );
};

const getErrorResponse = (res, error, fallbackCode, fallbackMessage) => {
  if (error instanceof MembershipError) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      code: 'MEMBER_MEMBERSHIP_CONFLICT',
      message: 'This membership participant is already recorded.',
    });
  }

  if (
    error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' ||
    error.errno === 3819
  ) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_MEMBER_MEMBERSHIP',
      message: 'Membership values do not satisfy the database rules.',
    });
  }

  console.error(
    `${fallbackCode}:`,
    error.code || '',
    error.message
  );

  return res.status(500).json({
    success: false,
    code: fallbackCode,
    message: fallbackMessage,
  });
};

// --------------------------------------------------
// GET /api/members/:memberId/memberships
// --------------------------------------------------

const listMemberMemberships = async (req, res) => {
  try {
    const context = getContext(req);
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.page_size ?? 20);

    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      throw new MembershipError(
        400,
        'INVALID_MEMBERSHIP_PAGINATION',
        'Page must be positive and page_size must be between 1 and 100.'
      );
    }

    const validFilters = new Set([
      'active',
      'scheduled',
      'expired',
      'suspended',
      'cancelled',
    ]);

    const statusExpression = `CASE
      WHEN m.status = 'active' AND m.start_date > CURRENT_DATE()
        THEN 'scheduled'
      WHEN m.status = 'active'
       AND m.end_date IS NOT NULL
       AND m.end_date <= CURRENT_DATE()
        THEN 'expired'
      ELSE m.status
    END`;

    const filters = [
      'm.organization_id = ?',
      'mm.organization_id = m.organization_id',
      'mm.member_id = ?',
    ];

    const params = [
      context.organizationId,
      context.memberId,
    ];

    if (req.query.status !== undefined) {
      if (!validFilters.has(req.query.status)) {
        throw new MembershipError(
          400,
          'INVALID_MEMBERSHIP_STATUS_FILTER',
          'Invalid membership status filter.'
        );
      }

      filters.push(`${statusExpression} = ?`);
      params.push(req.query.status);

      // Ended couple participants must not see this as a current membership.
      if (req.query.status === 'active') {
        filters.push("mm.status = 'active'");
      }
    }

    await ensureMemberExists(db, context);

    const whereSql = `WHERE ${filters.join(' AND ')}`;

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM member_memberships m
       INNER JOIN member_membership_members mm
         ON mm.organization_id = m.organization_id
        AND mm.membership_id = m.id
       ${whereSql}`,
      params
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const resolvedPage = Math.min(page, totalPages);
    const offset = (resolvedPage - 1) * pageSize;

    const [rows] = await db.query(
      `${membershipSelectSql}
       INNER JOIN member_membership_members mm
         ON mm.organization_id = m.organization_id
        AND mm.membership_id = m.id
       ${whereSql}
       ORDER BY m.start_date DESC, m.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const ids = rows.map((row) => Number(row.id));

    const participants = await getMembershipParticipants(
      db,
      context.organizationId,
      ids
    );

    return res.json({
      success: true,
      member_id: context.memberId,
      memberships: rows.map((row) => {
        row.requested_member_role = row.primary_member_id === context.memberId
          ? 'primary'
          : 'included';

        return serializeMembership(
          row,
          participants.get(Number(row.id)) || []
        );
      }),
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
      'MEMBER_MEMBERSHIP_LIST_FAILED',
      'Unable to load member memberships.'
    );
  }
};

// --------------------------------------------------
// ASSIGN / RENEW SHARED IMPLEMENTATION
// --------------------------------------------------

const createMembership = async (req, res, isRenewal) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    ensureObjectBody(req.body);

    ensureAllowedFields(
      req.body,
      new Set([
        'plan_id',
        'start_date',
        'included_member_id',
        'notes',
      ])
    );

    const planId = parsePositiveId(req.body.plan_id);

    if (!planId) {
      throw new MembershipError(
        400,
        'INVALID_MEMBERSHIP_PLAN_ID',
        'A valid membership plan ID is required.'
      );
    }

    const renewalFromId = isRenewal
      ? parsePositiveId(req.params.membershipId)
      : null;

    if (isRenewal && !renewalFromId) {
      throw new MembershipError(
        400,
        'INVALID_RENEWAL_MEMBERSHIP_ID',
        'A valid previous membership ID is required.'
      );
    }

    const suppliedStartDate = req.body.start_date == null
      ? null
      : parseDateOnly(req.body.start_date);

    const suppliedIncludedId = req.body.included_member_id == null ||
      req.body.included_member_id === ''
      ? null
      : parsePositiveId(req.body.included_member_id);

    if (
      req.body.included_member_id != null &&
      req.body.included_member_id !== '' &&
      !suppliedIncludedId
    ) {
      throw new MembershipError(
        400,
        'INVALID_INCLUDED_MEMBER_ID',
        'Included member ID is invalid.'
      );
    }

    const notes = normalizeNotes(req.body.notes);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [planPreviewRows] = await connection.query(
      `SELECT
         id,
         package_type,
         validity_type
       FROM membership_plans
       WHERE organization_id = ?
         AND id = ?
       LIMIT 1`,
      [context.organizationId, planId]
    );

    if (!planPreviewRows.length) {
      throw new MembershipError(
        404,
        'MEMBERSHIP_PLAN_NOT_FOUND',
        'Membership plan was not found in this organization.'
      );
    }

    const preview = planPreviewRows[0];

    if (preview.package_type === 'individual' && suppliedIncludedId) {
      throw new MembershipError(
        400,
        'UNEXPECTED_INCLUDED_MEMBER',
        'Individual membership plans cannot include a second member.'
      );
    }

    let renewalPreview = null;
    let previousIncludedMemberId = null;

    if (isRenewal) {
      const [previousRows] = await connection.query(
        `SELECT
           id,
           primary_member_id,
           validity_type_snapshot,
           status,
           DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
         FROM member_memberships
         WHERE organization_id = ?
           AND id = ?
           AND primary_member_id = ?
         LIMIT 1`,
        [
          context.organizationId,
          renewalFromId,
          context.memberId,
        ]
      );

      if (!previousRows.length) {
        throw new MembershipError(
          404,
          'MEMBERSHIP_RENEWAL_SOURCE_NOT_FOUND',
          'The previous membership was not found for this primary member.'
        );
      }

      renewalPreview = previousRows[0];

      if (renewalPreview.status === 'cancelled') {
        throw new MembershipError(
          409,
          'CANCELLED_MEMBERSHIP_CANNOT_RENEW',
          'A cancelled membership cannot be renewed.'
        );
      }

      if (
        renewalPreview.validity_type_snapshot !== 'fixed' ||
        !renewalPreview.end_date
      ) {
        throw new MembershipError(
          409,
          'ONGOING_MEMBERSHIP_RENEWAL_NOT_REQUIRED',
          'Ongoing memberships use billing intervals and cannot be renewed as fixed memberships.'
        );
      }

      const [previousParticipants] = await connection.query(
        `SELECT member_id
         FROM member_membership_members
         WHERE organization_id = ?
           AND membership_id = ?
           AND member_role = 'included'
           AND status = 'active'
         LIMIT 1`,
        [context.organizationId, renewalFromId]
      );

      if (previousParticipants.length) {
        previousIncludedMemberId = Number(
          previousParticipants[0].member_id
        );
      }
    }

    let includedMemberId = null;

    if (preview.package_type === 'couple') {
      includedMemberId =
        suppliedIncludedId ||
        (isRenewal ? previousIncludedMemberId : null);

      if (!includedMemberId) {
        throw new MembershipError(
          400,
          'COUPLE_INCLUDED_MEMBER_REQUIRED',
          'Select the second member for this couple membership.'
        );
      }

      if (includedMemberId === context.memberId) {
        throw new MembershipError(
          400,
          'COUPLE_MEMBERS_MUST_BE_DIFFERENT',
          'The primary member and included member must be different.'
        );
      }
    }

    const memberIds = [
      context.memberId,
      ...(includedMemberId ? [includedMemberId] : []),
    ];

    // Lock selected members in sorted order to reduce deadlocks
    // and serialize concurrent overlapping membership assignments.
    const members = await getMemberRows(
      connection,
      context,
      memberIds,
      true
    );

    const primaryMember = members.get(context.memberId);

    if (!primaryMember) {
      throw new MembershipError(
        404,
        'MEMBERSHIP_PRIMARY_MEMBER_NOT_FOUND',
        'Primary member was not found.'
      );
    }

    let renewalSource = null;

    if (isRenewal) {
      const [sourceRows] = await connection.query(
        `SELECT
           id,
           validity_type_snapshot,
           status,
           DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
         FROM member_memberships
         WHERE organization_id = ?
           AND id = ?
           AND primary_member_id = ?
         LIMIT 1
         FOR UPDATE`,
        [
          context.organizationId,
          renewalFromId,
          context.memberId,
        ]
      );

      if (!sourceRows.length) {
        throw new MembershipError(
          404,
          'MEMBERSHIP_RENEWAL_SOURCE_NOT_FOUND',
          'The previous membership could not be locked for renewal.'
        );
      }

      renewalSource = sourceRows[0];

      if (
        renewalSource.status === 'cancelled' ||
        renewalSource.validity_type_snapshot !== 'fixed' ||
        !renewalSource.end_date
      ) {
        throw new MembershipError(
          409,
          'MEMBERSHIP_NOT_RENEWABLE',
          'This membership is not eligible for renewal.'
        );
      }
    }

    // Re-read and lock the plan so its current definition is snapshotted.
    const plan = await getPlan(
      connection,
      context.organizationId,
      planId,
      true
    );

    if (plan.package_type !== preview.package_type) {
      throw new MembershipError(
        409,
        'MEMBERSHIP_PLAN_CHANGED_RETRY',
        'The membership plan changed during assignment. Please retry.'
      );
    }

    const today = await getToday(connection);

    let startDate = suppliedStartDate;

    if (!startDate) {
      if (isRenewal) {
        startDate = renewalSource.end_date >= today
          ? renewalSource.end_date
          : today;
      } else {
        startDate = today;
      }
    }

    const dates = await calculateMembershipDates(
      connection,
      plan,
      startDate
    );

    await ensureNoOverlappingMemberships(
      connection,
      context,
      memberIds,
      startDate,
      dates.endDate
    );

    const [insertResult] = await connection.query(
      `INSERT INTO member_memberships
       (
         organization_id,
         membership_plan_id,
         branch_id,
         primary_member_id,
         renewed_from_membership_id,

         plan_code_snapshot,
         plan_name_snapshot,
         package_type_snapshot,
         validity_type_snapshot,

         duration_value_snapshot,
         duration_unit_snapshot,
         billing_interval_value_snapshot,
         billing_interval_unit_snapshot,

         price_snapshot,
         currency_code_snapshot,
         included_members_snapshot,
         paying_members_snapshot,

         start_date,
         end_date,
         next_billing_date,
         status,
         notes,

         created_by_user_id,
         updated_by_user_id
       )
       VALUES
       (
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, 'active', ?,
         ?, ?
       )`,
      [
        context.organizationId,
        planId,
        context.branchId,
        context.memberId,
        renewalFromId,

        plan.plan_code,
        plan.name,
        plan.package_type,
        plan.validity_type,

        plan.duration_value,
        plan.duration_unit,
        plan.billing_interval_value,
        plan.billing_interval_unit,

        plan.price,
        plan.currency_code,
        plan.included_members,
        plan.paying_members,

        startDate,
        dates.endDate,
        dates.nextBillingDate,
        notes,

        context.userId,
        context.userId,
      ]
    );

    const membershipId = Number(insertResult.insertId);

    await connection.query(
      `INSERT INTO member_membership_members
       (
         organization_id,
         membership_id,
         member_id,
         member_role,
         status,
         joined_on
       )
       VALUES (?, ?, ?, 'primary', 'active', ?)`,
      [
        context.organizationId,
        membershipId,
        context.memberId,
        startDate,
      ]
    );

    if (includedMemberId) {
      await connection.query(
        `INSERT INTO member_membership_members
         (
           organization_id,
           membership_id,
           member_id,
           member_role,
           status,
           joined_on
         )
         VALUES (?, ?, ?, 'included', 'active', ?)`,
        [
          context.organizationId,
          membershipId,
          includedMemberId,
          startDate,
        ]
      );
    }

    const action = isRenewal
      ? 'MEMBER_MEMBERSHIP_RENEWED'
      : 'MEMBER_MEMBERSHIP_ASSIGNED';

    await writeMembershipAudit(
      connection,
      req,
      context,
      primaryMember,
      {
        action,
        entityId: membershipId,
        description:
          `${isRenewal ? 'Renewed' : 'Assigned'} membership ` +
          `${plan.plan_code} to member ${primaryMember.member_code}; ` +
          `membership_id=${membershipId}; start_date=${startDate}.`,
        oldValues: isRenewal
          ? { renewed_from_membership_id: renewalFromId }
          : { record_exists: false },
        newValues: {
          record_exists: true,
          plan_id: planId,
          plan_code: plan.plan_code,
          package_type: plan.package_type,
          validity_type: plan.validity_type,
          start_date: startDate,
          end_date: dates.endDate,
          next_billing_date: dates.nextBillingDate,
          status: 'active',
        },
        metadata: {
          member_membership: {
            membership_id: membershipId,
            plan_id: planId,
            plan_code: plan.plan_code,
            included_member_id: includedMemberId,
            branch_id: context.branchId,
            renewed_from_membership_id: renewalFromId,
          },
        },
      }
    );

    const membership = await getMembershipResponse(
      connection,
      context,
      membershipId
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: isRenewal
        ? 'Membership renewed successfully.'
        : 'Membership assigned successfully.',
      membership,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Membership assignment rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      isRenewal
        ? 'MEMBER_MEMBERSHIP_RENEWAL_FAILED'
        : 'MEMBER_MEMBERSHIP_ASSIGN_FAILED',
      isRenewal
        ? 'Unable to renew this membership.'
        : 'Unable to assign this membership.'
    );
  } finally {
    if (connection) connection.release();
  }
};

const assignMemberMembership = (req, res) =>
  createMembership(req, res, false);

const renewMemberMembership = (req, res) =>
  createMembership(req, res, true);

// --------------------------------------------------
// PATCH /api/members/:memberId/memberships/:id
// Currently allows notes only.
// Plan snapshots and dates cannot be rewritten.
// --------------------------------------------------

const updateMemberMembership = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    ensureObjectBody(req.body);
    ensureAllowedFields(req.body, new Set(['notes']));

    if (!Object.prototype.hasOwnProperty.call(req.body, 'notes')) {
      throw new MembershipError(
        400,
        'MEMBERSHIP_UPDATE_FIELD_REQUIRED',
        'Supply the notes field to update this membership.'
      );
    }

    const membershipId = parsePositiveId(req.params.membershipId);

    if (!membershipId) {
      throw new MembershipError(
        400,
        'INVALID_MEMBERSHIP_ID',
        'Membership ID is invalid.'
      );
    }

    const notes = normalizeNotes(req.body.notes);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    await getMemberRows(
      connection,
      context,
      [context.memberId],
      true
    );

    const current = await getMembershipHeader(
      connection,
      context,
      membershipId,
      true
    );

    await connection.query(
      `UPDATE member_memberships
       SET notes = ?,
           updated_by_user_id = ?
       WHERE organization_id = ?
         AND id = ?`,
      [
        notes,
        context.userId,
        context.organizationId,
        membershipId,
      ]
    );

    const [memberRows] = await connection.query(
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
       LIMIT 1`,
      [context.organizationId, current.primary_member_id]
    );

    const primaryMember = memberRows[0];

    await writeMembershipAudit(
      connection,
      req,
      context,
      primaryMember,
      {
        action: 'MEMBER_MEMBERSHIP_UPDATED',
        entityId: membershipId,
        description:
          `Updated notes for member membership ${membershipId}.`,
        oldValues: {
          notes_present: current.notes != null,
        },
        newValues: {
          notes_present: notes != null,
        },
        metadata: {
          member_membership: {
            membership_id: membershipId,
            updated_field: 'notes',
            action_branch_id: context.branchId,
          },
        },
      }
    );

    const membership = await getMembershipResponse(
      connection,
      context,
      membershipId
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Membership notes updated successfully.',
      membership,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Membership update rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBER_MEMBERSHIP_UPDATE_FAILED',
      'Unable to update this membership.'
    );
  } finally {
    if (connection) connection.release();
  }
};

// --------------------------------------------------
// POST /api/members/:memberId/memberships/:id/cancel
// --------------------------------------------------

const cancelMemberMembership = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    ensureObjectBody(req.body || {});

    ensureAllowedFields(
      req.body || {},
      new Set(['reason'])
    );

    const membershipId = parsePositiveId(req.params.membershipId);

    if (!membershipId) {
      throw new MembershipError(
        400,
        'INVALID_MEMBERSHIP_ID',
        'Membership ID is invalid.'
      );
    }

    const reason = req.body?.reason == null
      ? null
      : req.body.reason;

    if (
      reason !== null &&
      (typeof reason !== 'string' || reason.trim().length > 500)
    ) {
      throw new MembershipError(
        400,
        'INVALID_MEMBERSHIP_CANCELLATION_REASON',
        'Cancellation reason must be text with a maximum of 500 characters.'
      );
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    await getMemberRows(
      connection,
      context,
      [context.memberId],
      true
    );

    const current = await getMembershipHeader(
      connection,
      context,
      membershipId,
      true
    );

    if (current.status === 'cancelled') {
      await connection.commit();
      transactionStarted = false;

      return res.json({
        success: true,
        message: 'Membership is already cancelled.',
        membership: await getMembershipResponse(
          connection,
          context,
          membershipId
        ),
      });
    }

    const today = await getToday(connection);

    if (
      current.status === 'expired' ||
      (current.end_date && current.end_date <= today)
    ) {
      throw new MembershipError(
        409,
        'MEMBERSHIP_ALREADY_EXPIRED',
        'An expired membership cannot be cancelled.'
      );
    }

    await connection.query(
      `UPDATE member_memberships
       SET status = 'cancelled',
           cancelled_on = CURRENT_DATE(),
           cancellation_reason = ?,
           suspended_at = NULL,
           suspended_by_user_id = NULL,
           suspension_reason = NULL,
           updated_by_user_id = ?
       WHERE organization_id = ?
         AND id = ?`,
      [
        reason == null ? null : reason.trim(),
        context.userId,
        context.organizationId,
        membershipId,
      ]
    );

    await connection.query(
      `UPDATE member_membership_members
       SET status = 'ended',
           ended_on = CURRENT_DATE()
       WHERE organization_id = ?
         AND membership_id = ?
         AND status = 'active'`,
      [context.organizationId, membershipId]
    );

    const [primaryRows] = await connection.query(
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
       LIMIT 1`,
      [context.organizationId, current.primary_member_id]
    );

    await writeMembershipAudit(
      connection,
      req,
      context,
      primaryRows[0],
      {
        action: 'MEMBER_MEMBERSHIP_CANCELLED',
        entityId: membershipId,
        description:
          `Cancelled member membership ${membershipId} ` +
          `for member ${primaryRows[0].member_code}.`,
        oldValues: {
          status: current.status,
        },
        newValues: {
          status: 'cancelled',
          cancelled_on: today,
        },
        metadata: {
          member_membership: {
            membership_id: membershipId,
            plan_code: current.plan_code_snapshot,
            cancellation_branch_id: context.branchId,
          },
        },
      }
    );

    const membership = await getMembershipResponse(
      connection,
      context,
      membershipId
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Membership cancelled successfully.',
      membership,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Membership cancellation rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBER_MEMBERSHIP_CANCEL_FAILED',
      'Unable to cancel this membership.'
    );
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  listMemberMemberships,
  assignMemberMembership,
  updateMemberMembership,
  cancelMemberMembership,
  renewMemberMembership,
};
