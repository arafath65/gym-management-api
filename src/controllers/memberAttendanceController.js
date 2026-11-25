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
    const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    let query = rawQuery;

    // The existing member QR payload is:
    // INNOVEX-GYM-MEMBER|organizationId|memberCode
    if (query.startsWith('INNOVEX-GYM-MEMBER|')) {
      const parts = query.split('|');
      const qrOrganizationId = positiveId(parts[1]);
      const qrMemberCode = String(parts[2] || '').trim();

      if (
        parts.length !== 3 ||
        parts[0] !== 'INNOVEX-GYM-MEMBER' ||
        qrOrganizationId !== context.organizationId ||
        !qrMemberCode
      ) {
        throw new AttendanceError(404, 'ATTENDANCE_QR_NOT_RECOGNIZED',
          'This QR code does not belong to this organization or is invalid.');
      }

      query = qrMemberCode;
    }

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
         membership.billing_mode_snapshot AS billing_mode,
         membership.price_snapshot AS membership_fee,
         membership.currency_code_snapshot AS currency_code,
         CASE WHEN today_attendance.id IS NULL THEN 0 ELSE 1 END AS checked_in_today,
         DATE_FORMAT(today_attendance.checked_in_at, '%Y-%m-%d %H:%i:%s') AS checked_in_at,
         DATE_FORMAT(today_attendance.checked_out_at, '%Y-%m-%d %H:%i:%s') AS checked_out_at,
         today_attendance.attendance_status
       FROM members member
       INNER JOIN member_membership_members participant
         ON participant.organization_id = member.organization_id
        AND participant.member_id = member.id
        AND participant.status = 'active'
       INNER JOIN member_memberships membership
         ON membership.organization_id = participant.organization_id
        AND membership.id = participant.membership_id
        AND membership.status = 'active'
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

    // Keep one result per member if legacy data contains overlapping plans.
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
          billing_mode: row.billing_mode || 'standard',
          membership_fee: String(row.membership_fee),
          daily_fee: row.billing_mode === 'attendance' ? String(row.membership_fee) : null,
          currency_code: row.currency_code,
          checked_in_today: Boolean(row.checked_in_today),
          checked_in_at: row.checked_in_at,
          checked_out_today: row.checked_out_at != null,
          checked_out_at: row.checked_out_at,
          attendance_status: row.attendance_status || null,
        });
      }
    }

    return res.json({ success: true, members: [...byMember.values()] });
  } catch (error) {
    return getErrorResponse(res, error, 'ATTENDANCE_MEMBER_SEARCH_FAILED',
      'Unable to search active membership members.');
  }
};

