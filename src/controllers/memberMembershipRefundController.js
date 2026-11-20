'use strict';

const db = require('../config/db');

const {
  writeAuditLog,
  buildMemberAuditMetadata,
} = require('../services/gymAuditService');

const REFUND_METHODS = new Set([
  'original_method',
  'cash',
  'bank_transfer',
  'other',
]);

class RefundError extends Error {
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
    invoiceId: parsePositiveId(req.params.invoiceId),
    paymentId: parsePositiveId(req.params.paymentId),
    organizationId: parsePositiveId(req.gymStaff?.organizationId),
    branchId: parsePositiveId(req.gymStaff?.branchId),
    userId: parsePositiveId(req.gymStaff?.userId),
  };

  if (
    !context.memberId ||
    !context.membershipId ||
    !context.invoiceId ||
    !context.paymentId ||
    !context.organizationId ||
    !context.branchId ||
    !context.userId
  ) {
    throw new RefundError(
      401,
      'MEMBERSHIP_REFUND_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const ensureObjectBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RefundError(
      400,
      'INVALID_REFUND_REQUEST',
      'Request body must be a valid object.'
    );
  }
};

const ensureAllowedFields = (body, allowed) => {
  const unexpected = Object.keys(body).filter(
    (key) => !allowed.has(key)
  );

  if (unexpected.length) {
    throw new RefundError(
      400,
      'UNSUPPORTED_REFUND_FIELDS',
      `Unsupported fields: ${unexpected.join(', ')}`
    );
  }
};

const parseMoney = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new RefundError(
      400,
      'INVALID_REFUND_AMOUNT',
      'Refund amount must be a positive amount with up to two decimal places.'
    );
  }

  const raw = String(value).trim();

  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) {
    throw new RefundError(
      400,
      'INVALID_REFUND_AMOUNT',
      'Refund amount must be a positive amount with up to two decimal places.'
    );
  }

  const [whole, fraction = ''] = raw.split('.');
  const cents =
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, '0'));

  if (cents <= 0n || cents > 999999999999n) {
    throw new RefundError(
      400,
      'INVALID_REFUND_AMOUNT',
      'Refund amount must be greater than zero and within the supported limit.'
    );
  }

  return {
    cents,
    value:
      `${BigInt(whole).toString()}.` +
      fraction.padEnd(2, '0'),
  };
};

const decimalToCents = (value) => {
  const raw = String(value);

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`Invalid database decimal: ${raw}`);
  }

  const [whole, fraction = ''] = raw.split('.');

  return (
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, '0'))
  );
};

const centsToDecimal = (cents) => {
  const absolute = cents < 0n ? -cents : cents;

  const value =
    `${absolute / 100n}.` +
    String(absolute % 100n).padStart(2, '0');

  return cents < 0n ? `-${value}` : value;
};

const normalizeOptionalText = (value, field, maxLength) => {
  if (value == null || value === '') return null;

  if (
    typeof value !== 'string' ||
    value.trim().length > maxLength
  ) {
    throw new RefundError(
      400,
      `INVALID_${field.toUpperCase()}`,
      `${field} must be text with a maximum length of ${maxLength} characters.`
    );
  }

  return value.trim() || null;
};

const normalizeIdempotencyKey = (value) => {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())
  ) {
    throw new RefundError(
      400,
      'INVALID_REFUND_IDEMPOTENCY_KEY',
      'A valid UUID idempotency_key is required.'
    );
  }

  return value.trim().toLowerCase();
};
const requireReason = (value) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 500
  ) {
    throw new RefundError(
      400,
      'REFUND_REASON_REQUIRED',
      'A refund reason is required (maximum 500 characters).'
    );
  }

  return value.trim();
};

