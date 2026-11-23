'use strict';

const db = require('../config/db');

const {
  writeAuditLog,
  buildMemberAuditMetadata,
} = require('../services/gymAuditService');

const PAYMENT_METHODS = new Set([
  'cash',
  'card',
  'bank_transfer',
  'cheque',
  'mobile_wallet',
  'online',
  'other',
]);

class ProgramBillingError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const positiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const getContext = (req) => {
  const context = {
    memberId: positiveId(req.params.memberId),
    assignmentId: positiveId(req.params.assignmentId),
    paymentId: req.params.paymentId == null
      ? null
      : positiveId(req.params.paymentId),
    organizationId: positiveId(req.gymStaff?.organizationId),
    branchId: positiveId(req.gymStaff?.branchId),
    userId: positiveId(req.gymStaff?.userId),
  };

  if (
    !context.memberId ||
    !context.assignmentId ||
    !context.organizationId ||
    !context.branchId ||
    !context.userId ||
    (req.params.paymentId != null && !context.paymentId)
  ) {
    throw new ProgramBillingError(
      401,
      'PROGRAM_BILLING_SESSION_REQUIRED',
      'A valid Gym Staff session and assignment are required.'
    );
  }

  return context;
};

const ensureObjectBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProgramBillingError(
      400,
      'INVALID_PROGRAM_PAYMENT_REQUEST',
      'Request body must be a valid object.'
    );
  }
};

const ensureAllowedFields = (body, allowed) => {
  const unexpected = Object.keys(body).filter((key) => !allowed.has(key));

  if (unexpected.length) {
    throw new ProgramBillingError(
      400,
      'UNSUPPORTED_PROGRAM_PAYMENT_FIELDS',
      `Unsupported fields: ${unexpected.join(', ')}`
    );
  }
};

const parseMoney = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ProgramBillingError(
      400,
      'INVALID_PROGRAM_PAYMENT_AMOUNT',
      'Payment amount must be positive and have up to two decimal places.'
    );
  }

  const raw = String(value).trim();

  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) {
    throw new ProgramBillingError(
      400,
      'INVALID_PROGRAM_PAYMENT_AMOUNT',
      'Payment amount must be positive and have up to two decimal places.'
    );
  }

  const [whole, fraction = ''] = raw.split('.');
  const cents =
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, '0'));

  if (cents <= 0n || cents > 999999999999n) {
    throw new ProgramBillingError(
      400,
      'INVALID_PROGRAM_PAYMENT_AMOUNT',
      'Payment amount is outside the supported range.'
    );
  }

  return {
    cents,
    value: `${BigInt(whole).toString()}.${fraction.padEnd(2, '0')}`,
  };
};

const decimalToCents = (value) => {
  const raw = String(value);

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`Invalid program billing decimal: ${raw}`);
  }

  const [whole, fraction = ''] = raw.split('.');

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};

const centsToDecimal = (cents) => {
  const absolute = cents < 0n ? -cents : cents;
  const value =
    `${absolute / 100n}.` +
    String(absolute % 100n).padStart(2, '0');

  return cents < 0n ? `-${value}` : value;
};

const normalizeText = (value, field, maximum) => {
  if (value == null || value === '') return null;

  if (typeof value !== 'string' || value.trim().length > maximum) {
    throw new ProgramBillingError(
      400,
      `INVALID_${field.toUpperCase()}`,
      `${field} must be text with a maximum length of ${maximum}.`
    );
  }

  return value.trim() || null;
};

const parseIdempotencyKey = (value) => {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())
  ) {
    throw new ProgramBillingError(
      400,
      'INVALID_PROGRAM_PAYMENT_IDEMPOTENCY_KEY',
      'A valid UUID idempotency_key is required.'
    );
  }

  return value.trim().toLowerCase();
};

