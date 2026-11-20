'use strict';

const db = require('../config/db');

const {
  writeAuditLog,
  buildMemberAuditMetadata,
} = require('../services/gymAuditService');

const VALID_UNITS = new Set(['day', 'week', 'month', 'year']);

class BillingError extends Error {
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
    throw new BillingError(
      401,
      'MEMBERSHIP_BILLING_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const ensureObjectBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BillingError(
      400,
      'INVALID_INVOICE_REQUEST',
      'Request body must be a valid object.'
    );
  }
};

const ensureAllowedFields = (body, allowed) => {
  const unexpected = Object.keys(body).filter(
    (key) => !allowed.has(key)
  );

  if (unexpected.length) {
    throw new BillingError(
      400,
      'UNSUPPORTED_INVOICE_FIELDS',
      `Unsupported fields: ${unexpected.join(', ')}`
    );
  }
};

const parseDateOnly = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new BillingError(
      400,
      'INVALID_INVOICE_DATE',
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
    throw new BillingError(
      400,
      'INVALID_INVOICE_DATE',
      'Date is not a valid calendar date.'
    );
  }

  return value;
};

const normalizeNotes = (value) => {
  if (value == null || value === '') return null;

  if (typeof value !== 'string' || value.trim().length > 1000) {
    throw new BillingError(
      400,
      'INVALID_INVOICE_NOTES',
      'Invoice notes must be text with a maximum of 1000 characters.'
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

const shiftDate = async (connection, date, days) => {
  const [rows] = await connection.query(
    `SELECT DATE_FORMAT(
       DATE_ADD(?, INTERVAL ? DAY),
       '%Y-%m-%d'
     ) AS calculated_date`,
    [date, days]
  );

  if (!rows[0]?.calculated_date) {
    throw new Error('Unable to calculate invoice dates.');
  }

  return rows[0].calculated_date;
};

const addBillingInterval = async (
  connection,
  startDate,
  value,
  unit
) => {
  if (!VALID_UNITS.has(unit)) {
    throw new BillingError(
      409,
      'INVALID_MEMBERSHIP_BILLING_INTERVAL',
      'The saved membership billing interval is invalid.'
    );
  }

  const amount = Number(value);

  if (
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 65535
  ) {
    throw new BillingError(
      409,
      'INVALID_MEMBERSHIP_BILLING_INTERVAL',
      'The saved membership billing interval is invalid.'
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
    throw new Error('Unable to calculate the billing period.');
  }

  return rows[0].calculated_date;
};

/*
 * Membership end_date is exclusive.
 * Invoice billing_period_end is inclusive.
 */
const getInvoicePeriod = async (
  connection,
  context,
  membership,
  today
) => {
  if (membership.status === 'suspended') {
    throw new BillingError(
      409,
      'SUSPENDED_MEMBERSHIP_CANNOT_BE_INVOICED',
      'A suspended membership cannot receive a new invoice. Reactivate it first.'
    );
  }

  if (membership.status === 'cancelled') {
    throw new BillingError(
      409,
      'CANCELLED_MEMBERSHIP_CANNOT_BE_INVOICED',
      'A cancelled membership cannot receive a new invoice.'
    );
  }

  if (membership.validity_type_snapshot === 'fixed') {
    if (!membership.end_date) {
      throw new BillingError(
        409,
        'INVALID_FIXED_MEMBERSHIP_PERIOD',
        'The fixed membership has no valid end date.'
      );
    }

    const periodStart = membership.start_date;
    const periodEndExclusive = membership.end_date;

    if (periodEndExclusive <= periodStart) {
      throw new BillingError(
        409,
        'INVALID_FIXED_MEMBERSHIP_PERIOD',
        'The fixed membership billing period is invalid.'
      );
    }

    return {
      periodStart,
      periodEnd: await shiftDate(
        connection,
        periodEndExclusive,
        -1
      ),
    };
  }

  if (membership.validity_type_snapshot !== 'ongoing') {
    throw new BillingError(
      409,
      'INVALID_MEMBERSHIP_VALIDITY',
      'The saved membership validity type is invalid.'
    );
  }

  if (membership.status !== 'active') {
    throw new BillingError(
      409,
      'INACTIVE_ONGOING_MEMBERSHIP',
      'Only active ongoing memberships can receive a new billing invoice.'
    );
  }

  const intervalValue = Number(
    membership.billing_interval_value_snapshot
  );

  const intervalUnit = membership.billing_interval_unit_snapshot;

  if (
    !Number.isSafeInteger(intervalValue) ||
    intervalValue < 1 ||
    !VALID_UNITS.has(intervalUnit)
  ) {
    throw new BillingError(
      409,
      'INVALID_MEMBERSHIP_BILLING_INTERVAL',
      'The saved membership billing interval is invalid.'
    );
  }

  const [latestRows] = await connection.query(
    `SELECT
       DATE_FORMAT(billing_period_end, '%Y-%m-%d') AS last_period_end
     FROM member_membership_invoices
     WHERE organization_id = ?
       AND membership_id = ?
     ORDER BY billing_period_start DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [context.organizationId, context.membershipId]
  );

  let periodStart;
  let periodEndExclusive;

  if (latestRows.length) {
    const nextStartAfterLatestInvoice = await shiftDate(
      connection,
      latestRows[0].last_period_end,
      1
    );

    // Reactivation may advance next_billing_date to skip
    // billing anniversaries that occurred during suspension.
    const scheduledNextBillingDate = membership.next_billing_date;

    periodStart =
      scheduledNextBillingDate &&
      scheduledNextBillingDate > nextStartAfterLatestInvoice
        ? scheduledNextBillingDate
        : nextStartAfterLatestInvoice;

    if (periodStart > today) {
      throw new BillingError(
        409,
        'NEXT_BILLING_PERIOD_NOT_DUE',
        `The next billing period starts on ${periodStart}.`
      );
    }

    periodEndExclusive = await addBillingInterval(
      connection,
      periodStart,
      intervalValue,
      intervalUnit
    );
  } else {
    // No previous invoice exists. Preserve the original first
    // billing period unless reactivation advanced its boundary.
    const originalFirstBillingBoundary = await addBillingInterval(
      connection,
      membership.start_date,
      intervalValue,
      intervalUnit
    );

    const storedNextBillingDate =
      membership.next_billing_date ||
      originalFirstBillingBoundary;

    if (storedNextBillingDate > originalFirstBillingBoundary) {
      // First invoice is being generated after a suspension.
      // Start at the resumed billing anniversary, not membership
      // start_date, so suspended periods are not charged.
      periodStart = storedNextBillingDate;

      if (periodStart > today) {
        throw new BillingError(
          409,
          'NEXT_BILLING_PERIOD_NOT_DUE',
          `The next billing period starts on ${periodStart}.`
        );
      }

      periodEndExclusive = await addBillingInterval(
        connection,
        periodStart,
        intervalValue,
        intervalUnit
      );
    } else {
      // Normal first invoice: retain the original billing period.
      periodStart = membership.start_date;
      periodEndExclusive = storedNextBillingDate;
    }
  }

  if (periodEndExclusive <= periodStart) {
    throw new BillingError(
      409,
      'INVALID_MEMBERSHIP_BILLING_PERIOD',
      'Unable to calculate a valid recurring billing period.'
    );
  }

  return {
    periodStart,
    periodEnd: await shiftDate(
      connection,
      periodEndExclusive,
      -1
    ),
  };
};

/*
 * The sequence row is locked by the INSERT/UPDATE inside the
 * current transaction. Concurrent requests cannot receive the
 * same organization/year invoice sequence.
 */
const nextInvoiceNumber = async (
  connection,
  organizationId,
  invoiceDate
) => {
  const year = Number(invoiceDate.substring(0, 4));

  await connection.query(
    `INSERT INTO member_membership_billing_sequences
      (
        organization_id,
        document_type,
        document_year,
        sequence_value
      )
     VALUES (?, 'invoice', ?, 1)
     ON DUPLICATE KEY UPDATE
       sequence_value = sequence_value + 1`,
    [organizationId, year]
  );

  const [rows] = await connection.query(
    `SELECT sequence_value
     FROM member_membership_billing_sequences
     WHERE organization_id = ?
       AND document_type = 'invoice'
       AND document_year = ?
     LIMIT 1
     FOR UPDATE`,
    [organizationId, year]
  );

  if (!rows.length) {
    throw new Error('Unable to reserve an invoice number.');
  }

  const sequence = String(rows[0].sequence_value);

  return `INV-${year}-${sequence.padStart(6, '0')}`;
};

const getMembershipForBilling = async (
  connection,
  context,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `SELECT
       mm.id,
       mm.organization_id,
       mm.membership_plan_id,
       mm.primary_member_id,
       mm.status,

       mm.plan_code_snapshot,
       mm.plan_name_snapshot,
       mm.validity_type_snapshot,

       mm.duration_value_snapshot,
       mm.duration_unit_snapshot,

       mm.billing_interval_value_snapshot,
       mm.billing_interval_unit_snapshot,

       mm.price_snapshot,
       mm.currency_code_snapshot,

       DATE_FORMAT(mm.start_date, '%Y-%m-%d') AS start_date,
       DATE_FORMAT(mm.end_date, '%Y-%m-%d') AS end_date,
       DATE_FORMAT(mm.next_billing_date, '%Y-%m-%d') AS next_billing_date

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
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [
      context.organizationId,
      context.membershipId,
      context.memberId,
    ]
  );

  if (!rows.length) {
    throw new BillingError(
      404,
      'MEMBER_MEMBERSHIP_NOT_FOUND',
      'Membership was not found for this member.'
    );
  }

  return rows[0];
};

const getPrimaryMember = async (
  connection,
  organizationId,
  primaryMemberId,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `SELECT
       m.id,
       m.member_code,
       m.full_name,
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
    [organizationId, primaryMemberId]
  );

  if (!rows.length) {
    throw new BillingError(
      404,
      'MEMBERSHIP_PRIMARY_MEMBER_NOT_FOUND',
      'The primary member was not found in this organization.'
    );
  }

  return rows[0];
};

const invoiceSummarySql = `
  SELECT
    i.id,
    i.organization_id,
    i.membership_id,
    i.primary_member_id,
    i.branch_id,
    i.invoice_number,

    i.plan_code_snapshot,
    i.plan_name_snapshot,
    i.member_code_snapshot,
    i.member_name_snapshot,

    DATE_FORMAT(i.billing_period_start, '%Y-%m-%d')
      AS billing_period_start,
    DATE_FORMAT(i.billing_period_end, '%Y-%m-%d')
      AS billing_period_end,
    DATE_FORMAT(i.invoice_date, '%Y-%m-%d')
      AS invoice_date,
    DATE_FORMAT(i.due_date, '%Y-%m-%d')
      AS due_date,

    i.total_amount,
    i.currency_code,
    i.status,
    i.notes,

    COALESCE(ledger.allocated_amount, 0.00)
      AS allocated_amount,

    COALESCE(ledger.refunded_amount, 0.00)
      AS refunded_amount,

    COALESCE(waiver_ledger.waived_amount, 0.00)
      AS waived_amount,

    GREATEST(
      COALESCE(ledger.allocated_amount, 0.00) -
      COALESCE(ledger.refunded_amount, 0.00),
      0.00
    ) AS net_paid,

    GREATEST(
      i.total_amount -
      GREATEST(
        COALESCE(ledger.allocated_amount, 0.00) -
        COALESCE(ledger.refunded_amount, 0.00),
        0.00
      ) -
      COALESCE(waiver_ledger.waived_amount, 0.00),
      0.00
    ) AS balance_due,

    CASE
      WHEN i.total_amount = 0 THEN 'paid'

      WHEN GREATEST(
        COALESCE(ledger.allocated_amount, 0.00) -
        COALESCE(ledger.refunded_amount, 0.00),
        0.00
      ) >= i.total_amount THEN 'paid'

      WHEN (
        GREATEST(
          COALESCE(ledger.allocated_amount, 0.00) -
          COALESCE(ledger.refunded_amount, 0.00),
          0.00
        ) +
        COALESCE(waiver_ledger.waived_amount, 0.00)
      ) >= i.total_amount THEN
        CASE
          WHEN
            COALESCE(waiver_ledger.waived_amount, 0.00) > 0
            AND GREATEST(
              COALESCE(ledger.allocated_amount, 0.00) -
              COALESCE(ledger.refunded_amount, 0.00),
              0.00
            ) > 0
            THEN 'settled'
          WHEN COALESCE(waiver_ledger.waived_amount, 0.00)
            >= i.total_amount
            THEN 'waived'
          ELSE 'paid'
        END

      WHEN GREATEST(
        COALESCE(ledger.allocated_amount, 0.00) -
        COALESCE(ledger.refunded_amount, 0.00),
        0.00
      ) > 0 THEN 'partially_paid'

      WHEN COALESCE(waiver_ledger.waived_amount, 0.00) > 0
        THEN 'partially_waived'

      ELSE 'unpaid'
    END AS payment_status,

    CASE
      WHEN i.status = 'issued'
       AND i.due_date IS NOT NULL
       AND i.due_date < CURRENT_DATE()
       AND GREATEST(
         i.total_amount -
         GREATEST(
           COALESCE(ledger.allocated_amount, 0.00) -
           COALESCE(ledger.refunded_amount, 0.00),
           0.00
         ) -
         COALESCE(waiver_ledger.waived_amount, 0.00),
         0.00
       ) > 0
      THEN 1
      ELSE 0
    END AS is_overdue,

    i.created_by_user_id,
    i.updated_by_user_id,
    i.created_at,
    i.updated_at

  FROM member_membership_invoices i

  LEFT JOIN (
    SELECT
      a.organization_id,
      a.invoice_id,
      SUM(a.allocated_amount) AS allocated_amount,
      SUM(COALESCE(r.refunded_amount, 0.00)) AS refunded_amount

    FROM member_membership_payment_allocations a

    INNER JOIN member_membership_payments p
      ON p.organization_id = a.organization_id
     AND p.id = a.payment_id
     AND p.status = 'posted'

    LEFT JOIN (
      SELECT
        organization_id,
        payment_allocation_id,
        SUM(refund_amount) AS refunded_amount
      FROM member_membership_refunds
      WHERE status = 'posted'
      GROUP BY organization_id, payment_allocation_id
    ) r
      ON r.organization_id = a.organization_id
     AND r.payment_allocation_id = a.id

    GROUP BY a.organization_id, a.invoice_id
  ) ledger
    ON ledger.organization_id = i.organization_id
   AND ledger.invoice_id = i.id

  LEFT JOIN (
    SELECT
      organization_id,
      invoice_id,
      SUM(waiver_amount) AS waived_amount
    FROM member_membership_invoice_waivers
    WHERE status = 'posted'
    GROUP BY organization_id, invoice_id
  ) waiver_ledger
    ON waiver_ledger.organization_id = i.organization_id
   AND waiver_ledger.invoice_id = i.id
`;

const serializeInvoice = (row) => ({
  id: Number(row.id),
  organization_id: Number(row.organization_id),
  membership_id: Number(row.membership_id),
  primary_member_id: Number(row.primary_member_id),
  branch_id: Number(row.branch_id),

  invoice_number: row.invoice_number,

  plan_code: row.plan_code_snapshot,
  plan_name: row.plan_name_snapshot,

  member_code: row.member_code_snapshot,
  member_name: row.member_name_snapshot,

  billing_period_start: row.billing_period_start,
  billing_period_end: row.billing_period_end,

  invoice_date: row.invoice_date,
  due_date: row.due_date,

  total_amount: String(row.total_amount),
  currency_code: row.currency_code,

  allocated_amount: String(row.allocated_amount),
  refunded_amount: String(row.refunded_amount),
  waived_amount: String(row.waived_amount),
  net_paid: String(row.net_paid),
  balance_due: String(row.balance_due),

  payment_status: row.payment_status,
  is_overdue: Boolean(row.is_overdue),

  status: row.status,
  notes: row.notes,

  created_by_user_id: Number(row.created_by_user_id),
  updated_by_user_id:
    row.updated_by_user_id == null
      ? null
      : Number(row.updated_by_user_id),

  created_at: row.created_at,
  updated_at: row.updated_at,
});

const getErrorResponse = (res, error, fallbackCode, fallbackMessage) => {
  if (error instanceof BillingError) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      code: 'MEMBERSHIP_INVOICE_ALREADY_EXISTS',
      message:
        'An invoice already exists for this membership billing period.',
    });
  }

  if (
    error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' ||
    error.errno === 3819
  ) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_MEMBERSHIP_INVOICE',
      message: 'Invoice values do not satisfy the database rules.',
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
// GET /api/members/:memberId/memberships/:membershipId/invoices
// --------------------------------------------------

const listMembershipInvoices = async (req, res) => {
  try {
    const context = getContext(req);

    await getMembershipForBilling(db, context);

    const [rows] = await db.query(
      `${invoiceSummarySql}
       WHERE i.organization_id = ?
         AND i.membership_id = ?
       ORDER BY i.invoice_date DESC, i.id DESC`,
      [context.organizationId, context.membershipId]
    );

    return res.json({
      success: true,
      membership_id: context.membershipId,
      invoices: rows.map(serializeInvoice),
    });
  } catch (error) {
    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_INVOICE_LIST_FAILED',
      'Unable to load membership invoices.'
    );
  }
};

// --------------------------------------------------
// POST /api/members/:memberId/memberships/:membershipId/invoices
// --------------------------------------------------

const createMembershipInvoice = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureObjectBody(body);
    ensureAllowedFields(body, new Set(['due_date', 'notes']));

    const dueDate = body.due_date == null || body.due_date === ''
      ? null
      : parseDateOnly(body.due_date);

    const notes = normalizeNotes(body.notes);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const membership = await getMembershipForBilling(
      connection,
      context,
      true
    );

    const primaryMember = await getPrimaryMember(
      connection,
      context.organizationId,
      Number(membership.primary_member_id),
      true
    );

    const invoiceDate = await getToday(connection);

    if (dueDate && dueDate < invoiceDate) {
      throw new BillingError(
        400,
        'INVOICE_DUE_DATE_BEFORE_ISSUE_DATE',
        'Invoice due date cannot be earlier than the invoice date.'
      );
    }

    const period = await getInvoicePeriod(
      connection,
      context,
      membership,
      invoiceDate
    );

    const invoiceNumber = await nextInvoiceNumber(
      connection,
      context.organizationId,
      invoiceDate
    );

    const [insertResult] = await connection.query(
      `INSERT INTO member_membership_invoices
       (
         organization_id,
         membership_id,
         primary_member_id,
         branch_id,
         invoice_number,

         plan_code_snapshot,
         plan_name_snapshot,
         member_code_snapshot,
         member_name_snapshot,

         billing_period_start,
         billing_period_end,
         invoice_date,
         due_date,

         total_amount,
         currency_code,
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
         ?, ?, 'issued', ?,
         ?, ?
       )`,
      [
        context.organizationId,
        context.membershipId,
        membership.primary_member_id,
        context.branchId,
        invoiceNumber,

        membership.plan_code_snapshot,
        membership.plan_name_snapshot,
        primaryMember.member_code,
        primaryMember.full_name,

        period.periodStart,
        period.periodEnd,
        invoiceDate,
        dueDate,

        membership.price_snapshot,
        membership.currency_code_snapshot,
        notes,

        context.userId,
        context.userId,
      ]
    );

    const invoiceId = Number(insertResult.insertId);

    await writeAuditLog(
      connection,
      req,
      {
        organizationId: context.organizationId,
        branchId: context.branchId,
        userId: context.userId,
      },
      {
        action: 'MEMBER_MEMBERSHIP_INVOICE_ISSUED',
        entityType: 'member_membership_invoice',
        entityId: invoiceId,
        description:
          `Issued invoice ${invoiceNumber} for membership ` +
          `${context.membershipId}; member ${primaryMember.member_code}.`,
        oldValues: {
          record_exists: false,
        },
        newValues: {
          record_exists: true,
          invoice_number: invoiceNumber,
          membership_id: context.membershipId,
          billing_period_start: period.periodStart,
          billing_period_end: period.periodEnd,
          total_amount: String(membership.price_snapshot),
          currency_code: membership.currency_code_snapshot,
          status: 'issued',
        },
        metadata: buildMemberAuditMetadata(
          primaryMember,
          {
            member_membership_billing: {
              invoice_id: invoiceId,
              invoice_number: invoiceNumber,
              membership_id: context.membershipId,
              primary_member_id: Number(membership.primary_member_id),
              action_branch_id: context.branchId,
              billing_period_start: period.periodStart,
              billing_period_end: period.periodEnd,
            },
          }
        ),
      }
    );

    const [invoiceRows] = await connection.query(
      `${invoiceSummarySql}
       WHERE i.organization_id = ?
         AND i.membership_id = ?
         AND i.id = ?
       LIMIT 1`,
      [
        context.organizationId,
        context.membershipId,
        invoiceId,
      ]
    );

    if (!invoiceRows.length) {
      throw new Error('Created invoice could not be loaded.');
    }

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Membership invoice created successfully.',
      invoice: serializeInvoice(invoiceRows[0]),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Invoice creation rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_INVOICE_CREATE_FAILED',
      'Unable to create the membership invoice.'
    );
  } finally {
    if (connection) connection.release();
  }
};


// --------------------------------------------------
// POST .../invoices/:invoiceId/void
// --------------------------------------------------

const voidMembershipInvoice = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureObjectBody(body);
    ensureAllowedFields(body, new Set(['reason']));

    const reason = body.reason;

    if (
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.trim().length > 500
    ) {
      throw new BillingError(
        400,
        'INVALID_INVOICE_VOID_REASON',
        'A void reason is required (maximum 500 characters).'
      );
    }

    const invoiceId = parsePositiveId(req.params.invoiceId);

    if (!invoiceId) {
      throw new BillingError(
        400,
        'INVALID_INVOICE_ID',
        'Invoice ID is invalid.'
      );
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    // Lock the membership and verify that the requested member
    // belongs to this membership in the authenticated organization.
    const membership = await getMembershipForBilling(
      connection,
      context,
      true
    );

    const [invoiceRows] = await connection.query(
      `SELECT
         id,
         organization_id,
         membership_id,
         primary_member_id,
         invoice_number,
         total_amount,
         currency_code,
         status
       FROM member_membership_invoices
       WHERE organization_id = ?
         AND membership_id = ?
         AND id = ?
       LIMIT 1
       FOR UPDATE`,
      [
        context.organizationId,
        context.membershipId,
        invoiceId,
      ]
    );

    if (!invoiceRows.length) {
      throw new BillingError(
        404,
        'MEMBERSHIP_INVOICE_NOT_FOUND',
        'Invoice was not found for this membership.'
      );
    }

    const invoice = invoiceRows[0];

    if (invoice.status === 'void') {
      throw new BillingError(
        409,
        'MEMBERSHIP_INVOICE_ALREADY_VOID',
        'This invoice has already been voided.'
      );
    }

    if (invoice.status !== 'issued') {
      throw new BillingError(
        409,
        'MEMBERSHIP_INVOICE_NOT_VOIDABLE',
        'This invoice cannot be voided in its current status.'
      );
    }

    // Never void an invoice that has a posted payment allocation.
    const [paymentRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM member_membership_payment_allocations a
       INNER JOIN member_membership_payments p
         ON p.organization_id = a.organization_id
        AND p.id = a.payment_id
       WHERE a.organization_id = ?
         AND a.invoice_id = ?
         AND p.status = 'posted'`,
      [context.organizationId, invoiceId]
    );

    if (Number(paymentRows[0]?.total || 0) > 0) {
      throw new BillingError(
        409,
        'MEMBERSHIP_INVOICE_HAS_POSTED_PAYMENTS',
        'This invoice has posted payment allocations. Void or reverse those payments before voiding the invoice.'
      );
    }

    // Keep posted refunds protected even if a related payment
    // has subsequently been voided.
    const [refundRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM member_membership_refunds r
       INNER JOIN member_membership_payment_allocations a
         ON a.organization_id = r.organization_id
        AND a.id = r.payment_allocation_id
       WHERE r.organization_id = ?
         AND a.invoice_id = ?
         AND r.status = 'posted'`,
      [context.organizationId, invoiceId]
    );

    if (Number(refundRows[0]?.total || 0) > 0) {
      throw new BillingError(
        409,
        'MEMBERSHIP_INVOICE_HAS_POSTED_REFUNDS',
        'This invoice has posted refunds and cannot be voided.'
      );
    }

    // Posted waivers must be reversed before invoice voiding.
    const [waiverRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM member_membership_invoice_waivers
       WHERE organization_id = ?
         AND invoice_id = ?
         AND status = 'posted'`,
      [context.organizationId, invoiceId]
    );

    if (Number(waiverRows[0]?.total || 0) > 0) {
      throw new BillingError(
        409,
        'MEMBERSHIP_INVOICE_HAS_POSTED_WAIVERS',
        'This invoice has posted waivers. Void the posted waivers before voiding the invoice.'
      );
    }

    const primaryMember = await getPrimaryMember(
      connection,
      context.organizationId,
      Number(invoice.primary_member_id),
      true
    );

    await connection.query(
      `UPDATE member_membership_invoices
       SET status = 'void',
           voided_at = CURRENT_TIMESTAMP,
           voided_by_user_id = ?,
           void_reason = ?,
           updated_by_user_id = ?
       WHERE organization_id = ?
         AND membership_id = ?
         AND id = ?
         AND status = 'issued'`,
      [
        context.userId,
        reason.trim(),
        context.userId,
        context.organizationId,
        context.membershipId,
        invoiceId,
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
        action: 'MEMBER_MEMBERSHIP_INVOICE_VOIDED',
        entityType: 'member_membership_invoice',
        entityId: invoiceId,
        description:
          `Voided invoice ${invoice.invoice_number} for membership ` +
          `${context.membershipId}; reason: ${reason.trim()}.`,
        oldValues: {
          status: 'issued',
          total_amount: String(invoice.total_amount),
          currency_code: invoice.currency_code,
        },
        newValues: {
          status: 'void',
          void_reason: reason.trim(),
        },
        metadata: buildMemberAuditMetadata(
          primaryMember,
          {
            member_membership_billing: {
              invoice_id: invoiceId,
              invoice_number: invoice.invoice_number,
              membership_id: context.membershipId,
              primary_member_id: Number(invoice.primary_member_id),
              action_branch_id: context.branchId,
            },
          }
        ),
      }
    );

    const [updatedRows] = await connection.query(
      `${invoiceSummarySql}
       WHERE i.organization_id = ?
         AND i.membership_id = ?
         AND i.id = ?
       LIMIT 1`,
      [
        context.organizationId,
        context.membershipId,
        invoiceId,
      ]
    );

    if (!updatedRows.length) {
      throw new Error('Voided invoice could not be loaded.');
    }

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Membership invoice voided successfully.',
      invoice: serializeInvoice(updatedRows[0]),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Invoice void rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_INVOICE_VOID_FAILED',
      'Unable to void the membership invoice.'
    );
  } finally {
    if (connection) connection.release();
  }
};
module.exports = {
  listMembershipInvoices,
  createMembershipInvoice,
  voidMembershipInvoice,
};

