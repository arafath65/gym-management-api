'use strict';

const db = require('../config/db');

const { writeAuditLog } = require('../services/gymAuditService');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_DECIMAL_CENTS = 999999999999n;

class WaiverError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
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
    waiverId: parsePositiveId(req.params.waiverId),

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
    throw new WaiverError(
      400,
      'INVALID_WAIVER_CONTEXT',
      'Valid member, membership, invoice and Gym Staff context are required.'
    );
  }

  return context;
};

const ensureObjectBody = (body) => {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    throw new WaiverError(
      400,
      'INVALID_REQUEST_BODY',
      'A valid JSON request body is required.'
    );
  }
};

const ensureAllowedFields = (body, allowed) => {
  const unexpected = Object.keys(body).filter(
    (key) => !allowed.has(key)
  );

  if (unexpected.length) {
    throw new WaiverError(
      400,
      'UNEXPECTED_REQUEST_FIELDS',
      `Unexpected request fields: ${unexpected.join(', ')}.`
    );
  }
};

const normalizeReason = (value, field = 'reason') => {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.trim().length > 500
  ) {
    throw new WaiverError(
      400,
      `INVALID_${field.toUpperCase()}`,
      `${field} is required and must not exceed 500 characters.`
    );
  }

  return value.trim();
};

const normalizeNotes = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string' || value.trim().length > 500) {
    throw new WaiverError(
      400,
      'INVALID_NOTES',
      'Notes must be text with a maximum of 500 characters.'
    );
  }

  return value.trim() || null;
};

const decimalTextToCents = (value) => {
  const text = String(value ?? '0').trim();
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text);

  if (!match) {
    throw new Error(`Invalid database decimal value: ${text}`);
  }

  const whole = BigInt(match[1]);
  const fraction = BigInt(((match[2] || '') + '00').slice(0, 2));

  return (whole * 100n) + fraction;
};

const parseWaiverAmount = (value) => {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text);

  if (!match) {
    throw new WaiverError(
      400,
      'INVALID_WAIVER_AMOUNT',
      'waiver_amount must be a positive amount with a maximum of two decimal places.'
    );
  }

  const cents =
    (BigInt(match[1]) * 100n) +
    BigInt(((match[2] || '') + '00').slice(0, 2));

  if (cents <= 0n || cents > MAX_DECIMAL_CENTS) {
    throw new WaiverError(
      400,
      'INVALID_WAIVER_AMOUNT',
      'Waiver amount must be greater than zero and within the supported amount limit.'
    );
  }

  return cents;
};

const centsToDecimal = (cents) => {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;

  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, '0');

  return `${negative ? '-' : ''}${whole}.${fraction}`;
};

const normalizeIdempotencyKey = (value) => {
  if (
    typeof value !== 'string' ||
    !UUID_PATTERN.test(value.trim())
  ) {
    throw new WaiverError(
      400,
      'INVALID_WAIVER_IDEMPOTENCY_KEY',
      'A valid UUID idempotency_key is required.'
    );
  }

  return value.trim().toLowerCase();
};

/*
 * The invoice must belong to the requested membership and the
 * requested member must be a participant in that membership.
 */
