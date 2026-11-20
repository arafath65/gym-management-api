'use strict';

const db = require('../config/db');

const {
  writeAuditLog,
  buildMemberAuditMetadata,
} = require('../services/gymAuditService');

class MembershipStatusError extends Error {
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
    membershipId: parsePositiveId(req.params.membershipId),
    organizationId: parsePositiveId(req.gymStaff?.organizationId),
    branchId: parsePositiveId(req.gymStaff?.branchId),
    userId: parsePositiveId(req.gymStaff?.userId),
  };

  if (
    !context.memberId ||
    !context.membershipId ||
    !context.organizationId ||
    !context.branchId ||
    !context.userId
  ) {
    throw new MembershipStatusError(
      401,
      'MEMBERSHIP_STATUS_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const requireReason = (value, action) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 500
  ) {
    throw new MembershipStatusError(
      400,
      `${action.toUpperCase()}_REASON_REQUIRED`,
      `A reason is required (maximum 500 characters).`
    );
  }

  return value.trim();
};

const ensureAllowedBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MembershipStatusError(
      400,
      'INVALID_MEMBERSHIP_STATUS_REQUEST',
      'Request body must be a valid object.'
    );
  }

  const unexpected = Object.keys(body).filter(key => key !== 'reason');

  if (unexpected.length) {
    throw new MembershipStatusError(
      400,
      'UNSUPPORTED_MEMBERSHIP_STATUS_FIELDS',
      `Unsupported fields: ${unexpected.join(', ')}`
    );
  }
};

const getMembershipForUpdate = async (connection, context) => {
  const [rows] = await connection.query(
    `SELECT
       mm.id,
       mm.organization_id,
       mm.primary_member_id,
       mm.status,
       mm.validity_type_snapshot,
       mm.billing_interval_value_snapshot,
       mm.billing_interval_unit_snapshot,
       DATE_FORMAT(mm.start_date, '%Y-%m-%d') AS start_date,
       DATE_FORMAT(mm.end_date, '%Y-%m-%d') AS end_date,
       DATE_FORMAT(mm.next_billing_date, '%Y-%m-%d') AS next_billing_date,
       DATE_FORMAT(mm.suspended_at, '%Y-%m-%d %H:%i:%s') AS suspended_at,
       mm.suspension_reason,
       DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today

     FROM member_memberships mm

     WHERE mm.organization_id = ?
       AND mm.id = ?
       AND EXISTS (
         SELECT 1
         FROM member_membership_members participant
         WHERE participant.organization_id = mm.organization_id
           AND participant.membership_id = mm.id
           AND participant.member_id = ?
       )

     LIMIT 1
     FOR UPDATE`,
    [
      context.organizationId,
      context.membershipId,
      context.memberId,
    ]
  );

  if (!rows.length) {
    throw new MembershipStatusError(
      404,
      'MEMBER_MEMBERSHIP_NOT_FOUND',
      'Membership was not found for this member.'
    );
  }

  return rows[0];
};

const getAuditMember = async (
  connection,
  organizationId,
  memberId
) => {
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
     LIMIT 1`,
    [organizationId, memberId]
  );

  if (!rows.length) {
    throw new MembershipStatusError(
      404,
      'MEMBERSHIP_AUDIT_MEMBER_NOT_FOUND',
      'Membership member was not found in this organization.'
    );
  }

  return rows[0];
};

const getMembershipResponse = async (
  connection,
  organizationId,
  membershipId
) => {
  const [rows] = await connection.query(
    `SELECT
       id,
       organization_id,
       primary_member_id,
       plan_code_snapshot,
       plan_name_snapshot,
       validity_type_snapshot,
       status,
       DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
       DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
       DATE_FORMAT(next_billing_date, '%Y-%m-%d') AS next_billing_date,
       DATE_FORMAT(suspended_at, '%Y-%m-%d %H:%i:%s') AS suspended_at,
       suspended_by_user_id,
       suspension_reason
     FROM member_memberships
     WHERE organization_id = ?
       AND id = ?
     LIMIT 1`,
    [organizationId, membershipId]
  );

  if (!rows.length) {
    throw new Error('Membership response could not be loaded.');
  }

  const row = rows[0];

  return {
    id: Number(row.id),
    organization_id: Number(row.organization_id),
    primary_member_id: Number(row.primary_member_id),
    plan_code: row.plan_code_snapshot,
    plan_name: row.plan_name_snapshot,
    validity_type: row.validity_type_snapshot,
    status: row.status,
    start_date: row.start_date,
    end_date: row.end_date,
    next_billing_date: row.next_billing_date,
    suspended_at: row.suspended_at,
    suspended_by_user_id:
      row.suspended_by_user_id == null
        ? null
        : Number(row.suspended_by_user_id),
    suspension_reason: row.suspension_reason,
  };
};

const dateParts = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));

  if (!match) {
    throw new Error(`Invalid membership billing date: ${value}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
};

