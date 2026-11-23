'use strict';

const db = require('../config/db');
const { writeAuditLog, buildMemberAuditMetadata } = require('../services/gymAuditService');
const { issueAttendanceDailyInvoice } = require('./memberMembershipInvoiceController');

class AttendanceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const positiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const getContext = (req) => {
  const context = {
    organizationId: positiveId(req.gymStaff?.organizationId),
    branchId: positiveId(req.gymStaff?.branchId),
    userId: positiveId(req.gymStaff?.userId),
  };
  if (!context.organizationId || !context.branchId || !context.userId) {
    throw new AttendanceError(401, 'ATTENDANCE_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.');
  }
  return context;
};

const getToday = async (connection) => {
  const [rows] = await connection.query(
    "SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today"
  );
  return rows[0].today;
};

const getErrorResponse = (res, error, fallbackCode, fallbackMessage) => {
  if (error instanceof AttendanceError) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }
  // The invoice service raises its own BillingError type. Preserve its
  // expected 4xx response instead of incorrectly turning it into HTTP 500.
  const propagatedStatus = Number(error?.statusCode || error?.status);
  if (
    Number.isInteger(propagatedStatus) &&
    propagatedStatus >= 400 &&
    propagatedStatus < 500 &&
    typeof error?.code === 'string'
  ) {
    return res.status(propagatedStatus).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }
  if (error?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      code: 'MEMBER_ALREADY_CHECKED_IN_TODAY',
      message: 'This member has already checked in today.',
    });
  }
  console.error(`${fallbackCode}:`, error?.code || '', error?.message || error);
  return res.status(500).json({
    success: false,
    code: fallbackCode,
    message: fallbackMessage,
  });
};

const searchAttendanceMembers = async (req, res) => {
  try {
    const context = getContext(req);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length > 100) {
      throw new AttendanceError(400, 'INVALID_ATTENDANCE_SEARCH',
        'Search text must not exceed 100 characters.');
    }

    const search = `%${query}%`;
    const today = await getToday(db);
    const [rows] = await db.query(
      `SELECT
         member.id AS member_id,
         member.member_code,
         member.full_name,
         membership.id AS membership_id,
         membership.plan_name_snapshot AS plan_name,
         membership.price_snapshot AS daily_fee,
         membership.currency_code_snapshot AS currency_code,
         CASE WHEN today_attendance.id IS NULL THEN 0 ELSE 1 END AS checked_in_today
       FROM members member
       INNER JOIN member_membership_members participant
         ON participant.organization_id = member.organization_id
        AND participant.member_id = member.id
        AND participant.status = 'active'
       INNER JOIN member_memberships membership
         ON membership.organization_id = participant.organization_id
        AND membership.id = participant.membership_id
        AND membership.status = 'active'
        AND membership.billing_mode_snapshot = 'attendance'
        AND membership.start_date <= ?
        AND (membership.end_date IS NULL OR membership.end_date > ?)
       LEFT JOIN member_attendance today_attendance
         ON today_attendance.organization_id = member.organization_id
        AND today_attendance.member_id = member.id
        AND today_attendance.attendance_date = ?
       WHERE member.organization_id = ?
         AND member.status = 'active'
         AND (? = '%%' OR member.full_name LIKE ? OR member.member_code LIKE ?)
       ORDER BY member.full_name ASC, membership.id DESC
       LIMIT 50`,
      [today, today, today, context.organizationId, search, search, search]
    );

    // Active membership overlap is prevented by the membership service. Keep
    // one row per member if legacy/old data contains overlapping plans.
    const byMember = new Map();
    for (const row of rows) {
      const id = Number(row.member_id);
      if (!byMember.has(id)) {
        byMember.set(id, {
          member_id: id,
          member_code: row.member_code,
          member_name: row.full_name,
          membership_id: Number(row.membership_id),
          plan_name: row.plan_name,
          daily_fee: String(row.daily_fee),
          currency_code: row.currency_code,
          checked_in_today: Boolean(row.checked_in_today),
        });
      }
    }

    return res.json({ success: true, members: [...byMember.values()] });
  } catch (error) {
    return getErrorResponse(res, error, 'ATTENDANCE_MEMBER_SEARCH_FAILED',
      'Unable to search daily membership members.');
  }
};