const getInvoiceForWaiver = async (
  connection,
  context,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `SELECT
       i.id,
       i.organization_id,
       i.membership_id,
       i.primary_member_id,
       i.branch_id,
       i.invoice_number,
       i.member_code_snapshot,
       i.member_name_snapshot,
       i.total_amount,
       i.currency_code,
       DATE_FORMAT(i.due_date, '%Y-%m-%d') AS due_date,
       CASE
         WHEN i.due_date IS NOT NULL
          AND i.due_date < CURRENT_DATE()
         THEN 1
         ELSE 0
       END AS is_overdue,
       i.status
     FROM member_membership_invoices i
     WHERE i.organization_id = ?
       AND i.membership_id = ?
       AND i.id = ?
       AND EXISTS (
         SELECT 1
         FROM member_membership_members mm
         WHERE mm.organization_id = i.organization_id
           AND mm.membership_id = i.membership_id
           AND mm.member_id = ?
       )
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [
      context.organizationId,
      context.membershipId,
      context.invoiceId,
      context.memberId,
    ]
  );

  if (!rows.length) {
    throw new WaiverError(
      404,
      'MEMBERSHIP_INVOICE_NOT_FOUND',
      'Invoice was not found for this member and membership.'
    );
  }

  return rows[0];
};

/*
 * All three financial ledgers are read together:
 * posted payment allocations, posted refunds and posted waivers.
 */
const getInvoiceAmounts = async (
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
    throw new WaiverError(
      404,
      'MEMBERSHIP_INVOICE_NOT_FOUND',
      'Invoice was not found.'
    );
  }

  const row = rows[0];

  const total = decimalTextToCents(row.total_amount);
  const allocated = decimalTextToCents(row.allocated_amount);
  const refunded = decimalTextToCents(row.refunded_amount);
  const waived = decimalTextToCents(row.waived_amount);

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
    netPaidCents: netPaid,
    balanceCents: balanceDue,
  };
};

const nextWaiverNumber = async (
  connection,
  organizationId
) => {
  const [dateRows] = await connection.query(
    `SELECT
       YEAR(CURRENT_DATE()) AS document_year,
       DATE_FORMAT(
         CURRENT_TIMESTAMP,
         '%Y-%m-%d %H:%i:%s'
       ) AS waiver_date`
  );

  const year = Number(dateRows[0]?.document_year);
  const waiverDate = dateRows[0]?.waiver_date;

  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 9999 ||
    !waiverDate
  ) {
    throw new Error('Unable to determine waiver numbering date.');
  }

  await connection.query(
    `INSERT INTO member_membership_billing_sequences
      (
        organization_id,
        document_type,
        document_year,
        sequence_value
      )
     VALUES (?, 'waiver', ?, 1)
     ON DUPLICATE KEY UPDATE
       sequence_value = sequence_value + 1`,
    [organizationId, year]
  );

  const [rows] = await connection.query(
    `SELECT sequence_value
     FROM member_membership_billing_sequences
     WHERE organization_id = ?
       AND document_type = 'waiver'
       AND document_year = ?
     LIMIT 1
     FOR UPDATE`,
    [organizationId, year]
  );

  if (!rows.length) {
    throw new Error('Unable to reserve a waiver number.');
  }

  const sequence = Number(rows[0].sequence_value);

  return {
    waiverNumber: `WAV-${year}-${String(sequence).padStart(6, '0')}`,
    waiverDate,
  };
};

const waiverSelectSql = `
  SELECT
    id,
    organization_id,
    waiver_number,
    invoice_id,
    branch_id,
    waiver_amount,
    currency_code,
    DATE_FORMAT(
      waiver_date,
      '%Y-%m-%d %H:%i:%s'
    ) AS waiver_date,
    reason,
    status,
    DATE_FORMAT(
      voided_at,
      '%Y-%m-%d %H:%i:%s'
    ) AS voided_at,
    voided_by_user_id,
    void_reason,
    notes,
    created_by_user_id,
    created_at
  FROM member_membership_invoice_waivers
`;

const serializeWaiver = (row) => ({
  id: Number(row.id),
  organization_id: Number(row.organization_id),
  waiver_number: row.waiver_number,
  invoice_id: Number(row.invoice_id),
  branch_id: Number(row.branch_id),
  waiver_amount: String(row.waiver_amount),
  currency_code: row.currency_code,
  waiver_date: row.waiver_date,
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
  created_at: row.created_at,
});

const getWaiverById = async (
  connection,
  context,
  waiverId,
  forUpdate = false
) => {
  const [rows] = await connection.query(
    `${waiverSelectSql}
     WHERE organization_id = ?
       AND invoice_id = ?
       AND id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [
      context.organizationId,
      context.invoiceId,
      waiverId,
    ]
  );

  if (!rows.length) {
    throw new WaiverError(
      404,
      'INVOICE_WAIVER_NOT_FOUND',
      'Invoice waiver was not found.'
    );
  }

  return rows[0];
};