const getMembership = async (connection, context) => {
  const [rows] = await connection.query(
    `SELECT
       id,
       primary_member_id
     FROM member_memberships
     WHERE organization_id = ?
       AND id = ?
       AND EXISTS (
         SELECT 1
         FROM member_membership_members participant
         WHERE participant.organization_id =
           member_memberships.organization_id
           AND participant.membership_id = member_memberships.id
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
    throw new RefundError(
      404,
      'MEMBER_MEMBERSHIP_NOT_FOUND',
      'Membership was not found for this member.'
    );
  }

  return rows[0];
};

const getInvoice = async (connection, context) => {
  const [rows] = await connection.query(
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
      context.invoiceId,
    ]
  );

  if (!rows.length) {
    throw new RefundError(
      404,
      'MEMBERSHIP_INVOICE_NOT_FOUND',
      'Invoice was not found for this membership.'
    );
  }

  return rows[0];
};

const getPaymentAllocation = async (connection, context) => {
  const [rows] = await connection.query(
    `SELECT
       p.id AS payment_id,
       p.payment_number,
       p.payer_member_id,
       p.amount AS payment_amount,
       p.currency_code,
       p.payment_method AS original_payment_method,
       p.status AS payment_status,

       a.id AS allocation_id,
       a.allocated_amount,

       i.invoice_number,
       i.status AS invoice_status

     FROM member_membership_payments p

     INNER JOIN member_membership_payment_allocations a
       ON a.organization_id = p.organization_id
      AND a.payment_id = p.id

     INNER JOIN member_membership_invoices i
       ON i.organization_id = a.organization_id
      AND i.id = a.invoice_id

     WHERE p.organization_id = ?
       AND p.id = ?
       AND a.invoice_id = ?
       AND i.membership_id = ?
     LIMIT 1
     FOR UPDATE`,
    [
      context.organizationId,
      context.paymentId,
      context.invoiceId,
      context.membershipId,
    ]
  );

  if (!rows.length) {
    throw new RefundError(
      404,
      'MEMBERSHIP_PAYMENT_ALLOCATION_NOT_FOUND',
      'Payment allocation was not found for this invoice.'
    );
  }

  return rows[0];
};

const getRefundableBalance = async (
  connection,
  organizationId,
  allocationId
) => {
  const [rows] = await connection.query(
    `SELECT
       a.allocated_amount,
       COALESCE(
         (
           SELECT SUM(r.refund_amount)
           FROM member_membership_refunds r
           WHERE r.organization_id = a.organization_id
             AND r.payment_allocation_id = a.id
             AND r.status = 'posted'
         ),
         0.00
       ) AS refunded_amount

     FROM member_membership_payment_allocations a
     WHERE a.organization_id = ?
       AND a.id = ?
     LIMIT 1`,
    [organizationId, allocationId]
  );

  if (!rows.length) {
    throw new RefundError(
      404,
      'MEMBERSHIP_PAYMENT_ALLOCATION_NOT_FOUND',
      'Payment allocation was not found.'
    );
  }

  const allocated = decimalToCents(rows[0].allocated_amount);
  const refunded = decimalToCents(rows[0].refunded_amount);

  const remaining = allocated - refunded;

  return {
    allocated_amount: centsToDecimal(allocated),
    refunded_amount: centsToDecimal(refunded),
    refundable_amount: centsToDecimal(
      remaining > 0n ? remaining : 0n
    ),
    remainingCents: remaining > 0n ? remaining : 0n,
  };
};

const getInvoiceBalance = async (
  connection,
  organizationId,
  invoiceId
) => {
  const [rows] = await connection.query(
    `SELECT
       i.total_amount,

       COALESCE(
         (
           SELECT SUM(a.allocated_amount)
           FROM member_membership_payment_allocations a
           INNER JOIN member_membership_payments p
             ON p.organization_id = a.organization_id
            AND p.id = a.payment_id
            AND p.status = 'posted'
           WHERE a.organization_id = i.organization_id
             AND a.invoice_id = i.id
         ),
         0.00
       ) AS allocated_amount,

       COALESCE(
         (
           SELECT SUM(r.refund_amount)
           FROM member_membership_refunds r
           INNER JOIN member_membership_payment_allocations a
             ON a.organization_id = r.organization_id
            AND a.id = r.payment_allocation_id
           INNER JOIN member_membership_payments p
             ON p.organization_id = a.organization_id
            AND p.id = a.payment_id
            AND p.status = 'posted'
           WHERE r.organization_id = i.organization_id
             AND a.invoice_id = i.id
             AND r.status = 'posted'
         ),
         0.00
       ) AS refunded_amount,

       COALESCE(
         (
           SELECT SUM(w.waiver_amount)
           FROM member_membership_invoice_waivers w
           WHERE w.organization_id = i.organization_id
             AND w.invoice_id = i.id
             AND w.status = 'posted'
         ),
         0.00
       ) AS waived_amount

     FROM member_membership_invoices i
     WHERE i.organization_id = ?
       AND i.id = ?
     LIMIT 1`,
    [organizationId, invoiceId]
  );

  if (!rows.length) {
    throw new RefundError(
      404,
      'MEMBERSHIP_INVOICE_NOT_FOUND',
      'Invoice was not found.'
    );
  }

  const total = decimalToCents(rows[0].total_amount);
  const allocated = decimalToCents(rows[0].allocated_amount);
  const refunded = decimalToCents(rows[0].refunded_amount);
  const waived = decimalToCents(rows[0].waived_amount);

  const rawNetPaid = allocated - refunded;
  const netPaid = rawNetPaid > 0n ? rawNetPaid : 0n;

  const rawBalance = total - netPaid - waived;
  const balanceDue = rawBalance > 0n ? rawBalance : 0n;

  let paymentStatus = 'unpaid';

  if (total === 0n || netPaid >= total) {
    paymentStatus = 'paid';
  } else if (balanceDue === 0n) {
    if (netPaid > 0n && waived > 0n) {
      paymentStatus = 'settled';
    } else if (waived > 0n) {
      paymentStatus = 'waived';
    } else {
      paymentStatus = 'paid';
    }
  } else if (netPaid > 0n) {
    paymentStatus = 'partially_paid';
  } else if (waived > 0n) {
    paymentStatus = 'partially_waived';
  }

  return {
    total_amount: centsToDecimal(total),
    allocated_amount: centsToDecimal(allocated),
    refunded_amount: centsToDecimal(refunded),
    waived_amount: centsToDecimal(waived),
    net_paid: centsToDecimal(netPaid),
    balance_due: centsToDecimal(balanceDue),
    payment_status: paymentStatus,
  };
};

const nextRefundNumber = async (
  connection,
  organizationId
) => {
  const [yearRows] = await connection.query(
    'SELECT YEAR(CURRENT_DATE()) AS document_year'
  );

  const year = Number(yearRows[0]?.document_year);

  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error('Unable to determine refund numbering year.');
  }

  await connection.query(
    `INSERT INTO member_membership_billing_sequences
      (
        organization_id,
        document_type,
        document_year,
        sequence_value
      )
     VALUES (?, 'refund', ?, 1)
     ON DUPLICATE KEY UPDATE
       sequence_value = sequence_value + 1`,
    [organizationId, year]
  );

  const [rows] = await connection.query(
    `SELECT sequence_value
     FROM member_membership_billing_sequences
     WHERE organization_id = ?
       AND document_type = 'refund'
       AND document_year = ?
     LIMIT 1
     FOR UPDATE`,
    [organizationId, year]
  );

  if (!rows.length) {
    throw new Error('Unable to reserve refund number.');
  }

  return `REF-${year}-${String(rows[0].sequence_value).padStart(6, '0')}`;
};

const getRefundAuditMember = async (
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
    throw new RefundError(
      404,
      'REFUND_PAYER_NOT_FOUND',
      'Original payment payer was not found in this organization.'
    );
  }

  return rows[0];
};

const getRefundRecord = async (
  connection,
  organizationId,
  refundId,
  invoiceId
) => {
  const [rows] = await connection.query(
    `SELECT
       r.id,
       r.organization_id,
       r.refund_number,
       r.payment_allocation_id,
       r.branch_id,
       r.refund_amount,
       r.currency_code,
       r.refund_method,
       r.refund_reference,
       DATE_FORMAT(r.refund_date, '%Y-%m-%d %H:%i:%s')
         AS refund_date,
       r.reason,
       r.status,
       r.voided_at,
       r.voided_by_user_id,
       r.void_reason,
       r.notes,
       r.created_by_user_id,

       a.payment_id,
       p.payment_number,
       a.invoice_id

     FROM member_membership_refunds r

     INNER JOIN member_membership_payment_allocations a
       ON a.organization_id = r.organization_id
      AND a.id = r.payment_allocation_id

     INNER JOIN member_membership_payments p
       ON p.organization_id = a.organization_id
      AND p.id = a.payment_id

     WHERE r.organization_id = ?
       AND r.id = ?
       AND a.invoice_id = ?
     LIMIT 1`,
    [organizationId, refundId, invoiceId]
  );

  if (!rows.length) {
    throw new Error('Refund record could not be loaded.');
  }

  const row = rows[0];

  return {
    id: Number(row.id),
    organization_id: Number(row.organization_id),
    refund_number: row.refund_number,
    payment_allocation_id: Number(row.payment_allocation_id),
    payment_id: Number(row.payment_id),
    payment_number: row.payment_number,
    invoice_id: Number(row.invoice_id),
    branch_id: Number(row.branch_id),
    refund_amount: String(row.refund_amount),
    currency_code: row.currency_code,
    refund_method: row.refund_method,
    refund_reference: row.refund_reference,
    refund_date: row.refund_date,
    reason: row.reason,
    status: row.status,
    voided_at: row.voided_at,
    voided_by_user_id:
      row.voided_by_user_id == null
        ? null
        : Number(row.voided_by_user_id),
    void_reason: row.void_reason,
    notes: row.notes,
    created_by_user_id: Number(row.created_by_user_id),
  };
};

const getErrorResponse = (res, error, fallbackCode, fallbackMessage) => {
  if (error instanceof RefundError) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      code: 'MEMBERSHIP_REFUND_CONFLICT',
      message: 'The refund conflicts with an existing record.',
    });
  }

  if (
    error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' ||
    error.errno === 3819
  ) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_MEMBERSHIP_REFUND',
      message: 'Refund values do not satisfy the database rules.',
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
// GET .../payments/:paymentId/refunds
// --------------------------------------------------

const listMemberPaymentRefunds = async (req, res) => {
  try {
    const context = getContext(req);

    await getMembership(db, context);
    await getInvoice(db, context);
    const allocation = await getPaymentAllocation(db, context);

    const [rows] = await db.query(
      `SELECT
         r.id,
         r.refund_number,
         r.payment_allocation_id,
         r.branch_id,
         r.refund_amount,
         r.currency_code,
         r.refund_method,
         r.refund_reference,
         DATE_FORMAT(r.refund_date, '%Y-%m-%d %H:%i:%s')
           AS refund_date,
         r.reason,
         r.status,
         r.voided_at,
         r.void_reason,
         r.notes,
         r.created_by_user_id

       FROM member_membership_refunds r

       WHERE r.organization_id = ?
         AND r.payment_allocation_id = ?

       ORDER BY r.refund_date DESC, r.id DESC`,
      [
        context.organizationId,
        allocation.allocation_id,
      ]
    );

    const refundable = await getRefundableBalance(
      db,
      context.organizationId,
      allocation.allocation_id
    );

    const invoiceBalance = await getInvoiceBalance(
      db,
      context.organizationId,
      context.invoiceId
    );

    return res.json({
      success: true,
      invoice_id: context.invoiceId,
      payment_id: context.paymentId,

      refunds: rows.map((row) => ({
        id: Number(row.id),
        refund_number: row.refund_number,
        payment_allocation_id: Number(row.payment_allocation_id),
        branch_id: Number(row.branch_id),
        refund_amount: String(row.refund_amount),
        currency_code: row.currency_code,
        refund_method: row.refund_method,
        refund_reference: row.refund_reference,
        refund_date: row.refund_date,
        reason: row.reason,
        status: row.status,
        voided_at: row.voided_at,
        void_reason: row.void_reason,
        notes: row.notes,
        created_by_user_id: Number(row.created_by_user_id),
      })),

      refundable_balance: {
        allocated_amount: refundable.allocated_amount,
        refunded_amount: refundable.refunded_amount,
        refundable_amount: refundable.refundable_amount,
      },

      invoice_balance: invoiceBalance,
    });
  } catch (error) {
    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_REFUND_LIST_FAILED',
      'Unable to load payment refunds.'
    );
  }
};

// --------------------------------------------------
// POST .../payments/:paymentId/refunds
// --------------------------------------------------

const createMemberPaymentRefund = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureObjectBody(body);

    ensureAllowedFields(
      body,
      new Set([
        'refund_amount',
        'refund_method',
        'refund_reference',
        'reason',
        'notes',
        'idempotency_key',
      ])
    );

    const amount = parseMoney(body.refund_amount);
    const reason = requireReason(body.reason);

    if (
      typeof body.refund_method !== 'string' ||
      !REFUND_METHODS.has(body.refund_method.trim().toLowerCase())
    ) {
      throw new RefundError(
        400,
        'INVALID_REFUND_METHOD',
        'Select a valid refund method.'
      );
    }

    const refundMethod = body.refund_method.trim().toLowerCase();

    const refundReference = normalizeOptionalText(
      body.refund_reference,
      'refund_reference',
      120
    );

    const notes = normalizeOptionalText(
      body.notes,
      'notes',
      500
    );

    const idempotencyKey = normalizeIdempotencyKey(
      body.idempotency_key
    );

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    await getMembership(connection, context);

    const invoice = await getInvoice(connection, context);

    const allocation = await getPaymentAllocation(
      connection,
      context
    );

    const [existingRefundRows] = await connection.query(
      `SELECT
         id,
         payment_allocation_id,
         refund_amount,
         currency_code,
         refund_method,
         refund_reference,
         reason,
         notes,
         status
       FROM member_membership_refunds
       WHERE organization_id = ?
         AND idempotency_key = ?
       LIMIT 1
       FOR UPDATE`,
      [context.organizationId, idempotencyKey]
    );

    if (existingRefundRows.length) {
      const existing = existingRefundRows[0];

      const sameRequest =
        Number(existing.payment_allocation_id) ===
          Number(allocation.allocation_id) &&
        decimalToCents(existing.refund_amount) === amount.cents &&
        existing.currency_code === allocation.currency_code &&
        existing.refund_method === refundMethod &&
        (existing.refund_reference || null) === refundReference &&
        existing.reason === reason &&
        (existing.notes || null) === notes;

      if (!sameRequest || existing.status !== 'posted') {
        throw new RefundError(
          409,
          'REFUND_IDEMPOTENCY_KEY_REUSED',
          'This refund idempotency key belongs to a different or non-posted refund.'
        );
      }

      const existingRefund = await getRefundRecord(
        connection,
        context.organizationId,
        Number(existing.id),
        context.invoiceId
      );

      const existingRefundable = await getRefundableBalance(
        connection,
        context.organizationId,
        allocation.allocation_id
      );

      const existingInvoiceBalance = await getInvoiceBalance(
        connection,
        context.organizationId,
        context.invoiceId
      );

      await connection.commit();
      transactionStarted = false;

      return res.status(200).json({
        success: true,
        message: 'This refund was already processed.',
        idempotent_replay: true,
        refund: existingRefund,
        invoice_balance: existingInvoiceBalance,
        refundable_balance: {
          allocated_amount: existingRefundable.allocated_amount,
          refunded_amount: existingRefundable.refunded_amount,
          refundable_amount: existingRefundable.refundable_amount,
        },
      });
    }

    if (allocation.payment_status !== 'posted') {
      throw new RefundError(
        409,
        'PAYMENT_NOT_POSTED',
        'Only a posted payment can be refunded.'
      );
    }

    if (allocation.invoice_status !== 'issued') {
      throw new RefundError(
        409,
        'INVOICE_NOT_ISSUED',
        'Refunds can only be recorded against an issued invoice.'
      );
    }

    if (allocation.currency_code !== invoice.currency_code) {
      throw new RefundError(
        409,
        'REFUND_CURRENCY_MISMATCH',
        'Payment and invoice currencies do not match.'
      );
    }

    const refundable = await getRefundableBalance(
      connection,
      context.organizationId,
      allocation.allocation_id
    );

    if (refundable.remainingCents <= 0n) {
      throw new RefundError(
        409,
        'PAYMENT_ALLOCATION_ALREADY_REFUNDED',
        'This payment allocation has no remaining refundable amount.'
      );
    }

    if (amount.cents > refundable.remainingCents) {
      throw new RefundError(
        409,
        'REFUND_EXCEEDS_REFUNDABLE_AMOUNT',
        `Refund exceeds the remaining refundable amount of ${allocation.currency_code} ${refundable.refundable_amount}.`
      );
    }

    const payer = await getRefundAuditMember(
      connection,
      context.organizationId,
      Number(allocation.payer_member_id)
    );

    const refundNumber = await nextRefundNumber(
      connection,
      context.organizationId
    );

    const [insertResult] = await connection.query(
      `INSERT INTO member_membership_refunds
       (
         organization_id,
         refund_number,
         idempotency_key,
         payment_allocation_id,
         branch_id,
         refund_amount,
         currency_code,
         refund_method,
         refund_reference,
         refund_date,
         reason,
         status,
         notes,
         created_by_user_id
       )
       VALUES
       (
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CURRENT_TIMESTAMP,
         ?, 'posted', ?, ?
       )`,
      [
        context.organizationId,
        refundNumber,
        idempotencyKey,
        allocation.allocation_id,
        context.branchId,
        amount.value,
        allocation.currency_code,
        refundMethod,
        refundReference,
        reason,
        notes,
        context.userId,
      ]
    );

    const refundId = Number(insertResult.insertId);

    const invoiceBalance = await getInvoiceBalance(
      connection,
      context.organizationId,
      context.invoiceId
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
        action: 'MEMBER_MEMBERSHIP_REFUND_POSTED',
        entityType: 'member_membership_refund',
        entityId: refundId,
        description:
          `Posted refund ${refundNumber} against payment ` +
          `${allocation.payment_number}; invoice ${invoice.invoice_number}; ` +
          `amount ${allocation.currency_code} ${amount.value}.`,
        oldValues: {
          record_exists: false,
          refundable_amount: refundable.refundable_amount,
          invoice_balance_due: invoice.total_amount,
        },
        newValues: {
          record_exists: true,
          refund_number: refundNumber,
          payment_id: context.paymentId,
          payment_number: allocation.payment_number,
          invoice_id: context.invoiceId,
          invoice_number: invoice.invoice_number,
          refund_amount: amount.value,
          currency_code: allocation.currency_code,
          refund_method: refundMethod,
          status: 'posted',
          refundable_amount_after_refund: centsToDecimal(
            refundable.remainingCents - amount.cents
          ),
          invoice_balance_due: invoiceBalance.balance_due,
          invoice_payment_status: invoiceBalance.payment_status,
        },
        metadata: buildMemberAuditMetadata(
          payer,
          {
            member_membership_billing: {
              refund_id: refundId,
              refund_number: refundNumber,
              payment_id: context.paymentId,
              payment_number: allocation.payment_number,
              invoice_id: context.invoiceId,
              invoice_number: invoice.invoice_number,
              membership_id: context.membershipId,
              allocation_id: Number(allocation.allocation_id),
              action_branch_id: context.branchId,
            },
          }
        ),
      }
    );

    const refund = await getRefundRecord(
      connection,
      context.organizationId,
      refundId,
      context.invoiceId
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Payment refund recorded successfully.',
      idempotent_replay: false,
      refund,
      invoice_balance: invoiceBalance,
      refundable_balance: {
        allocated_amount: refundable.allocated_amount,
        refunded_amount: centsToDecimal(
          decimalToCents(refundable.refunded_amount) + amount.cents
        ),
        refundable_amount: centsToDecimal(
          refundable.remainingCents - amount.cents
        ),
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Refund creation rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_REFUND_CREATE_FAILED',
      'Unable to record payment refund.'
    );
  } finally {
    if (connection) connection.release();
  }
};

// --------------------------------------------------
// POST .../payments/:paymentId/refunds/:refundId/void
// --------------------------------------------------

const voidMemberPaymentRefund = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureObjectBody(body);
    ensureAllowedFields(body, new Set(['reason']));

    const reason = requireReason(body.reason);
    const refundId = parsePositiveId(req.params.refundId);

    if (!refundId) {
      throw new RefundError(
        400,
        'INVALID_REFUND_ID',
        'Refund ID is invalid.'
      );
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    await getMembership(connection, context);
    const invoice = await getInvoice(connection, context);

    const allocation = await getPaymentAllocation(
      connection,
      context
    );

    const [refundRows] = await connection.query(
      `SELECT
         r.id,
         r.refund_number,
         r.refund_amount,
         r.currency_code,
         r.refund_method,
         r.reason,
         r.status,
         a.payment_id,
         p.payment_number,
         p.payer_member_id,
         p.status AS payment_status

       FROM member_membership_refunds r

       INNER JOIN member_membership_payment_allocations a
         ON a.organization_id = r.organization_id
        AND a.id = r.payment_allocation_id

       INNER JOIN member_membership_payments p
         ON p.organization_id = a.organization_id
        AND p.id = a.payment_id

       WHERE r.organization_id = ?
         AND r.id = ?
         AND r.payment_allocation_id = ?
         AND a.invoice_id = ?
       LIMIT 1
       FOR UPDATE`,
      [
        context.organizationId,
        refundId,
        allocation.allocation_id,
        context.invoiceId,
      ]
    );

    if (!refundRows.length) {
      throw new RefundError(
        404,
        'MEMBERSHIP_REFUND_NOT_FOUND',
        'Refund was not found for this payment and invoice.'
      );
    }

    const refund = refundRows[0];

    if (refund.status !== 'posted') {
      throw new RefundError(
        409,
        'MEMBERSHIP_REFUND_NOT_POSTED',
        'Only a posted refund can be voided.'
      );
    }

    if (refund.payment_status !== 'posted') {
      throw new RefundError(
        409,
        'REFUND_PAYMENT_NOT_POSTED',
        'The original payment is not posted. Review the payment before voiding this refund.'
      );
    }

    const payer = await getRefundAuditMember(
      connection,
      context.organizationId,
      Number(refund.payer_member_id)
    );

    const [updateResult] = await connection.query(
      `UPDATE member_membership_refunds
       SET status = 'voided',
           voided_at = CURRENT_TIMESTAMP,
           voided_by_user_id = ?,
           void_reason = ?
       WHERE organization_id = ?
         AND id = ?
         AND payment_allocation_id = ?
         AND status = 'posted'`,
      [
        context.userId,
        reason,
        context.organizationId,
        refundId,
        allocation.allocation_id,
      ]
    );

    if (updateResult.affectedRows !== 1) {
      throw new RefundError(
        409,
        'MEMBERSHIP_REFUND_STATE_CHANGED',
        'Refund status changed. Refresh and try again.'
      );
    }

    const invoiceBalance = await getInvoiceBalance(
      connection,
      context.organizationId,
      context.invoiceId
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
        action: 'MEMBER_MEMBERSHIP_REFUND_VOIDED',
        entityType: 'member_membership_refund',
        entityId: refundId,
        description:
          `Voided refund ${refund.refund_number} against payment ` +
          `${refund.payment_number}; reason: ${reason}.`,
        oldValues: {
          status: 'posted',
          refund_amount: String(refund.refund_amount),
        },
        newValues: {
          status: 'voided',
          void_reason: reason,
          invoice_balance_due: invoiceBalance.balance_due,
          invoice_payment_status: invoiceBalance.payment_status,
        },
        metadata: buildMemberAuditMetadata(
          payer,
          {
            member_membership_billing: {
              refund_id: refundId,
              refund_number: refund.refund_number,
              payment_id: context.paymentId,
              payment_number: refund.payment_number,
              invoice_id: context.invoiceId,
              invoice_number: invoice.invoice_number,
              membership_id: context.membershipId,
              allocation_id: Number(allocation.allocation_id),
              action_branch_id: context.branchId,
            },
          }
        ),
      }
    );

    const refundResponse = await getRefundRecord(
      connection,
      context.organizationId,
      refundId,
      context.invoiceId
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Payment refund voided successfully.',
      refund: refundResponse,
      invoice_balance: invoiceBalance,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Refund void rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_REFUND_VOID_FAILED',
      'Unable to void payment refund.'
    );
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  listMemberPaymentRefunds,
  createMemberPaymentRefund,
  voidMemberPaymentRefund,
};