const listTodayAttendance = async (req, res) => {
  try {
    const context = getContext(req);
    const [rows] = await db.query(
      `SELECT
         attendance.id AS attendance_id,
         attendance.member_id,
         member.member_code,
         member.full_name AS member_name,
         attendance.membership_id,
         membership.plan_name_snapshot AS plan_name,
         attendance.branch_id,
         branch.name AS attendance_branch_name,
         DATE_FORMAT(attendance.checked_in_at, '%Y-%m-%d %H:%i:%s') AS checked_in_at,
         attendance.invoice_id,
         invoice.invoice_number,
         COALESCE(invoice.total_amount, 0.00) AS daily_fee,
         COALESCE(invoice.currency_code, membership.currency_code_snapshot) AS currency_code,
         CASE WHEN invoice.id IS NULL OR invoice.status <> 'issued' THEN 0 ELSE GREATEST(
           invoice.total_amount
           - GREATEST(
               COALESCE((
                 SELECT SUM(allocation.allocated_amount)
                 FROM member_membership_payment_allocations allocation
                 INNER JOIN member_membership_payments payment
                   ON payment.organization_id = allocation.organization_id
                  AND payment.id = allocation.payment_id
                  AND payment.status = 'posted'
                 WHERE allocation.organization_id = invoice.organization_id
                   AND allocation.invoice_id = invoice.id
               ), 0.00)
               - COALESCE((
                 SELECT SUM(refund.refund_amount)
                 FROM member_membership_refunds refund
                 INNER JOIN member_membership_payment_allocations refund_allocation
                   ON refund_allocation.organization_id = refund.organization_id
                  AND refund_allocation.id = refund.payment_allocation_id
                 WHERE refund.organization_id = invoice.organization_id
                   AND refund_allocation.invoice_id = invoice.id
                   AND refund.status = 'posted'
               ), 0.00),
               0.00
             )
           - COALESCE((
               SELECT SUM(waiver.waiver_amount)
               FROM member_membership_invoice_waivers waiver
               WHERE waiver.organization_id = invoice.organization_id
                 AND waiver.invoice_id = invoice.id
                 AND waiver.status = 'posted'
             ), 0.00),
           0.00
         ) END AS outstanding
       FROM member_attendance attendance
       INNER JOIN members member
         ON member.organization_id = attendance.organization_id
        AND member.id = attendance.member_id
       INNER JOIN member_memberships membership
         ON membership.organization_id = attendance.organization_id
        AND membership.id = attendance.membership_id
       INNER JOIN branches branch
         ON branch.organization_id = attendance.organization_id
        AND branch.id = attendance.branch_id
       LEFT JOIN member_membership_invoices invoice
         ON invoice.organization_id = attendance.organization_id
        AND invoice.id = attendance.invoice_id
       WHERE attendance.organization_id = ?
         AND attendance.branch_id = ?
         AND attendance.attendance_date = CURRENT_DATE()
       ORDER BY attendance.checked_in_at DESC, attendance.id DESC
       LIMIT 200`,
      [context.organizationId, context.branchId]
    );

    return res.json({
      success: true,
      attendance: rows.map((row) => ({
        attendance_id: Number(row.attendance_id),
        member_id: Number(row.member_id),
        member_code: row.member_code,
        member_name: row.member_name,
        membership_id: Number(row.membership_id),
        plan_name: row.plan_name,
        branch_id: Number(row.branch_id),
        attendance_branch_name: row.attendance_branch_name,
        checked_in_at: row.checked_in_at,
        invoice_id: row.invoice_id == null ? null : Number(row.invoice_id),
        invoice_number: row.invoice_number,
        daily_fee: String(row.daily_fee),
        currency_code: row.currency_code,
        outstanding: String(row.outstanding ?? '0.00'),
      })),
    });
  } catch (error) {
    return getErrorResponse(res, error, 'ATTENDANCE_TODAY_LIST_FAILED',
      'Unable to load today attendance records.');
  }
};