const getWaiverByIdempotencyKey = async (
  connection,
  organizationId,
  key
) => {
  const [rows] = await connection.query(
    `${waiverSelectSql}
     WHERE organization_id = ?
       AND idempotency_key = ?
     LIMIT 1
     FOR UPDATE`,
    [organizationId, key]
  );

  return rows[0] || null;
};

const buildAuditMetadata = (context, invoice, extra = {}) => ({
  member: {
    id: Number(context.memberId),
    member_code: invoice.member_code_snapshot,
    full_name: invoice.member_name_snapshot,
  },
  member_membership_billing: {
    membership_id: Number(context.membershipId),
    invoice_id: Number(invoice.id),
    invoice_number: invoice.invoice_number,
    primary_member_id: Number(invoice.primary_member_id),
    action_branch_id: context.branchId,
    ...extra,
  },
});

const getErrorResponse = (res, error, fallbackCode, fallbackMessage) => {
  if (error instanceof WaiverError) {
    return res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
      ...(error.details || {}),
    });
  }

  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      code: 'WAIVER_IDEMPOTENCY_CONFLICT',
      message: 'This waiver request conflicts with an existing financial record.',
    });
  }

  console.error(`${fallbackCode}:`, error);

  return res.status(500).json({
    success: false,
    code: fallbackCode,
    message: fallbackMessage,
  });
};

// --------------------------------------------------
// GET invoice waivers
// --------------------------------------------------

const listMemberInvoiceWaivers = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const invoice = await getInvoiceForWaiver(
      connection,
      context,
      false
    );

    const [rows] = await connection.query(
      `${waiverSelectSql}
       WHERE organization_id = ?
         AND invoice_id = ?
       ORDER BY waiver_date DESC, id DESC`,
      [context.organizationId, context.invoiceId]
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
        action: 'MEMBER_MEMBERSHIP_INVOICE_WAIVERS_VIEWED',
        entityType: 'member_membership_invoice',
        entityId: context.invoiceId,
        description:
          `Viewed waivers for invoice ${invoice.invoice_number}.`,
        oldValues: null,
        newValues: {
          waiver_count: rows.length,
        },
        metadata: buildAuditMetadata(context, invoice),
      }
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      invoice_id: context.invoiceId,
      waivers: rows.map(serializeWaiver),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Waiver list rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_INVOICE_WAIVER_LIST_FAILED',
      'Unable to load invoice waivers.'
    );
  } finally {
    if (connection) connection.release();
  }
};

// --------------------------------------------------
// POST create invoice waiver
// --------------------------------------------------

