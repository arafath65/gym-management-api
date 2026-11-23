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

class PaymentError extends Error {
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
    organizationId: parsePositiveId(req.gymStaff?.organizationId),
    branchId: parsePositiveId(req.gymStaff?.branchId),
    userId: parsePositiveId(req.gymStaff?.userId),
  };

  if (
    !context.memberId ||
    !context.membershipId ||
    !context.invoiceId ||
    !context.organizationId ||
    !context.branchId ||
    !context.userId
  ) {
    throw new PaymentError(
      401,
      'MEMBERSHIP_PAYMENT_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const ensureObjectBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PaymentError(
      400,
      'INVALID_PAYMENT_REQUEST',
      'Request body must be a valid object.'
    );
  }
};

const ensureAllowedFields = (body, allowed) => {
  const unexpected = Object.keys(body).filter(
    (key) => !allowed.has(key)
  );

  if (unexpected.length) {
    throw new PaymentError(
      400,
      'UNSUPPORTED_PAYMENT_FIELDS',
      `Unsupported fields: ${unexpected.join(', ')}`
    );
  }
};

// DECIMAL(12,2): maximum 9,999,999,999.99.
const parseMoney = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new PaymentError(
      400,
      'INVALID_PAYMENT_AMOUNT',
      'Payment amount must be a positive amount with up to two decimal places.'
    );
  }

  const raw = String(value).trim();

  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) {
    throw new PaymentError(
      400,
      'INVALID_PAYMENT_AMOUNT',
      'Payment amount must be a positive amount with up to two decimal places.'
    );
  }

  const [whole, fraction = ''] = raw.split('.');
  const cents =
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, '0'));

  if (cents <= 0n || cents > 999999999999n) {
    throw new PaymentError(
      400,
      'INVALID_PAYMENT_AMOUNT',
      'Payment amount must be greater than zero and within the supported limit.'
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
    throw new Error(`Invalid database decimal value: ${raw}`);
  }

  const [whole, fraction = ''] = raw.split('.');

  return (
    BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, '0'))
  );
};

const centsToDecimal = (cents) => {
  const absolute = cents < 0n ? -cents : cents;
  const result =
    `${absolute / 100n}.` +
    String(absolute % 100n).padStart(2, '0');

  return cents < 0n ? `-${result}` : result;
};