const ensureAssignment = async (
  connection,
  context,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `SELECT
       mpa.id AS assignment_id,
       mpa.organization_id,
       mpa.member_id,
       mpa.membership_plan_id,
       mpa.program_code_snapshot,
       mpa.program_name_snapshot,
       mpa.fee_snapshot,
       mpa.currency_code_snapshot,
       mpa.price_configured_snapshot,
       mpa.status AS assignment_status,

       member.member_code,
       member.full_name,
       member.registration_branch_id,
       registration_branch.name AS registration_branch_name,
       registration_branch.branch_code AS registration_branch_code

     FROM member_program_assignments mpa

     INNER JOIN members member
       ON member.organization_id = mpa.organization_id
      AND member.id = mpa.member_id

     LEFT JOIN branches registration_branch
       ON registration_branch.organization_id = member.organization_id
      AND registration_branch.id = member.registration_branch_id

     WHERE mpa.organization_id = ?
       AND mpa.member_id = ?
       AND mpa.id = ?

     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [
      context.organizationId,
      context.memberId,
      context.assignmentId,
    ]
  );

  if (!rows.length) {
    throw new ProgramBillingError(
      404,
      'PROGRAM_ASSIGNMENT_NOT_FOUND',
      'Program assignment was not found for this member.'
    );
  }

  return rows[0];
};

const loadProgramInvoice = async (
  connection,
  context,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `SELECT
       i.id,
       i.organization_id,
       i.assignment_id,
       i.member_id,
       i.branch_id,
       i.invoice_number,
       i.program_code_snapshot,
       i.program_name_snapshot,
       i.member_code_snapshot,
       i.member_name_snapshot,

       DATE_FORMAT(i.invoice_date, '%Y-%m-%d') AS invoice_date,
       DATE_FORMAT(i.due_date, '%Y-%m-%d') AS due_date,

       i.total_amount,
       i.currency_code,
       i.status,
       i.notes,

       COALESCE(
         (
           SELECT SUM(p.amount)
           FROM member_program_payments p
           WHERE p.organization_id = i.organization_id
             AND p.invoice_id = i.id
             AND p.status = 'posted'
         ),
         0.00
       ) AS net_paid

     FROM member_program_invoices i

     WHERE i.organization_id = ?
       AND i.assignment_id = ?
       AND i.member_id = ?

     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [
      context.organizationId,
      context.assignmentId,
      context.memberId,
    ]
  );

  if (!rows.length) {
    throw new ProgramBillingError(
      404,
      'PROGRAM_INVOICE_NOT_FOUND',
      'No program invoice exists for this assignment. Check whether the program fee was configured when it was assigned.'
    );
  }

  return rows[0];
};

const serializeInvoice = (row) => {
  const total = decimalToCents(row.total_amount);
  const paid = decimalToCents(row.net_paid);

  const rawBalance = total - paid;
  const balance = rawBalance > 0n ? rawBalance : 0n;

  let paymentStatus = 'unpaid';

  if (row.status === 'void') {
    paymentStatus = 'void';
  } else if (balance === 0n) {
    paymentStatus = 'paid';
  } else if (paid > 0n) {
    paymentStatus = 'partially_paid';
  }

  return {
    id: Number(row.id),
    organization_id: Number(row.organization_id),
    assignment_id: Number(row.assignment_id),
    member_id: Number(row.member_id),
    branch_id: Number(row.branch_id),

    invoice_number: row.invoice_number,
    program_code: row.program_code_snapshot,
    program_name: row.program_name_snapshot,
    member_code: row.member_code_snapshot,
    member_name: row.member_name_snapshot,

    invoice_date: row.invoice_date,
    due_date: row.due_date,

    total_amount: centsToDecimal(total),
    currency_code: row.currency_code,
    net_paid: centsToDecimal(paid),
    outstanding: row.status === 'issued'
      ? centsToDecimal(balance)
      : '0.00',

    payment_status: paymentStatus,
    status: row.status,
    notes: row.notes,
  };
};

const getPaymentRecord = async (
  connection,
  context,
  paymentId
) => {
  const [rows] = await connection.query(
    `SELECT
       id,
       organization_id,
       invoice_id,
       payer_member_id,
       branch_id,
       payment_number,
       DATE_FORMAT(payment_date, '%Y-%m-%d %H:%i:%s') AS payment_date,
       amount,
       currency_code,
       payment_method,
       payment_reference,
       status,
       voided_at,
       void_reason,
       notes,
       received_by_user_id

     FROM member_program_payments

     WHERE organization_id = ?
       AND invoice_id = ?
       AND id = ?

     LIMIT 1`,
    [
      context.organizationId,
      context.invoiceId,
      paymentId,
    ]
  );

  if (!rows.length) {
    throw new Error('Program payment receipt could not be loaded.');
  }

  const row = rows[0];

  return {
    id: Number(row.id),
    organization_id: Number(row.organization_id),
    invoice_id: Number(row.invoice_id),
    payer_member_id: Number(row.payer_member_id),
    branch_id: Number(row.branch_id),
    payment_number: row.payment_number,
    payment_date: row.payment_date,
    amount: String(row.amount),
    currency_code: row.currency_code,
    payment_method: row.payment_method,
    payment_reference: row.payment_reference,
    status: row.status,
    voided_at: row.voided_at,
    void_reason: row.void_reason,
    notes: row.notes,
    received_by_user_id: Number(row.received_by_user_id),
  };
};