const createMemberInvoiceWaiver = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body || {};

    ensureObjectBody(body);

    ensureAllowedFields(
      body,
      new Set([
        'waiver_amount',
        'reason',
        'notes',
        'idempotency_key',
      ])
    );

    const waiverCents = parseWaiverAmount(body.waiver_amount);
    const reason = normalizeReason(body.reason);
    const notes = normalizeNotes(body.notes);
    const idempotencyKey = normalizeIdempotencyKey(
      body.idempotency_key
    );

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const invoice = await getInvoiceForWaiver(
      connection,
      context,
      true
    );

    if (invoice.status !== 'issued') {
      throw new WaiverError(
        409,
        'VOID_INVOICE_CANNOT_BE_WAIVED',
        'A voided invoice cannot receive a waiver.'
      );
    }

    // Waivers are allowed only for overdue, unpaid charges.
    // This uses the same overdue definition as the invoice dashboard.
    if (Number(invoice.is_overdue) !== 1) {
      throw new WaiverError(
        409,
        'INVOICE_NOT_OVERDUE_FOR_WAIVER',
        'Only overdue invoices can receive a waiver.'
      );
    }

    /*
     * Idempotent replay: return the original waiver when the same
     * key and exactly the same request are submitted again.
     */
    const existing = await getWaiverByIdempotencyKey(
      connection,
      context.organizationId,
      idempotencyKey
    );

    if (existing) {
      const sameRequest =
        Number(existing.invoice_id) === context.invoiceId &&
        Number(existing.branch_id) === context.branchId &&
        decimalTextToCents(existing.waiver_amount) === waiverCents &&
        existing.reason === reason &&
        (existing.notes || null) === notes;

      if (!sameRequest) {
        throw new WaiverError(
          409,
          'WAIVER_IDEMPOTENCY_KEY_REUSED',
          'This idempotency key has already been used for a different waiver request.'
        );
      }

      const amounts = await getInvoiceAmounts(
        connection,
        context.organizationId,
        context.invoiceId
      );

      await connection.commit();
      transactionStarted = false;

      return res.json({
        success: true,
        replayed: true,
        message: 'The original waiver request was returned.',
        waiver: serializeWaiver(existing),
        invoice_balance: {
          total_amount: amounts.total_amount,
          allocated_amount: amounts.allocated_amount,
          refunded_amount: amounts.refunded_amount,
          waived_amount: amounts.waived_amount,
          net_paid: amounts.net_paid,
          balance_due: amounts.balance_due,
          payment_status: amounts.payment_status,
        },
      });
    }

    const before = await getInvoiceAmounts(
      connection,
      context.organizationId,
      context.invoiceId
    );

    if (before.netPaidCents >= before.totalCents && before.totalCents > 0n) {
      throw new WaiverError(
        409,
        'PAID_INVOICE_CANNOT_BE_WAIVED',
        'A fully paid invoice cannot be waived. Use the refund process when money must be returned.'
      );
    }

    if (before.balanceCents <= 0n) {
      throw new WaiverError(
        409,
        'NO_OUTSTANDING_BALANCE_TO_WAIVE',
        'This invoice has no outstanding balance available for waiver.'
      );
    }

    if (waiverCents > before.balanceCents) {
      throw new WaiverError(
        409,
        'WAIVER_EXCEEDS_OUTSTANDING_BALANCE',
        'The waiver amount cannot exceed the outstanding invoice balance.',
        {
          outstanding_balance: centsToDecimal(before.balanceCents),
          requested_waiver_amount: centsToDecimal(waiverCents),
        }
      );
    }

    const document = await nextWaiverNumber(
      connection,
      context.organizationId
    );

    const [insertResult] = await connection.query(
      `INSERT INTO member_membership_invoice_waivers
       (
         organization_id,
         waiver_number,
         idempotency_key,
         invoice_id,
         branch_id,
         waiver_amount,
         currency_code,
         waiver_date,
         reason,
         status,
         notes,
         created_by_user_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?)`,
      [
        context.organizationId,
        document.waiverNumber,
        idempotencyKey,
        context.invoiceId,
        context.branchId,
        centsToDecimal(waiverCents),
        invoice.currency_code,
        document.waiverDate,
        reason,
        notes,
        context.userId,
      ]
    );

    const waiverId = Number(insertResult.insertId);

    await writeAuditLog(
      connection,
      req,
      {
        organizationId: context.organizationId,
        branchId: context.branchId,
        userId: context.userId,
      },
      {
        action: 'MEMBER_MEMBERSHIP_INVOICE_WAIVER_POSTED',
        entityType: 'member_membership_invoice_waiver',
        entityId: waiverId,
        description:
          `Posted waiver ${document.waiverNumber} for invoice ` +
          `${invoice.invoice_number}; reason: ${reason}.`,
        oldValues: {
          outstanding_balance: before.balance_due,
        },
        newValues: {
          waiver_number: document.waiverNumber,
          waiver_amount: centsToDecimal(waiverCents),
          currency_code: invoice.currency_code,
          status: 'posted',
          reason,
        },
        metadata: buildAuditMetadata(context, invoice, {
          waiver_id: waiverId,
          waiver_number: document.waiverNumber,
        }),
      }
    );

    const waiver = await getWaiverById(
      connection,
      context,
      waiverId,
      false
    );

    const after = await getInvoiceAmounts(
      connection,
      context.organizationId,
      context.invoiceId
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: 'Invoice waiver created successfully.',
      waiver: serializeWaiver(waiver),
      invoice_balance: {
        total_amount: after.total_amount,
        allocated_amount: after.allocated_amount,
        refunded_amount: after.refunded_amount,
        waived_amount: after.waived_amount,
        net_paid: after.net_paid,
        balance_due: after.balance_due,
        payment_status: after.payment_status,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Waiver creation rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_INVOICE_WAIVER_CREATE_FAILED',
      'Unable to create the invoice waiver.'
    );
  } finally {
    if (connection) connection.release();
  }
};