const checkInMember = async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const context = getContext(req);
    const body = req.body || {};
    const memberId = positiveId(body.member_id);
    if (!memberId || Object.keys(body).some((key) => key !== 'member_id')) {
      throw new AttendanceError(400, 'INVALID_ATTENDANCE_CHECK_IN',
        'A valid member_id is required.');
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const today = await getToday(connection);

    const [memberRows] = await connection.query(
      `SELECT id, member_code, full_name, status,
              registration_branch_id
       FROM members
       WHERE organization_id = ? AND id = ?
       LIMIT 1 FOR UPDATE`,
      [context.organizationId, memberId]
    );
    if (!memberRows.length || memberRows[0].status !== 'active') {
      throw new AttendanceError(404, 'ACTIVE_MEMBER_NOT_FOUND',
        'An active member with this ID was not found.');
    }
    const member = memberRows[0];

    const [membershipRows] = await connection.query(
      `SELECT
         membership.id AS membership_id,
         membership.primary_member_id,
         membership.plan_name_snapshot,
         membership.price_snapshot,
         membership.currency_code_snapshot,
         membership.billing_mode_snapshot,
         membership.status,
         DATE_FORMAT(membership.start_date, '%Y-%m-%d') AS start_date,
         DATE_FORMAT(membership.end_date, '%Y-%m-%d') AS end_date
       FROM member_membership_members participant
       INNER JOIN member_memberships membership
         ON membership.organization_id = participant.organization_id
        AND membership.id = participant.membership_id
       WHERE participant.organization_id = ?
         AND participant.member_id = ?
         AND participant.status = 'active'
         AND membership.status = 'active'
         AND membership.billing_mode_snapshot = 'attendance'
         AND membership.start_date <= ?
         AND (membership.end_date IS NULL OR membership.end_date > ?)
       ORDER BY membership.id DESC
       LIMIT 2 FOR UPDATE`,
      [context.organizationId, memberId, today, today]
    );

    if (!membershipRows.length) {
      throw new AttendanceError(409, 'NO_ACTIVE_DAILY_MEMBERSHIP',
        'This member does not have an active pay-per-attendance membership.');
    }
    if (membershipRows.length > 1) {
      throw new AttendanceError(409, 'MULTIPLE_DAILY_MEMBERSHIPS',
        'This member has multiple active daily memberships. Resolve the overlap before check-in.');
    }

    const membership = membershipRows[0];
    const membershipId = Number(membership.membership_id);

    const [existingAttendance] = await connection.query(
      `SELECT id
       FROM member_attendance
       WHERE organization_id = ?
         AND member_id = ?
         AND attendance_date = ?
       LIMIT 1 FOR UPDATE`,
      [context.organizationId, memberId, today]
    );
    if (existingAttendance.length) {
      throw new AttendanceError(409, 'MEMBER_ALREADY_CHECKED_IN_TODAY',
        'This member has already checked in today. A second daily charge will not be created.');
    }

    const [attendanceInsert] = await connection.query(
      `INSERT INTO member_attendance
       (organization_id, member_id, membership_id, branch_id,
        attendance_date, checked_in_at, invoice_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, ?)`,
      [context.organizationId, memberId, membershipId, context.branchId, today, context.userId]
    );
    const attendanceId = Number(attendanceInsert.insertId);

    // Daily couple/package billing is one charge per membership per date.
    // Additional included-member check-ins link to the same daily invoice.
    const [existingCharge] = await connection.query(
      `SELECT id, invoice_id
       FROM member_membership_attendance_charges
       WHERE organization_id = ?
         AND membership_id = ?
         AND service_date = ?
       LIMIT 1 FOR UPDATE`,
      [context.organizationId, membershipId, today]
    );

    let invoiceId;
    let invoiceNumber;
    let createdDailyInvoice = false;
    if (existingCharge.length) {
      invoiceId = Number(existingCharge[0].invoice_id);
    } else {
      const issued = await issueAttendanceDailyInvoice(
        connection,
        req,
        {
          ...context,
          memberId,
          membershipId,
        },
        membershipId,
        today,
        attendanceId
      );
      invoiceId = issued.invoiceId;
      invoiceNumber = issued.invoiceNumber;
      createdDailyInvoice = true;
      await connection.query(
        `INSERT INTO member_membership_attendance_charges
         (organization_id, membership_id, service_date, attendance_id,
          invoice_id, amount, currency_code, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.organizationId,
          membershipId,
          today,
          attendanceId,
          invoiceId,
          membership.price_snapshot,
          membership.currency_code_snapshot,
          context.userId,
        ]
      );
    }

    await connection.query(
      `UPDATE member_attendance
       SET invoice_id = ?
       WHERE organization_id = ? AND id = ?`,
      [invoiceId, context.organizationId, attendanceId]
    );

    await writeAuditLog(
      connection,
      req,
      context,
      {
        action: 'MEMBER_ATTENDANCE_CHECKED_IN',
        entityType: 'member_attendance',
        entityId: attendanceId,
        description: `Member ${member.member_code} checked in at the active branch on ${today}.`,
        oldValues: { record_exists: false },
        newValues: {
          attendance_id: attendanceId,
          member_id: memberId,
          membership_id: membershipId,
          attendance_date: today,
          attendance_branch_id: context.branchId,
          invoice_id: invoiceId,
          daily_invoice_created: createdDailyInvoice,
        },
        metadata: buildMemberAuditMetadata(member, {
          attendance: {
            attendance_id: attendanceId,
            membership_id: membershipId,
            attendance_branch_id: context.branchId,
            invoice_id: invoiceId,
          },
        }),
      }
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: createdDailyInvoice
        ? 'Attendance recorded and daily fee invoiced.'
        : 'Attendance recorded. The membership already has today\'s daily charge.',
      attendance: {
        id: attendanceId,
        member_id: memberId,
        member_code: member.member_code,
        member_name: member.full_name,
        membership_id: membershipId,
        branch_id: context.branchId,
        attendance_date: today,
        invoice_id: invoiceId,
        invoice_number: invoiceNumber || null,
        daily_fee: String(membership.price_snapshot),
        currency_code: membership.currency_code_snapshot,
        daily_invoice_created: createdDailyInvoice,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Attendance check-in rollback failed:', rollbackError.message);
      }
    }
    return getErrorResponse(res, error, 'ATTENDANCE_CHECK_IN_FAILED',
      'Unable to record member attendance.');
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  searchAttendanceMembers,
  listTodayAttendance,
  checkInMember,
};