const nextPaymentNumber = async (connection, organizationId) => {
  const [yearRows] = await connection.query(
    'SELECT YEAR(CURRENT_DATE()) AS document_year'
  );

  const year = Number(yearRows[0]?.document_year);

  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error('Unable to determine program payment numbering year.');
  }

  await connection.query(
    `INSERT INTO member_program_billing_sequences
      (organization_id, document_year, sequence_value)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE
       sequence_value = sequence_value + 1`,
    [organizationId, year]
  );

  const [rows] = await connection.query(
    `SELECT sequence_value
     FROM member_program_billing_sequences
     WHERE organization_id = ?
       AND document_year = ?
     LIMIT 1
     FOR UPDATE`,
    [organizationId, year]
  );

  if (!rows.length) {
    throw new Error('Unable to reserve a program payment number.');
  }

  return `PGP-${year}-${String(rows[0].sequence_value).padStart(6, '0')}`;
};

const getErrorResponse = (
  res,
  error,
  fallbackCode,
  fallbackMessage
) => {
  if (error instanceof ProgramBillingError) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      code: 'PROGRAM_PAYMENT_IDEMPOTENCY_CONFLICT',
      message:
        'This payment request key has already been used. Use a new key for a new payment.',
    });
  }

  if (
    error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' ||
    error.errno === 3819
  ) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_PROGRAM_PAYMENT',
      message: 'Program payment values do not satisfy database rules.',
    });
  }

  console.error(`${fallbackCode}:`, error.code || '', error.message);

  return res.status(500).json({
    success: false,
    code: fallbackCode,
    message: fallbackMessage,
  });
};

// GET /api/members/:memberId/programs/:assignmentId/invoice
const getProgramInvoice = async (req, res) => {
  try {
    const context = getContext(req);

    await ensureAssignment(db, context);

    const row = await loadProgramInvoice(db, context);

    return res.json({
      success: true,
      invoice: serializeInvoice(row),
    });
  } catch (error) {
    return getErrorResponse(
      res,
      error,
      'PROGRAM_INVOICE_LOAD_FAILED',
      'Unable to load the program invoice.'
    );
  }
};

// GET .../:assignmentId/invoice/payments
const listProgramInvoicePayments = async (req, res) => {
  try {
    const context = getContext(req);

    await ensureAssignment(db, context);

    const invoiceRow = await loadProgramInvoice(db, context);

    const [rows] = await db.query(
      `SELECT
         id,
         invoice_id,
         payer_member_id,
         branch_id,
         payment_number,
         DATE_FORMAT(payment_date, '%Y-%m-%d %H:%i:%s') AS payment_date,
         amount,
         currency_code,
         payment_method,
         payment_reference,
         status,
         voided_at,
         void_reason,
         notes,
         received_by_user_id

       FROM member_program_payments

       WHERE organization_id = ?
         AND invoice_id = ?

       ORDER BY payment_date DESC, id DESC`,
      [context.organizationId, context.assignmentId ? invoiceRow.id : 0]
    );

    return res.json({
      success: true,
      invoice: serializeInvoice(invoiceRow),
      payments: rows.map((row) => ({
        id: Number(row.id),
        invoice_id: Number(row.invoice_id),
        payer_member_id: Number(row.payer_member_id),
        branch_id: Number(row.branch_id),
        payment_number: row.payment_number,
        payment_date: row.payment_date,
        amount: String(row.amount),
        currency_code: row.currency_code,
        payment_method: row.payment_method,
        payment_reference: row.payment_reference,
        status: row.status,
        voided_at: row.voided_at,
        void_reason: row.void_reason,
        notes: row.notes,
        received_by_user_id: Number(row.received_by_user_id),
      })),
    });
  } catch (error) {
    return getErrorResponse(
      res,
      error,
      'PROGRAM_PAYMENT_LIST_FAILED',
      'Unable to load program payment history.'
    );
  }
};