// --------------------------------------------------
// POST void invoice waiver
// --------------------------------------------------

const voidMemberInvoiceWaiver = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const waiverId = parsePositiveId(req.params.waiverId);

    if (!waiverId) {
      throw new WaiverError(
        400,
        'INVALID_WAIVER_ID',
        'Waiver ID is invalid.'
      );
    }

    const body = req.body || {};
    ensureObjectBody(body);
    ensureAllowedFields(body, new Set(['reason']));

    const reason = normalizeReason(body.reason, 'void_reason');

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const invoice = await getInvoiceForWaiver(
      connection,
      context,
      true
    );

    const waiver = await getWaiverById(
      connection,
      context,
      waiverId,
      true
    );

    if (waiver.status !== 'posted') {
      throw new WaiverError(
        409,
        'WAIVER_ALREADY_VOIDED',
        'Only a posted waiver can be voided.'
      );
    }

    const [updateResult] = await connection.query(
      `UPDATE member_membership_invoice_waivers
       SET
         status = 'voided',
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
        context.invoiceId,
        waiverId,
      ]
    );

    if (updateResult.affectedRows !== 1) {
      throw new WaiverError(
        409,
        'WAIVER_STATE_CHANGED',
        'Waiver status changed. Refresh the invoice and try again.'
      );
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
        action: 'MEMBER_MEMBERSHIP_INVOICE_WAIVER_VOIDED',
        entityType: 'member_membership_invoice_waiver',
        entityId: waiverId,
        description:
          `Voided waiver ${waiver.waiver_number} for invoice ` +
          `${invoice.invoice_number}; reason: ${reason}.`,
        oldValues: {
          status: 'posted',
          waiver_amount: String(waiver.waiver_amount),
        },
        newValues: {
          status: 'voided',
          void_reason: reason,
        },
        metadata: buildAuditMetadata(context, invoice, {
          waiver_id: waiverId,
          waiver_number: waiver.waiver_number,
        }),
      }
    );

    const updatedWaiver = await getWaiverById(
      connection,
      context,
      waiverId,
      false
    );

    const amounts = await getInvoiceAmounts(
      connection,
      context.organizationId,
      context.invoiceId
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: 'Invoice waiver voided successfully. The outstanding balance has been recalculated.',
      waiver: serializeWaiver(updatedWaiver),
      invoice_balance: {
        total_amount: amounts.total_amount,
        allocated_amount: amounts.allocated_amount,
        refunded_amount: amounts.refunded_amount,
        waived_amount: amounts.waived_amount,
        net_paid: amounts.net_paid,
        balance_due: amounts.balance_due,
        payment_status: amounts.payment_status,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Waiver void rollback failed:',
          rollbackError.message
        );
      }
    }

    return getErrorResponse(
      res,
      error,
      'MEMBERSHIP_INVOICE_WAIVER_VOID_FAILED',
      'Unable to void the invoice waiver.'
    );
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  listMemberInvoiceWaivers,
  createMemberInvoiceWaiver,
  voidMemberInvoiceWaiver,
};