const formatDate = (year, month, day) =>
  `${String(year).padStart(4, '0')}-` +
  `${String(month).padStart(2, '0')}-` +
  `${String(day).padStart(2, '0')}`;

const daysInMonth = (year, month) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/*
 * Calculate a recurring date from the original membership start date.
 * This avoids drifting from the 29th/30th/31st after shorter months.
 */
const dateFromOriginalAnchor = (
  startDate,
  cycleNumber,
  intervalValue,
  intervalUnit
) => {
  const start = dateParts(startDate);
  const amount = cycleNumber * intervalValue;

  if (intervalUnit === 'day' || intervalUnit === 'week') {
    const days = intervalUnit === 'week' ? amount * 7 : amount;
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day));
    date.setUTCDate(date.getUTCDate() + days);

    return formatDate(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate()
    );
  }

  if (intervalUnit === 'month') {
    const totalMonths = start.year * 12 + (start.month - 1) + amount;
    const year = Math.floor(totalMonths / 12);
    const month = (totalMonths % 12) + 1;
    const day = Math.min(start.day, daysInMonth(year, month));

    return formatDate(year, month, day);
  }

  if (intervalUnit === 'year') {
    const year = start.year + amount;
    const day = Math.min(
      start.day,
      daysInMonth(year, start.month)
    );

    return formatDate(year, start.month, day);
  }

  throw new Error(`Unsupported billing interval unit: ${intervalUnit}`);
};

const getResumedNextBillingDate = (membership, today) => {
  const {
    start_date: startDate,
    next_billing_date: storedNextDate,
    billing_interval_value_snapshot: intervalValueRaw,
    billing_interval_unit_snapshot: intervalUnit,
  } = membership;

  if (!storedNextDate) {
    throw new Error('Ongoing membership has no next billing date.');
  }

  if (storedNextDate >= today) {
    return storedNextDate;
  }

  const intervalValue = Number(intervalValueRaw);

  if (!Number.isInteger(intervalValue) || intervalValue < 1) {
    throw new Error('Membership billing interval is invalid.');
  }

  let cycle = 1;
  let candidate = dateFromOriginalAnchor(
    startDate,
    cycle,
    intervalValue,
    intervalUnit
  );

  // Locate the cycle represented by the stored next billing date.
  while (candidate < storedNextDate && cycle < 12000) {
    cycle += 1;
    candidate = dateFromOriginalAnchor(
      startDate,
      cycle,
      intervalValue,
      intervalUnit
    );
  }

  if (candidate !== storedNextDate) {
    throw new Error(
      'Stored next billing date does not match the original billing anniversary. Manual review is required.'
    );
  }

  // Skip all billing anniversaries which occurred while suspended.
  while (candidate < today && cycle < 12000) {
    cycle += 1;
    candidate = dateFromOriginalAnchor(
      startDate,
      cycle,
      intervalValue,
      intervalUnit
    );
  }

  if (cycle >= 12000 || candidate < today) {
    throw new Error('Unable to calculate the resumed billing date.');
  }

  return candidate;
};