const normalizeOptionalText = (value, field, maxLength) => {
  if (value == null || value === '') return null;

  if (
    typeof value !== 'string' ||
    value.trim().length > maxLength
  ) {
    throw new PaymentError(
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
    throw new PaymentError(
      400,
      'INVALID_PAYMENT_IDEMPOTENCY_KEY',
      'A valid UUID idempotency_key is required.'
    );
  }

  return value.trim().toLowerCase();
};

const getMembershipForPayment = async (
  connection,
  context,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `SELECT
       m.id,
       m.organization_id,
       m.primary_member_id
     FROM member_memberships m
     WHERE m.organization_id = ?
       AND m.id = ?
       AND EXISTS (
         SELECT 1
         FROM member_membership_members participant
         WHERE participant.organization_id = m.organization_id
           AND participant.membership_id = m.id
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
    throw new PaymentError(
      404,
      'MEMBER_MEMBERSHIP_NOT_FOUND',
      'Membership was not found for this member.'
    );
  }

  return rows[0];
};

const getInvoiceForPayment = async (
  connection,
  context,
  forUpdate = false
) => {
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
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [
      context.organizationId,
      context.membershipId,
      context.invoiceId,
    ]
  );

  if (!rows.length) {
    throw new PaymentError(
      404,
      'MEMBERSHIP_INVOICE_NOT_FOUND',
      'Invoice was not found for this membership.'
    );
  }

  return rows[0];
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
    throw new PaymentError(
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

    totalCents: total,
    allocatedCents: allocated,
    refundedCents: refunded,
    waivedCents: waived,
    balanceCents: balanceDue,
  };
};

const nextPaymentNumber = async (
  connection,
  organizationId
) => {
  const [yearRows] = await connection.query(
    'SELECT YEAR(CURRENT_DATE()) AS document_year'
  );

  const year = Number(yearRows[0]?.document_year);

  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error('Unable to determine payment numbering year.');
  }

  await connection.query(
    `INSERT INTO member_membership_billing_sequences
      (
        organization_id,
        document_type,
        document_year,
        sequence_value
      )
     VALUES (?, 'payment', ?, 1)
     ON DUPLICATE KEY UPDATE
       sequence_value = sequence_value + 1`,
    [organizationId, year]
  );

  const [rows] = await connection.query(
    `SELECT sequence_value
     FROM member_membership_billing_sequences
     WHERE organization_id = ?
       AND document_type = 'payment'
       AND document_year = ?
     LIMIT 1
     FOR UPDATE`,
    [organizationId, year]
  );

  if (!rows.length) {
    throw new Error('Unable to reserve payment receipt number.');
  }

  const sequence = String(rows[0].sequence_value);

  return `PAY-${year}-${sequence.padStart(6, '0')}`;
};

const getPaymentAuditMember = async (
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
    throw new PaymentError(
      404,
      'PAYMENT_PAYER_NOT_FOUND',
      'Payment payer was not found in this organization.'
    );
  }

  return rows[0];
};

const getExistingIdempotentPayment = async (
  connection,
  context,
  key
) => {
  const [rows] = await connection.query(
    `SELECT
       p.id,
       p.payment_number,
       p.payer_member_id,
       p.amount,
       p.currency_code,
       p.payment_method,
       p.payment_reference,
       p.notes,
       p.status,
       a.invoice_id,
       a.allocated_amount

     FROM member_membership_payments p

     LEFT JOIN member_membership_payment_allocations a
       ON a.organization_id = p.organization_id
      AND a.payment_id = p.id

     WHERE p.organization_id = ?
       AND p.idempotency_key = ?
     LIMIT 1
     FOR UPDATE`,
    [context.organizationId, key]
  );

  return rows[0] || null;
};

const getPaymentRecord = async (
  connection,
  organizationId,
  paymentId,
  invoiceId
) => {
  const [rows] = await connection.query(
    `SELECT
       p.id,
       p.organization_id,
       p.payment_number,
       p.payer_member_id,
       p.branch_id,
       DATE_FORMAT(p.payment_date, '%Y-%m-%d %H:%i:%s')
         AS payment_date,
       p.amount,
       p.currency_code,
       p.payment_method,
       p.payment_reference,
       p.status,
       p.notes,
       p.received_by_user_id,

       a.id AS allocation_id,
       a.invoice_id,
       a.allocated_amount

     FROM member_membership_payments p

     INNER JOIN member_membership_payment_allocations a
       ON a.organization_id = p.organization_id
      AND a.payment_id = p.id

     WHERE p.organization_id = ?
       AND p.id = ?
       AND a.invoice_id = ?
     LIMIT 1`,
    [organizationId, paymentId, invoiceId]
  );

  if (!rows.length) {
    throw new Error('Created payment receipt could not be loaded.');
  }

  const row = rows[0];

  return {
    id: Number(row.id),
    organization_id: Number(row.organization_id),
    payment_number: row.payment_number,
    payer_member_id: Number(row.payer_member_id),
    branch_id: Number(row.branch_id),
    payment_date: row.payment_date,
    amount: String(row.amount),
    currency_code: row.currency_code,
    payment_method: row.payment_method,
    payment_reference: row.payment_reference,
    status: row.status,
    notes: row.notes,
    received_by_user_id: Number(row.received_by_user_id),

    allocation: {
      id: Number(row.allocation_id),
      invoice_id: Number(row.invoice_id),
      allocated_amount: String(row.allocated_amount),
    },
  };
};

const getErrorResponse = (res, error, fallbackCode, fallbackMessage) => {
  if (error instanceof PaymentError) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      code: 'PAYMENT_IDEMPOTENCY_CONFLICT',
      message:
        'This payment request key has already been used. ' +
        'Use the original key only for an exact retry of the same request.',
    });
  }

  if (
    error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' ||
    error.errno === 3819
  ) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_MEMBERSHIP_PAYMENT',
      message: 'Payment values do not satisfy the database rules.',
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
// GET .../invoices/:invoiceId/payments
// --------------------------------------------------

const listMemberInvoicePayments = async (req, res) => {
  try {
    const context = getContext(req);

    await getMembershipForPayment(db, context);

    await getInvoiceForPayment(db, context);

    const [rows] = await db.query(
      `SELECT
         p.id,
         p.payment_number,
         p.payer_member_id,
         p.branch_id,
         DATE_FORMAT(p.payment_date, '%Y-%m-%d %H:%i:%s')
           AS payment_date,
         p.amount,
         p.currency_code,
         p.payment_method,
         p.payment_reference,
         p.status,
         p.notes,

         a.id AS allocation_id,
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

       INNER JOIN member_membership_payments p
         ON p.organization_id = a.organization_id
        AND p.id = a.payment_id

       WHERE a.organization_id = ?
         AND a.invoice_id = ?

       ORDER BY p.payment_date DESC, p.id DESC`,
      [context.organizationId, context.invoiceId]
    );

    const balance = await getInvoiceBalance(
      db,
      context.organizationId,
      context.invoiceId
    );

    return res.json({
      success: true,
      invoice_id: context.invoiceId,

      payments: rows.map((row) => ({
        id: Number(row.id),
        payment_number: row.payment_number,
        payer_member_id: Number(row.payer_member_id),
        branch_id: Number(row.branch_id),
        payment_date: row.payment_date,
        amount: String(row.amount),
        currency_code: row.currency_code,
        payment_method: row.payment_method,
        payment_reference: row.payment_reference,
        status: row.status,
        notes: row.notes,

        allocation: {
          id: Number(row.allocation_id),
          allocated_amount: String(row.allocated_amount),
          refunded_amount: String(row.refunded_amount),
        },
      })),

      invoice_balance: {
        total_amount: balance.total_amount,
        allocated_amount: balance.allocated_amount,
        refunded_amount: balance.refunded_amount,
        net_paid: balance.net_paid,
        balance_due: balance.balance_due,
        payment_status: balance.payment_status,
      },
    });
  } catch (error) {
    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_PAYMENT_LIST_FAILED',
      'Unable to load invoice payment history.'
    );
  }
};

// --------------------------------------------------
// POST .../invoices/:invoiceId/payments
// --------------------------------------------------

const receiveMemberInvoicePayment = async (req, res) => {
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
      throw new PaymentError(
        400,
        'INVALID_PAYMENT_METHOD',
        'Select a valid payment method.'
      );
    }

    const paymentMethod = body.payment_method.trim().toLowerCase();

    const paymentReference = normalizeOptionalText(
      body.payment_reference,
      'payment_reference',
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

    // Lock the membership first. This also confirms that the
    // requested member belongs to the membership.
    const membership = await getMembershipForPayment(
      connection,
      context,
      true
    );

    // Lock the invoice to serialize concurrent payments against
    // its outstanding balance.
    const invoice = await getInvoiceForPayment(
      connection,
      context,
      true
    );

    if (
      Number(invoice.primary_member_id) !==
      Number(membership.primary_member_id)
    ) {
      throw new PaymentError(
        409,
        'INVOICE_MEMBERSHIP_MISMATCH',
        'Invoice does not belong to this membership primary member.'
      );
    }

    // Check for an exact retry before reserving another receipt number.
    const existing = await getExistingIdempotentPayment(
      connection,
      context,
      idempotencyKey
    );

    if (existing) {
      const sameRequest =
        existing.invoice_id != null &&
        Number(existing.invoice_id) === context.invoiceId &&
        Number(existing.payer_member_id) === context.memberId &&
        decimalToCents(existing.amount) === amount.cents &&
        decimalToCents(existing.allocated_amount) === amount.cents &&
        existing.currency_code === invoice.currency_code &&
        existing.payment_method === paymentMethod &&
        (existing.payment_reference || null) === paymentReference &&
        (existing.notes || null) === notes;

      if (!sameRequest || existing.status !== 'posted') {
        throw new PaymentError(
          409,
          'PAYMENT_IDEMPOTENCY_KEY_REUSED',
          'This idempotency key belongs to a different or non-posted payment.'
        );
      }

      const payment = await getPaymentRecord(
        connection,
        context.organizationId,
        Number(existing.id),
        context.invoiceId
      );

      const balance = await getInvoiceBalance(
        connection,
        context.organizationId,
        context.invoiceId
      );

      await connection.commit();
      transactionStarted = false;

      return res.status(200).json({
        success: true,
        message: 'This payment was already processed.',
        idempotent_replay: true,
        payment,
        invoice_balance: {
          total_amount: balance.total_amount,
          allocated_amount: balance.allocated_amount,
          refunded_amount: balance.refunded_amount,
          net_paid: balance.net_paid,
          balance_due: balance.balance_due,
          payment_status: balance.payment_status,
        },
      });
    }

    if (invoice.status !== 'issued') {
      throw new PaymentError(
        409,
        'MEMBERSHIP_INVOICE_NOT_PAYABLE',
        'Only issued invoices can receive payments.'
      );
    }

    const balance = await getInvoiceBalance(
      connection,
      context.organizationId,
      context.invoiceId
    );

    if (balance.balanceCents <= 0n) {
      throw new PaymentError(
        409,
        'MEMBERSHIP_INVOICE_ALREADY_PAID',
        'This invoice has no outstanding balance.'
      );
    }

    if (amount.cents > balance.balanceCents) {
      throw new PaymentError(
        409,
        'PAYMENT_EXCEEDS_INVOICE_BALANCE',
        `Payment exceeds the outstanding balance of ${invoice.currency_code} ${balance.balance_due}.`
      );
    }

    const payer = await getPaymentAuditMember(
      connection,
      context.organizationId,
      context.memberId
    );

    const paymentNumber = await nextPaymentNumber(
      connection,
      context.organizationId
    );

    const [paymentInsert] = await connection.query(
      `INSERT INTO member_membership_payments
       (
         organization_id,
         payment_number,
         idempotency_key,
         payer_member_id,
         branch_id,
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
         ?, ?, ?, ?, ?,
         CURRENT_TIMESTAMP,
         ?, ?, ?, ?, 'posted', ?, ?
       )`,
      [
        context.organizationId,
        paymentNumber,
        idempotencyKey,
        context.memberId,
        context.branchId,
        amount.value,
        invoice.currency_code,
        paymentMethod,
        paymentReference,
        notes,
        context.userId,
      ]
    );

    const paymentId = Number(paymentInsert.insertId);

    // One receipt is allocated to this invoice in this API version.
    await connection.query(
      `INSERT INTO member_membership_payment_allocations
       (
         organization_id,
         payment_id,
         invoice_id,
         allocated_amount,
         created_by_user_id
       )
       VALUES (?, ?, ?, ?, ?)`,
      [
        context.organizationId,
        paymentId,
        context.invoiceId,
        amount.value,
        context.userId,
      ]
    );

    const newBalance = await getInvoiceBalance(
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
        action: 'MEMBER_MEMBERSHIP_PAYMENT_RECEIVED',
        entityType: 'member_membership_payment',
        entityId: paymentId,
        description:
          `Received payment ${paymentNumber} for invoice ` +
          `${invoice.invoice_number}; payer ${payer.member_code}; ` +
          `amount ${invoice.currency_code} ${amount.value}.`,
        oldValues: {
          record_exists: false,
          invoice_balance_due: balance.balance_due,
        },
        newValues: {
          record_exists: true,
          payment_number: paymentNumber,
          invoice_id: context.invoiceId,
          invoice_number: invoice.invoice_number,
          allocated_amount: amount.value,
          currency_code: invoice.currency_code,
          payment_method: paymentMethod,
          payment_status: 'posted',
          invoice_balance_due: newBalance.balance_due,
          invoice_payment_status: newBalance.payment_status,
        },
        metadata: buildMemberAuditMetadata(
          payer,
          {
            member_membership_billing: {
              payment_id: paymentId,
              payment_number: paymentNumber,
              invoice_id: context.invoiceId,
              invoice_number: invoice.invoice_number,
              membership_id: context.membershipId,
              payer_member_id: context.memberId,
              allocation_amount: amount.value,
              action_branch_id: context.branchId,
            },
          }
        ),
      }
    );

    const payment = await getPaymentRecord(
      connection,
      context.organizationId,
      paymentId,
      context.invoiceId
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Payment received successfully.',
      idempotent_replay: false,
      payment,
      invoice_balance: {
        total_amount: newBalance.total_amount,
        allocated_amount: newBalance.allocated_amount,
        refunded_amount: newBalance.refunded_amount,
        net_paid: newBalance.net_paid,
        balance_due: newBalance.balance_due,
        payment_status: newBalance.payment_status,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Payment transaction rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_PAYMENT_RECEIVE_FAILED',
      'Unable to receive membership payment.'
    );
  } finally {
    if (connection) connection.release();
  }
};


// --------------------------------------------------
// POST .../invoices/:invoiceId/payments/:paymentId/void
// --------------------------------------------------

const voidMemberInvoicePayment = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureObjectBody(body);
    ensureAllowedFields(body, new Set(['reason']));

    const reason = normalizeOptionalText(
      body.reason,
      'reason',
      500
    );

    if (!reason) {
      throw new PaymentError(
        400,
        'PAYMENT_VOID_REASON_REQUIRED',
        'A reason is required to void a payment.'
      );
    }

    const paymentId = parsePositiveId(req.params.paymentId);

    if (!paymentId) {
      throw new PaymentError(
        400,
        'INVALID_PAYMENT_ID',
        'Payment ID is invalid.'
      );
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    await getMembershipForPayment(
      connection,
      context,
      true
    );

    const invoice = await getInvoiceForPayment(
      connection,
      context,
      true
    );

    const [paymentRows] = await connection.query(
      `SELECT
         p.id,
         p.organization_id,
         p.payment_number,
         p.payer_member_id,
         p.amount,
         p.currency_code,
         p.payment_method,
         p.payment_reference,
         p.notes,
         p.status,
         a.invoice_id

       FROM member_membership_payments p

       INNER JOIN member_membership_payment_allocations a
         ON a.organization_id = p.organization_id
        AND a.payment_id = p.id

       WHERE p.organization_id = ?
         AND p.id = ?
         AND a.invoice_id = ?
       LIMIT 1
       FOR UPDATE`,
      [
        context.organizationId,
        paymentId,
        context.invoiceId,
      ]
    );

    if (!paymentRows.length) {
      throw new PaymentError(
        404,
        'MEMBERSHIP_PAYMENT_NOT_FOUND',
        'Payment was not found for this invoice.'
      );
    }

    const payment = paymentRows[0];

    if (payment.status !== 'posted') {
      throw new PaymentError(
        409,
        'MEMBERSHIP_PAYMENT_NOT_POSTED',
        'Only a posted payment can be voided.'
      );
    }

    // A receipt may have allocations to multiple invoices.
    // Check every allocation before voiding the entire receipt.
    const [refundRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM member_membership_refunds r

       INNER JOIN member_membership_payment_allocations a
         ON a.organization_id = r.organization_id
        AND a.id = r.payment_allocation_id

       WHERE r.organization_id = ?
         AND a.payment_id = ?
         AND r.status = 'posted'`,
      [context.organizationId, paymentId]
    );

    if (Number(refundRows[0]?.total || 0) > 0) {
      throw new PaymentError(
        409,
        'MEMBERSHIP_PAYMENT_HAS_POSTED_REFUNDS',
        'This payment has posted refunds and cannot be voided. Review the refund records before proceeding.'
      );
    }

    const payer = await getPaymentAuditMember(
      connection,
      context.organizationId,
      Number(payment.payer_member_id)
    );

    const [updateResult] = await connection.query(
      `UPDATE member_membership_payments
       SET status = 'voided',
           voided_at = CURRENT_TIMESTAMP,
           voided_by_user_id = ?,
           void_reason = ?
       WHERE organization_id = ?
         AND id = ?
         AND status = 'posted'`,
      [
        context.userId,
        reason,
        context.organizationId,
        paymentId,
      ]
    );

    if (updateResult.affectedRows !== 1) {
      throw new PaymentError(
        409,
        'MEMBERSHIP_PAYMENT_STATE_CHANGED',
        'Payment status changed. Refresh and try again.'
      );
    }

    const balance = await getInvoiceBalance(
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
        action: 'MEMBER_MEMBERSHIP_PAYMENT_VOIDED',
        entityType: 'member_membership_payment',
        entityId: paymentId,
        description:
          `Voided payment ${payment.payment_number} for invoice ` +
          `${invoice.invoice_number}; reason: ${reason}.`,
        oldValues: {
          status: 'posted',
          amount: String(payment.amount),
          currency_code: payment.currency_code,
        },
        newValues: {
          status: 'voided',
          void_reason: reason,
          invoice_balance_due: balance.balance_due,
          invoice_payment_status: balance.payment_status,
        },
        metadata: buildMemberAuditMetadata(
          payer,
          {
            member_membership_billing: {
              payment_id: paymentId,
              payment_number: payment.payment_number,
              invoice_id: context.invoiceId,
              invoice_number: invoice.invoice_number,
              membership_id: context.membershipId,
              payer_member_id: Number(payment.payer_member_id),
              action_branch_id: context.branchId,
            },
          }
        ),
      }
    );

    const paymentResponse = await getPaymentRecord(
      connection,
      context.organizationId,
      paymentId,
      context.invoiceId
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Payment voided successfully.',
      payment: paymentResponse,
      invoice_balance: {
        total_amount: balance.total_amount,
        allocated_amount: balance.allocated_amount,
        refunded_amount: balance.refunded_amount,
        net_paid: balance.net_paid,
        balance_due: balance.balance_due,
        payment_status: balance.payment_status,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Payment void rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_PAYMENT_VOID_FAILED',
      'Unable to void membership payment.'
    );
  } finally {
    if (connection) connection.release();
  }
};