// POST .../:assignmentId/invoice/payments
const receiveProgramInvoicePayment = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureObjectBody(body);
    ensureAllowedFields(
      body,
      new Set([
        'amount',
        'payment_method',
        'payment_reference',
        'notes',
        'idempotency_key',
      ])
    );

    const amount = parseMoney(body.amount);

    if (
      typeof body.payment_method !== 'string' ||
      !PAYMENT_METHODS.has(body.payment_method.trim().toLowerCase())
    ) {
      throw new ProgramBillingError(
        400,
        'INVALID_PROGRAM_PAYMENT_METHOD',
        'Select a valid payment method.'
      );
    }

    const paymentMethod = body.payment_method.trim().toLowerCase();
    const paymentReference = normalizeText(
      body.payment_reference,
      'payment_reference',
      120
    );
    const notes = normalizeText(body.notes, 'notes', 500);
    const idempotencyKey = parseIdempotencyKey(body.idempotency_key);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    // Lock the assignment and invoice so concurrent installment
    // payments cannot over-collect the same outstanding balance.
    const assignment = await ensureAssignment(connection, context, true);
    const invoiceRow = await loadProgramInvoice(connection, context, true);

    const [existingRows] = await connection.query(
      `SELECT
         id,
         invoice_id,
         payer_member_id,
         amount,
         currency_code,
         payment_method,
         payment_reference,
         notes,
         status

       FROM member_program_payments

       WHERE organization_id = ?
         AND idempotency_key = ?

       LIMIT 1
       FOR UPDATE`,
      [context.organizationId, idempotencyKey]
    );

    if (existingRows.length) {
      const existing = existingRows[0];

      const sameRequest =
        Number(existing.invoice_id) === Number(invoiceRow.id) &&
        Number(existing.payer_member_id) === context.memberId &&
        decimalToCents(existing.amount) === amount.cents &&
        existing.currency_code === invoiceRow.currency_code &&
        existing.payment_method === paymentMethod &&
        (existing.payment_reference || null) === paymentReference &&
        (existing.notes || null) === notes;

      if (!sameRequest || existing.status !== 'posted') {
        throw new ProgramBillingError(
          409,
          'PROGRAM_PAYMENT_IDEMPOTENCY_KEY_REUSED',
          'This idempotency key belongs to a different or voided payment.'
        );
      }

      context.invoiceId = Number(invoiceRow.id);

      const receipt = await getPaymentRecord(
        connection,
        context,
        Number(existing.id)
      );

      const updatedInvoice = await loadProgramInvoice(
        connection,
        context
      );

      await connection.commit();
      transactionStarted = false;

      return res.status(200).json({
        success: true,
        message: 'This program payment was already processed.',
        idempotent_replay: true,
        payment: receipt,
        invoice: serializeInvoice(updatedInvoice),
      });
    }

    if (invoiceRow.status !== 'issued') {
      throw new ProgramBillingError(
        409,
        'PROGRAM_INVOICE_NOT_PAYABLE',
        'Only issued program invoices can receive payments.'
      );
    }

    const invoice = serializeInvoice(invoiceRow);
    const balanceCents = decimalToCents(invoice.outstanding);

    if (balanceCents <= 0n) {
      throw new ProgramBillingError(
        409,
        'PROGRAM_INVOICE_ALREADY_PAID',
        'This program invoice has no outstanding balance.'
      );
    }

    if (amount.cents > balanceCents) {
      throw new ProgramBillingError(
        409,
        'PROGRAM_PAYMENT_EXCEEDS_BALANCE',
        `Payment exceeds the outstanding balance of ${invoice.currency_code} ${invoice.outstanding}.`
      );
    }

    const paymentNumber = await nextPaymentNumber(
      connection,
      context.organizationId
    );

    const [insertResult] = await connection.query(
      `INSERT INTO member_program_payments
        (
          organization_id,
          invoice_id,
          payer_member_id,
          branch_id,
          payment_number,
          idempotency_key,
          payment_date,
          amount,
          currency_code,
          payment_method,
          payment_reference,
          status,
          notes,
          received_by_user_id
        )
       VALUES
        (
          ?, ?, ?, ?, ?, ?,
          CURRENT_TIMESTAMP,
          ?, ?, ?, ?, 'posted', ?, ?
        )`,
      [
        context.organizationId,
        invoiceRow.id,
        context.memberId,
        context.branchId,
        paymentNumber,
        idempotencyKey,
        amount.value,
        invoice.currency_code,
        paymentMethod,
        paymentReference,
        notes,
        context.userId,
      ]
    );

    const paymentId = Number(insertResult.insertId);
    context.invoiceId = Number(invoiceRow.id);

    await writeAuditLog(connection, req, context, {
      action: 'MEMBER_PROGRAM_PAYMENT_RECEIVED',
      entityType: 'member_program_payment',
      entityId: paymentId,
      description:
        `Received program payment ${paymentNumber} for assignment ` +
        `${context.assignmentId}; member ${assignment.member_code}; ` +
        `amount ${invoice.currency_code} ${amount.value}.`,
      oldValues: {
        payment_exists: false,
        outstanding: invoice.outstanding,
      },
      newValues: {
        payment_exists: true,
        payment_number: paymentNumber,
        assignment_id: context.assignmentId,
        invoice_id: Number(invoiceRow.id),
        payer_member_id: context.memberId,
        amount: amount.value,
        currency_code: invoice.currency_code,
        payment_method: paymentMethod,
        payment_status: 'posted',
        outstanding_after: centsToDecimal(balanceCents - amount.cents),
      },
      metadata: buildMemberAuditMetadata(assignment, {
        member_program_billing: {
          assignment_id: context.assignmentId,
          invoice_id: Number(invoiceRow.id),
          payment_id: paymentId,
          payment_number: paymentNumber,
          receipt_amount: amount.value,
          currency_code: invoice.currency_code,
          action_branch_id: context.branchId,
        },
      }),
    });

    const receipt = await getPaymentRecord(
      connection,
      context,
      paymentId
    );

    const updatedInvoice = await loadProgramInvoice(
      connection,
      context
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Program installment payment received successfully.',
      idempotent_replay: false,
      payment: receipt,
      invoice: serializeInvoice(updatedInvoice),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Program payment rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'PROGRAM_PAYMENT_RECEIVE_FAILED',
      'Unable to receive program payment.'
    );
  } finally {
    if (connection) connection.release();
  }
};