const getErrorResponse = (res, error, fallbackCode, fallbackMessage) => {
  if (error instanceof MembershipStatusError) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  console.error(`${fallbackCode}:`, error.code || '', error.message);

  return res.status(500).json({
    success: false,
    code: fallbackCode,
    message: fallbackMessage,
  });
};

// ------------------------------------------------------------
// POST /api/members/:memberId/memberships/:membershipId/suspend
// ------------------------------------------------------------

const suspendMemberMembership = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureAllowedBody(body);
    const reason = requireReason(body.reason, 'suspension');

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const membership = await getMembershipForUpdate(
      connection,
      context
    );

    if (membership.status === 'suspended') {
      throw new MembershipStatusError(
        409,
        'MEMBERSHIP_ALREADY_SUSPENDED',
        'This membership is already suspended.'
      );
    }

    if (membership.status !== 'active') {
      throw new MembershipStatusError(
        409,
        'MEMBERSHIP_NOT_ACTIVE',
        'Only an active membership can be suspended.'
      );
    }

    if (
      membership.validity_type_snapshot === 'fixed' &&
      membership.end_date &&
      membership.end_date <= membership.today
    ) {
      throw new MembershipStatusError(
        409,
        'EXPIRED_MEMBERSHIP_CANNOT_BE_SUSPENDED',
        'An expired membership cannot be suspended.'
      );
    }

    const member = await getAuditMember(
      connection,
      context.organizationId,
      membership.primary_member_id
    );

    await connection.query(
      `UPDATE member_memberships
       SET status = 'suspended',
           suspended_at = CURRENT_TIMESTAMP,
           suspended_by_user_id = ?,
           suspension_reason = ?,
           updated_by_user_id = ?
       WHERE organization_id = ?
         AND id = ?
         AND status = 'active'`,
      [
        context.userId,
        reason,
        context.userId,
        context.organizationId,
        context.membershipId,
      ]
    );

    const [clockRows] = await connection.query(
      `SELECT DATE_FORMAT(
         CURRENT_TIMESTAMP,
         '%Y-%m-%d %H:%i:%s'
       ) AS suspended_at`
    );

    await writeAuditLog(
      connection,
      req,
      {
        organizationId: context.organizationId,
        branchId: context.branchId,
        userId: context.userId,
      },
      {
        action: 'MEMBER_MEMBERSHIP_SUSPENDED',
        entityType: 'member_membership',
        entityId: context.membershipId,
        description:
          `Suspended membership ${context.membershipId} for ` +
          `${member.member_code}; reason: ${reason}.`,
        oldValues: {
          status: 'active',
          end_date: membership.end_date,
          next_billing_date: membership.next_billing_date,
        },
        newValues: {
          status: 'suspended',
          suspended_at: clockRows[0].suspended_at,
          suspension_reason: reason,
          future_billing_paused: true,
          end_date: membership.end_date,
          next_billing_date: membership.next_billing_date,
        },
        metadata: buildMemberAuditMetadata(member, {
          member_membership: {
            membership_id: context.membershipId,
            plan_code: membership.plan_code_snapshot,
            plan_name: membership.plan_name_snapshot,
            action: 'suspend',
            action_branch_id: context.branchId,
          },
        }),
      }
    );

    const response = await getMembershipResponse(
      connection,
      context.organizationId,
      context.membershipId
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Membership suspended successfully. Future recurring billing is paused.',
      membership: response,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Membership suspension rollback failed:', rollbackError.message);
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBER_MEMBERSHIP_SUSPEND_FAILED',
      'Unable to suspend this membership.'
    );
  } finally {
    if (connection) connection.release();
  }
};

// ------------------------------------------------------------
// POST /api/members/:memberId/memberships/:membershipId/reactivate
// ------------------------------------------------------------