// --------------------------------------------------
// POST .../memberships/:membershipId/payments
// One receipt may be allocated FIFO across multiple unpaid invoices.
// --------------------------------------------------

const getMembershipPaymentContext = (req) => {
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
    throw new PaymentError(
      401,
      'MEMBERSHIP_PAYMENT_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const getMembershipPaymentReceipt = async (
  connection,
  organizationId,
  paymentId
) => {
  const [rows] = await connection.query(
    `SELECT
       p.id,
       p.organization_id,
       p.payment_number,
       p.payer_member_id,
       p.branch_id,
       DATE_FORMAT(p.payment_date, '%Y-%m-%d %H:%i:%s') AS payment_date,
       p.amount,
       p.currency_code,
       p.payment_method,
       p.payment_reference,
       p.status,
       p.notes,
       p.received_by_user_id,
       a.id AS allocation_id,
       a.invoice_id,
       i.membership_id,
       i.invoice_number,
       DATE_FORMAT(i.invoice_date, '%Y-%m-%d') AS invoice_date,
       a.allocated_amount
     FROM member_membership_payments p
     INNER JOIN member_membership_payment_allocations a
       ON a.organization_id = p.organization_id
      AND a.payment_id = p.id
     INNER JOIN member_membership_invoices i
       ON i.organization_id = a.organization_id
      AND i.id = a.invoice_id
     WHERE p.organization_id = ?
       AND p.id = ?
     ORDER BY i.invoice_date ASC, i.id ASC, a.id ASC`,
    [organizationId, paymentId]
  );

  if (!rows.length) {
    throw new Error('Created membership payment receipt could not be loaded.');
  }

  const first = rows[0];
  return {
    id: Number(first.id),
    organization_id: Number(first.organization_id),
    payment_number: first.payment_number,
    payer_member_id: Number(first.payer_member_id),
    branch_id: Number(first.branch_id),
    payment_date: first.payment_date,
    amount: String(first.amount),
    currency_code: first.currency_code,
    payment_method: first.payment_method,
    payment_reference: first.payment_reference,
    status: first.status,
    notes: first.notes,
    received_by_user_id: Number(first.received_by_user_id),
    allocations: rows.map((row) => ({
      id: Number(row.allocation_id),
      invoice_id: Number(row.invoice_id),
      membership_id: Number(row.membership_id),
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      allocated_amount: String(row.allocated_amount),
    })),
  };
};

const receiveMembershipPayment = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getMembershipPaymentContext(req);
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
      throw new PaymentError(
        400,
        'INVALID_PAYMENT_METHOD',
        'Select a valid payment method.'
      );
    }

    const paymentMethod = body.payment_method.trim().toLowerCase();
    const paymentReference = normalizeOptionalText(
      body.payment_reference,
      'payment_reference',
      120
    );
    const notes = normalizeOptionalText(body.notes, 'notes', 500);
    const idempotencyKey = normalizeIdempotencyKey(body.idempotency_key);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    // Serialize all payment writes for this membership. The existing
    // single-invoice payment endpoint takes the same membership lock.
    const membership = await getMembershipForPayment(
      connection,
      context,
      true
    );

    // An exact retry must return the original receipt and allocations,
    // even if newer billing periods have since been generated.
    const [existingRows] = await connection.query(
      `SELECT
         id,
         payment_number,
         payer_member_id,
         amount,
         currency_code,
         payment_method,
         payment_reference,
         notes,
         status
       FROM member_membership_payments
       WHERE organization_id = ?
         AND idempotency_key = ?
       LIMIT 1
       FOR UPDATE`,
      [context.organizationId, idempotencyKey]
    );

    if (existingRows.length) {
      const existing = existingRows[0];
      const receipt = await getMembershipPaymentReceipt(
        connection,
        context.organizationId,
        Number(existing.id)
      );
      const sameMembership = receipt.allocations.length > 0 &&
        receipt.allocations.every((allocation) =>
          allocation.membership_id === context.membershipId
        );
      const sameRequest =
        sameMembership &&
        Number(existing.payer_member_id) === context.memberId &&
        decimalToCents(existing.amount) === amount.cents &&
        existing.payment_method === paymentMethod &&
        (existing.payment_reference || null) === paymentReference &&
        (existing.notes || null) === notes;

      if (!sameRequest || existing.status !== 'posted') {
        throw new PaymentError(
          409,
          'PAYMENT_IDEMPOTENCY_KEY_REUSED',
          'This idempotency key belongs to a different or non-posted payment.'
        );
      }

      const invoiceBalances = [];
      for (const allocation of receipt.allocations) {
        const balance = await getInvoiceBalance(
          connection,
          context.organizationId,
          allocation.invoice_id
        );
        invoiceBalances.push({
          invoice_id: allocation.invoice_id,
          invoice_number: allocation.invoice_number,
          ...{
            total_amount: balance.total_amount,
            allocated_amount: balance.allocated_amount,
            refunded_amount: balance.refunded_amount,
            waived_amount: balance.waived_amount,
            net_paid: balance.net_paid,
            balance_due: balance.balance_due,
            payment_status: balance.payment_status,
          },
        });
      }

      await connection.commit();
      transactionStarted = false;
      return res.status(200).json({
        success: true,
        message: 'This payment was already processed.',
        idempotent_replay: true,
        payment: receipt,
        allocations: receipt.allocations,
        invoice_balances: invoiceBalances,
      });
    }

    // Lock every issued invoice in chronological order. Balances are
    // allocated oldest-first, including partially paid invoices.
    const [invoiceRows] = await connection.query(
      `SELECT
         id,
         membership_id,
         primary_member_id,
         invoice_number,
         invoice_date,
         due_date,
         currency_code,
         status
       FROM member_membership_invoices
       WHERE organization_id = ?
         AND membership_id = ?
         AND primary_member_id = ?
         AND status = 'issued'
       ORDER BY invoice_date ASC, id ASC
       FOR UPDATE`,
      [
        context.organizationId,
        context.membershipId,
        Number(membership.primary_member_id),
      ]
    );

    const outstandingInvoices = [];
    for (const invoice of invoiceRows) {
      const balance = await getInvoiceBalance(
        connection,
        context.organizationId,
        Number(invoice.id)
      );
      if (balance.balanceCents > 0n) {
        outstandingInvoices.push({ invoice, balance });
      }
    }

    if (!outstandingInvoices.length) {
      throw new PaymentError(
        409,
        'MEMBERSHIP_HAS_NO_OUTSTANDING_BALANCE',
        'This membership has no outstanding invoices to collect.'
      );
    }

    const currencyCode = outstandingInvoices[0].invoice.currency_code;
    if (outstandingInvoices.some(({ invoice }) =>
      invoice.currency_code !== currencyCode
    )) {
      throw new PaymentError(
        409,
        'MEMBERSHIP_HAS_MIXED_INVOICE_CURRENCIES',
        'This membership has outstanding invoices in different currencies. Collect them separately.'
      );
    }

    const totalOutstandingCents = outstandingInvoices.reduce(
      (total, item) => total + item.balance.balanceCents,
      0n
    );

    if (amount.cents > totalOutstandingCents) {
      throw new PaymentError(
        409,
        'PAYMENT_EXCEEDS_MEMBERSHIP_BALANCE',
        `Payment exceeds the total outstanding membership balance of ${currencyCode} ${centsToDecimal(totalOutstandingCents)}.`,
      );
    }

    const payer = await getPaymentAuditMember(
      connection,
      context.organizationId,
      context.memberId
    );
    const paymentNumber = await nextPaymentNumber(
      connection,
      context.organizationId
    );

    const [paymentInsert] = await connection.query(
      `INSERT INTO member_membership_payments
       (
         organization_id,
         payment_number,
         idempotency_key,
         payer_member_id,
         branch_id,
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
         ?, ?, ?, ?, ?,
         CURRENT_TIMESTAMP,
         ?, ?, ?, ?, 'posted', ?, ?
       )`,
      [
        context.organizationId,
        paymentNumber,
        idempotencyKey,
        context.memberId,
        context.branchId,
        amount.value,
        currencyCode,
        paymentMethod,
        paymentReference,
        notes,
        context.userId,
      ]
    );

    const paymentId = Number(paymentInsert.insertId);
    let remainingCents = amount.cents;
    const createdAllocations = [];
    const updatedInvoiceBalances = [];

    for (const item of outstandingInvoices) {
      if (remainingCents <= 0n) break;
      const allocatedCents = remainingCents < item.balance.balanceCents
        ? remainingCents
        : item.balance.balanceCents;
      const allocatedAmount = centsToDecimal(allocatedCents);

      await connection.query(
        `INSERT INTO member_membership_payment_allocations
         (
           organization_id,
           payment_id,
           invoice_id,
           allocated_amount,
           created_by_user_id
         )
         VALUES (?, ?, ?, ?, ?)`,
        [
          context.organizationId,
          paymentId,
          Number(item.invoice.id),
          allocatedAmount,
          context.userId,
        ]
      );

      remainingCents -= allocatedCents;
      const newBalance = await getInvoiceBalance(
        connection,
        context.organizationId,
        Number(item.invoice.id)
      );

      createdAllocations.push({
        invoice_id: Number(item.invoice.id),
        invoice_number: item.invoice.invoice_number,
        invoice_date: item.invoice.invoice_date,
        allocated_amount: allocatedAmount,
      });
      updatedInvoiceBalances.push({
        invoice_id: Number(item.invoice.id),
        invoice_number: item.invoice.invoice_number,
        total_amount: newBalance.total_amount,
        allocated_amount: newBalance.allocated_amount,
        refunded_amount: newBalance.refunded_amount,
        waived_amount: newBalance.waived_amount,
        net_paid: newBalance.net_paid,
        balance_due: newBalance.balance_due,
        payment_status: newBalance.payment_status,
      });
    }

    if (remainingCents !== 0n) {
      throw new Error('FIFO payment allocation did not consume the receipt amount.');
    }

    await writeAuditLog(
      connection,
      req,
      {
        organizationId: context.organizationId,
        branchId: context.branchId,
        userId: context.userId,
      },
      {
        action: 'MEMBER_MEMBERSHIP_PAYMENT_RECEIVED',
        entityType: 'member_membership_payment',
        entityId: paymentId,
        description:
          `Received membership payment ${paymentNumber}; payer ${payer.member_code}; ` +
          `amount ${currencyCode} ${amount.value}; allocated oldest-first across ` +
          `${createdAllocations.length} invoice(s).`,
        oldValues: {
          record_exists: false,
          total_outstanding: centsToDecimal(totalOutstandingCents),
        },
        newValues: {
          record_exists: true,
          payment_number: paymentNumber,
          membership_id: context.membershipId,
          payer_member_id: context.memberId,
          amount: amount.value,
          currency_code: currencyCode,
          payment_method: paymentMethod,
          payment_status: 'posted',
          allocations: createdAllocations,
          total_outstanding_after: centsToDecimal(
            totalOutstandingCents - amount.cents
          ),
        },
        metadata: buildMemberAuditMetadata(
          payer,
          {
            member_membership_billing: {
              payment_id: paymentId,
              payment_number: paymentNumber,
              membership_id: context.membershipId,
              payer_member_id: context.memberId,
              receipt_amount: amount.value,
              currency_code: currencyCode,
              allocations: createdAllocations,
              action_branch_id: context.branchId,
            },
          }
        ),
      }
    );

    const receipt = await getMembershipPaymentReceipt(
      connection,
      context.organizationId,
      paymentId
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Membership payment received and allocated oldest-first.',
      idempotent_replay: false,
      payment: receipt,
      allocations: receipt.allocations,
      invoice_balances: updatedInvoiceBalances,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Membership payment rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_PAYMENT_RECEIVE_FAILED',
      'Unable to receive membership payment.'
    );
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  listMemberInvoicePayments,
  receiveMemberInvoicePayment,
  receiveMembershipPayment,
  voidMemberInvoicePayment,
};