// POST .../:assignmentId/invoice/payments/:paymentId/void
const voidProgramInvoicePayment = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureObjectBody(body);
    ensureAllowedFields(body, new Set(['reason']));

    if (
      typeof body.reason !== 'string' ||
      !body.reason.trim() ||
      body.reason.trim().length > 500
    ) {
      throw new ProgramBillingError(
        400,
        'INVALID_PROGRAM_PAYMENT_VOID_REASON',
        'A void reason is required (maximum 500 characters).'
      );
    }

    const reason = body.reason.trim();

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const assignment = await ensureAssignment(connection, context, true);
    const invoiceRow = await loadProgramInvoice(connection, context, true);

    const [paymentRows] = await connection.query(
      `SELECT
         id,
         payment_number,
         amount,
         currency_code,
         payment_method,
         status
       FROM member_program_payments
       WHERE organization_id = ?
         AND invoice_id = ?
         AND id = ?
       LIMIT 1
       FOR UPDATE`,
      [
        context.organizationId,
        invoiceRow.id,
        context.paymentId,
      ]
    );

    if (!paymentRows.length) {
      throw new ProgramBillingError(
        404,
        'PROGRAM_PAYMENT_NOT_FOUND',
        'Program payment was not found.'
      );
    }

    const payment = paymentRows[0];

    if (payment.status !== 'posted') {
      throw new ProgramBillingError(
        409,
        'PROGRAM_PAYMENT_NOT_VOIDABLE',
        'Only posted program payments can be voided.'
      );
    }

    await connection.query(
      `UPDATE member_program_payments
       SET status = 'voided',
           voided_at = CURRENT_TIMESTAMP,
           voided_by_user_id = ?,
           void_reason = ?
       WHERE organization_id = ?
         AND invoice_id = ?
         AND id = ?
         AND status = 'posted'`,
      [
        context.userId,
        reason,
        context.organizationId,
        invoiceRow.id,
        context.paymentId,
      ]
    );

    context.invoiceId = Number(invoiceRow.id);

    const updatedInvoice = await loadProgramInvoice(
      connection,
      context
    );

    await writeAuditLog(connection, req, context, {
      action: 'MEMBER_PROGRAM_PAYMENT_VOIDED',
      entityType: 'member_program_payment',
      entityId: context.paymentId,
      description:
        `Voided program payment ${payment.payment_number} for assignment ` +
        `${context.assignmentId}; reason: ${reason}.`,
      oldValues: {
        status: 'posted',
        amount: String(payment.amount),
        currency_code: payment.currency_code,
      },
      newValues: {
        status: 'voided',
        void_reason: reason,
        outstanding_after: serializeInvoice(updatedInvoice).outstanding,
      },
      metadata: buildMemberAuditMetadata(assignment, {
        member_program_billing: {
          assignment_id: context.assignmentId,
          invoice_id: Number(invoiceRow.id),
          payment_id: context.paymentId,
          payment_number: payment.payment_number,
          action_branch_id: context.branchId,
        },
      }),
    });

    const receipt = await getPaymentRecord(
      connection,
      context,
      context.paymentId
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Program payment voided successfully.',
      payment: receipt,
      invoice: serializeInvoice(updatedInvoice),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Program payment void rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'PROGRAM_PAYMENT_VOID_FAILED',
      'Unable to void program payment.'
    );
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getProgramInvoice,
  listProgramInvoicePayments,
  receiveProgramInvoicePayment,
  voidProgramInvoicePayment,
};