const listTodayAttendance = async (req, res) => {
  try {
    const context = getContext(req);
    const filter = typeof req.query.filter === 'string'
      ? req.query.filter
      : 'all';

    if (!['all', 'check_in', 'check_out'].includes(filter)) {
      throw new AttendanceError(400, 'INVALID_ATTENDANCE_FILTER',
        'Attendance filter must be all, check_in or check_out.');
    }

    let branchCondition;
    let branchParameters;

    if (filter === 'check_in') {
      branchCondition = 'attendance.branch_id = ?';
      branchParameters = [context.branchId];
    } else if (filter === 'check_out') {
      branchCondition = 'attendance.checked_out_branch_id = ?';
      branchParameters = [context.branchId];
    } else {
      branchCondition = '(attendance.branch_id = ? OR attendance.checked_out_branch_id = ?)';
      branchParameters = [context.branchId, context.branchId];
    }

    const [rows] = await db.query(
      `SELECT
         attendance.id AS attendance_id,
         attendance.member_id,
         member.member_code,
         member.full_name AS member_name,
         attendance.membership_id,
         membership.plan_name_snapshot AS plan_name,
         membership.billing_mode_snapshot AS billing_mode,
         attendance.branch_id,
         branch.name AS attendance_branch_name,
         attendance.checked_out_branch_id,
         checkout_branch.name AS checkout_branch_name,
         DATE_FORMAT(attendance.checked_in_at, '%Y-%m-%d %H:%i:%s') AS checked_in_at,
         DATE_FORMAT(attendance.checked_out_at, '%Y-%m-%d %H:%i:%s') AS checked_out_at,
         attendance.attendance_status,
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
       LEFT JOIN branches checkout_branch
         ON checkout_branch.organization_id = attendance.organization_id
        AND checkout_branch.id = attendance.checked_out_branch_id
       LEFT JOIN member_membership_invoices invoice
         ON invoice.organization_id = attendance.organization_id
        AND invoice.id = attendance.invoice_id
       WHERE attendance.organization_id = ?
         AND attendance.attendance_date = CURRENT_DATE()
         AND ${branchCondition}
       ORDER BY attendance.checked_in_at DESC, attendance.id DESC
       LIMIT 200`,
      [context.organizationId, ...branchParameters]
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
        billing_mode: row.billing_mode || 'standard',
        branch_id: Number(row.branch_id),
        attendance_branch_name: row.attendance_branch_name,
        checked_out_branch_id: row.checked_out_branch_id == null
          ? null
          : Number(row.checked_out_branch_id),
        checkout_branch_name: row.checkout_branch_name,
        checked_in_at: row.checked_in_at,
        checked_out_at: row.checked_out_at,
        attendance_status: row.attendance_status,
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
         AND membership.start_date <= ?
         AND (membership.end_date IS NULL OR membership.end_date > ?)
       ORDER BY membership.id DESC
       LIMIT 2 FOR UPDATE`,
      [context.organizationId, memberId, today, today]
    );

    if (!membershipRows.length) {
      throw new AttendanceError(409, 'NO_ACTIVE_MEMBERSHIP',
        'This member does not have an active membership valid today.');
    }
    if (membershipRows.length > 1) {
      throw new AttendanceError(409, 'MULTIPLE_ACTIVE_MEMBERSHIPS',
        'This member has multiple active memberships. Resolve the overlap before check-in.');
    }

    const membership = membershipRows[0];
    const membershipId = Number(membership.membership_id);

    // Any previous-day open session is finalized as missed checkout.
    // No checkout timestamp is fabricated.
    await connection.query(
      `UPDATE member_attendance
       SET attendance_status = 'missed_checkout'
       WHERE organization_id = ?
         AND member_id = ?
         AND attendance_date < ?
         AND checked_out_at IS NULL
         AND attendance_status = 'open'`,
      [context.organizationId, memberId, today]
    );

    const [existingAttendance] = await connection.query(
      `SELECT id, checked_out_at, attendance_status
       FROM member_attendance
       WHERE organization_id = ?
         AND member_id = ?
         AND attendance_date = ?
       LIMIT 1 FOR UPDATE`,
      [context.organizationId, memberId, today]
    );
    if (existingAttendance.length) {
      const existing = existingAttendance[0];
      if (existing.checked_out_at != null || existing.attendance_status === 'checked_out') {
        throw new AttendanceError(409, 'MEMBER_ALREADY_CHECKED_OUT_TODAY',
          'This member has already checked in and checked out today.');
      }
      throw new AttendanceError(409, 'MEMBER_ALREADY_CHECKED_IN_TODAY',
        'This member is already checked in today.');
    }

    const [attendanceInsert] = await connection.query(
      `INSERT INTO member_attendance
       (organization_id, member_id, membership_id, branch_id,
        attendance_date, checked_in_at, invoice_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, ?)`,
      [context.organizationId, memberId, membershipId, context.branchId, today, context.userId]
    );
    const attendanceId = Number(attendanceInsert.insertId);

    let invoiceId = null;
    let invoiceNumber = null;
    let createdDailyInvoice = false;

    // Only attendance-billed memberships receive a daily invoice.
    // Standard memberships record attendance without an additional charge.
    if (membership.billing_mode_snapshot === 'attendance') {
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


    }

    const [checkInTimestampRows] = await connection.query(
      `SELECT DATE_FORMAT(checked_in_at, '%Y-%m-%d %H:%i:%s') AS checked_in_at
       FROM member_attendance
       WHERE organization_id = ? AND id = ?
       LIMIT 1`,
      [context.organizationId, attendanceId]
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
      message: membership.billing_mode_snapshot === 'attendance'
        ? (createdDailyInvoice
          ? 'Attendance recorded and daily fee invoiced.'
          : 'A daily charge already exists for this membership today.')
        : 'Attendance recorded. No daily fee is charged for this membership.',
      attendance: {
        id: attendanceId,
        member_id: memberId,
        member_code: member.member_code,
        member_name: member.full_name,
        checked_in_at: checkInTimestampRows[0]?.checked_in_at || null,
        membership_id: membershipId,
        billing_mode: membership.billing_mode_snapshot || 'standard',
        branch_id: context.branchId,
        attendance_date: today,
        invoice_id: invoiceId,
        invoice_number: invoiceNumber || null,
        daily_fee: membership.billing_mode_snapshot === 'attendance' ? String(membership.price_snapshot) : null,
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

const checkOutMember = async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const context = getContext(req);
    const body = req.body || {};
    const memberId = positiveId(body.member_id);

    if (!memberId || Object.keys(body).some((key) => key !== 'member_id')) {
      throw new AttendanceError(400, 'INVALID_ATTENDANCE_CHECK_OUT',
        'A valid member_id is required.');
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const today = await getToday(connection);

    const [memberRows] = await connection.query(
      `SELECT id, member_code, full_name, status
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

    const [attendanceRows] = await connection.query(
      `SELECT id, checked_in_at, checked_out_at, attendance_status, branch_id
       FROM member_attendance
       WHERE organization_id = ?
         AND member_id = ?
         AND attendance_date = ?
       LIMIT 1 FOR UPDATE`,
      [context.organizationId, memberId, today]
    );

    if (!attendanceRows.length) {
      throw new AttendanceError(409, 'NO_TODAY_CHECK_IN',
        'This member has no check-in record for today.');
    }

    const attendance = attendanceRows[0];
    if (attendance.checked_out_at != null || attendance.attendance_status === 'checked_out') {
      throw new AttendanceError(409, 'MEMBER_ALREADY_CHECKED_OUT_TODAY',
        'This member has already checked out today.');
    }

    await connection.query(
      `UPDATE member_attendance
       SET checked_out_at = CURRENT_TIMESTAMP,
           checked_out_by_user_id = ?,
           checked_out_branch_id = ?,
           attendance_status = 'checked_out'
       WHERE organization_id = ? AND id = ?`,
      [context.userId, context.branchId, context.organizationId, attendance.id]
    );

    const [updatedRows] = await connection.query(
      `SELECT
         DATE_FORMAT(checked_in_at, '%Y-%m-%d %H:%i:%s') AS checked_in_at,
         DATE_FORMAT(checked_out_at, '%Y-%m-%d %H:%i:%s') AS checked_out_at
       FROM member_attendance
       WHERE organization_id = ? AND id = ?
       LIMIT 1`,
      [context.organizationId, attendance.id]
    );

    await writeAuditLog(
      connection,
      req,
      context,
      {
        action: 'MEMBER_ATTENDANCE_CHECKED_OUT',
        entityType: 'member_attendance',
        entityId: Number(attendance.id),
        description: `Member ${member.member_code} checked out at the active branch on ${today}.`,
        oldValues: {
          attendance_status: 'open',
          checked_out_at: null,
        },
        newValues: {
          attendance_id: Number(attendance.id),
          member_id: memberId,
          attendance_date: today,
          checked_in_at: updatedRows[0]?.checked_in_at || null,
          checked_out_at: updatedRows[0]?.checked_out_at || null,
          check_in_branch_id: Number(attendance.branch_id),
          check_out_branch_id: context.branchId,
          checked_out_by_user_id: context.userId,
          attendance_status: 'checked_out',
        },
        metadata: buildMemberAuditMetadata(member, {
          attendance: {
            attendance_id: Number(attendance.id),
            check_in_branch_id: Number(attendance.branch_id),
            check_out_branch_id: context.branchId,
          },
        }),
      }
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Member checked out successfully.',
      attendance: {
        id: Number(attendance.id),
        member_id: memberId,
        member_code: member.member_code,
        member_name: member.full_name,
        checked_in_at: updatedRows[0]?.checked_in_at || null,
        checked_out_at: updatedRows[0]?.checked_out_at || null,
        attendance_status: 'checked_out',
        check_in_branch_id: Number(attendance.branch_id),
        check_out_branch_id: context.branchId,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Attendance checkout rollback failed:', rollbackError.message);
      }
    }

    return getErrorResponse(res, error, 'ATTENDANCE_CHECK_OUT_FAILED',
      'Unable to record member checkout.');
  } finally {
    if (connection) connection.release();
  }
};
const getMemberAttendanceSummary = async (req, res) => {
  try {
    const context = getContext(req);

    const qrOrganizationId = positiveId(req.query.organization_id);
    const memberCode = typeof req.query.member_code === 'string'
      ? req.query.member_code.trim()
      : '';

    if (
      qrOrganizationId !== context.organizationId ||
      !memberCode ||
      memberCode.length > 64
    ) {
      throw new AttendanceError(
        404,
        'ATTENDANCE_QR_NOT_RECOGNIZED',
        'This QR code is invalid or does not belong to this organization.'
      );
    }

    const [memberRows] = await db.query(
      `SELECT id, member_code, full_name, status
       FROM members
       WHERE organization_id = ?
         AND member_code = ?
       LIMIT 1`,
      [context.organizationId, memberCode]
    );

    if (!memberRows.length) {
      throw new AttendanceError(
        404,
        'ATTENDANCE_QR_MEMBER_NOT_FOUND',
        'Member was not found in this organization.'
      );
    }

    const member = memberRows[0];

    const permissions = new Set(
      Array.isArray(req.gymStaff?.permissions)
        ? req.gymStaff.permissions
        : []
    );

    const canViewAttendance =
      permissions.has('attendance.view') ||
      permissions.has('attendance.check_in');

    let attendance = null;

    if (canViewAttendance) {
      // Organization-wide lookup: registration branch and current
      // active branch must never restrict a member's attendance history.
      const [attendanceRows] = await db.query(
        `SELECT
           a.id,
           a.attendance_date,
           a.attendance_status,
           DATE_FORMAT(
             a.checked_in_at,
             '%Y-%m-%d %H:%i:%s'
           ) AS checked_in_at,
           DATE_FORMAT(
             a.checked_out_at,
             '%Y-%m-%d %H:%i:%s'
           ) AS checked_out_at,
           a.branch_id AS check_in_branch_id,
           checkin_branch.name AS check_in_branch_name,
           a.checked_out_branch_id,
           checkout_branch.name AS check_out_branch_name
         FROM member_attendance a
         LEFT JOIN branches checkin_branch
           ON checkin_branch.organization_id = a.organization_id
          AND checkin_branch.id = a.branch_id
         LEFT JOIN branches checkout_branch
           ON checkout_branch.organization_id = a.organization_id
          AND checkout_branch.id = a.checked_out_branch_id
         WHERE a.organization_id = ?
           AND a.member_id = ?
           AND a.attendance_date = CURRENT_DATE()
         ORDER BY a.id DESC
         LIMIT 1`,
        [context.organizationId, Number(member.id)]
      );

      if (attendanceRows.length) {
        const row = attendanceRows[0];

        attendance = {
          id: Number(row.id),
          attendance_date: row.attendance_date,
          attendance_status: row.attendance_status,
          checked_in_at: row.checked_in_at,
          checked_out_at: row.checked_out_at,
          check_in_branch_id: Number(row.check_in_branch_id),
          check_in_branch_name: row.check_in_branch_name,
          checked_out_branch_id:
            row.checked_out_branch_id == null
              ? null
              : Number(row.checked_out_branch_id),
          check_out_branch_name: row.check_out_branch_name,
        };
      }
    }

    return res.json({
      success: true,
      member: {
        id: Number(member.id),
        member_code: member.member_code,
        full_name: member.full_name,
        status: member.status,
      },
      attendance,
      permissions: {
        can_view_attendance: canViewAttendance,
        can_check_in: permissions.has('attendance.check_in'),
      },
      scope: {
        organization_id: context.organizationId,
        attendance_scope: 'organization',
      },
    });
  } catch (error) {
    return getErrorResponse(
      res,
      error,
      'ATTENDANCE_MEMBER_SUMMARY_FAILED',
      'Unable to load member summary.'
    );
  }
};
module.exports = {
  searchAttendanceMembers,
  listTodayAttendance,
  checkInMember,
  checkOutMember,
  getMemberAttendanceSummary,
};