const reactivateMemberMembership = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureAllowedBody(body);
    const reason = requireReason(body.reason, 'reactivation');

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const membership = await getMembershipForUpdate(
      connection,
      context
    );

    if (membership.status !== 'suspended') {
      throw new MembershipStatusError(
        409,
        'MEMBERSHIP_NOT_SUSPENDED',
        'Only a suspended membership can be reactivated.'
      );
    }

    const member = await getAuditMember(
      connection,
      context.organizationId,
      membership.primary_member_id
    );

    let newEndDate = membership.end_date;
    let newNextBillingDate = membership.next_billing_date;
    let pauseDays = 0;

    if (membership.validity_type_snapshot === 'fixed') {
      const [pauseRows] = await connection.query(
        `SELECT GREATEST(
           DATEDIFF(CURRENT_DATE(), DATE(suspended_at)),
           0
         ) AS pause_days
         FROM member_memberships
         WHERE organization_id = ?
           AND id = ?
         LIMIT 1`,
        [context.organizationId, context.membershipId]
      );

      pauseDays = Number(pauseRows[0]?.pause_days || 0);

      if (pauseDays > 0) {
        const [dateRows] = await connection.query(
          `SELECT DATE_FORMAT(
             DATE_ADD(end_date, INTERVAL ? DAY),
             '%Y-%m-%d'
           ) AS new_end_date
           FROM member_memberships
           WHERE organization_id = ?
             AND id = ?
           LIMIT 1`,
          [
            pauseDays,
            context.organizationId,
            context.membershipId,
          ]
        );

        newEndDate = dateRows[0]?.new_end_date || membership.end_date;
      }
    } else if (membership.validity_type_snapshot === 'ongoing') {
      newNextBillingDate = getResumedNextBillingDate(
        membership,
        membership.today
      );
    } else {
      throw new MembershipStatusError(
        409,
        'INVALID_MEMBERSHIP_VALIDITY',
        'Membership validity type is not supported for reactivation.'
      );
    }

    await connection.query(
      `UPDATE member_memberships
       SET status = 'active',
           end_date = ?,
           next_billing_date = ?,
           suspended_at = NULL,
           suspended_by_user_id = NULL,
           suspension_reason = NULL,
           updated_by_user_id = ?
       WHERE organization_id = ?
         AND id = ?
         AND status = 'suspended'`,
      [
        newEndDate,
        newNextBillingDate,
        context.userId,
        context.organizationId,
        context.membershipId,
      ]
    );

    await writeAuditLog(
      connection,
      req,
      {
        organizationId: context.organizationId,
        branchId: context.branchId,
        userId: context.userId,
      },
      {
        action: 'MEMBER_MEMBERSHIP_REACTIVATED',
        entityType: 'member_membership',
        entityId: context.membershipId,
        description:
          `Reactivated membership ${context.membershipId} for ` +
          `${member.member_code}; reason: ${reason}.`,
        oldValues: {
          status: 'suspended',
          end_date: membership.end_date,
          next_billing_date: membership.next_billing_date,
          suspended_at: membership.suspended_at,
          suspension_reason: membership.suspension_reason,
        },
        newValues: {
          status: 'active',
          end_date: newEndDate,
          next_billing_date: newNextBillingDate,
          suspension_cleared: true,
          suspension_days: pauseDays,
          reactivation_reason: reason,
        },
        metadata: buildMemberAuditMetadata(member, {
          member_membership: {
            membership_id: context.membershipId,
            plan_code: membership.plan_code_snapshot,
            plan_name: membership.plan_name_snapshot,
            action: 'reactivate',
            action_branch_id: context.branchId,
          },
        }),
      }
    );

    const response = await getMembershipResponse(
      connection,
      context.organizationId,
      context.membershipId
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message:
        'Membership reactivated successfully. Billing resumes on the next valid billing anniversary.',
      membership: response,
      suspension: {
        paused_days: pauseDays,
        previous_next_billing_date: membership.next_billing_date,
        resumed_next_billing_date: newNextBillingDate,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Membership reactivation rollback failed:', rollbackError.message);
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBER_MEMBERSHIP_REACTIVATE_FAILED',
      'Unable to reactivate this membership.'
    );
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  suspendMemberMembership,
  reactivateMemberMembership,
};
