'use strict';

const db = require('../config/db');

const {
  writeAuditLog,
} = require('../services/gymAuditService');

class MemberBillingAccountError extends Error {
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
    organizationId: positiveId(req.gymStaff?.organizationId),
    branchId: positiveId(req.gymStaff?.branchId),
    userId: positiveId(req.gymStaff?.userId),
  };

  if (
    !context.memberId ||
    !context.organizationId ||
    !context.branchId ||
    !context.userId
  ) {
    throw new MemberBillingAccountError(
      401,
      'MEMBER_BILLING_ACCOUNT_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const parsePagination = (query) => {
  const page = query?.page === undefined
    ? 1
    : Number(query.page);

  const pageSize = query?.page_size === undefined
    ? 50
    : Number(query.page_size);

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    throw new MemberBillingAccountError(
      400,
      'INVALID_BILLING_ACCOUNT_PAGINATION',
      'page must be positive and page_size must be between 1 and 100.'
    );
  }

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
};

const decimalToCents = (value) => {
  const raw = String(value ?? '0').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);

  if (!match) {
    throw new Error(`Invalid database decimal value: ${raw}`);
  }

  const result =
    BigInt(match[2]) * 100n +
    BigInt(((match[3] || '') + '00').slice(0, 2));

  return match[1] === '-' ? -result : result;
};

const centsToDecimal = (value) => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  return `${negative ? '-' : ''}${absolute / 100n}.` +
    String(absolute % 100n).padStart(2, '0');
};

const getMember = async (connection, context) => {
  const [rows] = await connection.query(
    `SELECT
       id,
       member_code,
       full_name,
       registration_branch_id
     FROM members
     WHERE organization_id = ?
       AND id = ?
     LIMIT 1`,
    [
      context.organizationId,
      context.memberId,
    ]
  );

  if (!rows.length) {
    throw new MemberBillingAccountError(
      404,
      'BILLING_ACCOUNT_MEMBER_NOT_FOUND',
      'Member was not found in this organization.'
    );
  }

  const row = rows[0];

  return {
    id: Number(row.id),
    member_code: row.member_code,
    full_name: row.full_name,
    registration_branch_id: row.registration_branch_id == null
      ? null
      : Number(row.registration_branch_id),
  };
};

const getMemberMemberships = async (connection, context) => {
  const [rows] = await connection.query(
    `SELECT
       m.id AS membership_id,
       m.plan_code_snapshot,
       m.plan_name_snapshot,
       m.package_type_snapshot,
       m.validity_type_snapshot,

       m.price_snapshot,
       m.currency_code_snapshot,

       DATE_FORMAT(m.start_date, '%Y-%m-%d') AS start_date,
       DATE_FORMAT(m.end_date, '%Y-%m-%d') AS end_date,
       DATE_FORMAT(m.next_billing_date, '%Y-%m-%d')
         AS next_billing_date,

       m.status AS membership_status,

       mm.member_role,
       mm.status AS participant_status,
       DATE_FORMAT(mm.joined_on, '%Y-%m-%d') AS joined_on,
       DATE_FORMAT(mm.ended_on, '%Y-%m-%d') AS ended_on

     FROM member_membership_members mm

     INNER JOIN member_memberships m
       ON m.organization_id = mm.organization_id
      AND m.id = mm.membership_id

     WHERE mm.organization_id = ?
       AND mm.member_id = ?

     ORDER BY m.start_date DESC, m.id DESC`,
    [
      context.organizationId,
      context.memberId,
    ]
  );

  return rows.map((row) => ({
    membership_id: Number(row.membership_id),
    plan_code: row.plan_code_snapshot,
    plan_name: row.plan_name_snapshot,
    package_type: row.package_type_snapshot,
    validity_type: row.validity_type_snapshot,
    price: String(row.price_snapshot),
    currency_code: row.currency_code_snapshot,
    start_date: row.start_date,
    end_date: row.end_date,
    next_billing_date: row.next_billing_date,
    status: row.membership_status,
    member_role: row.member_role,
    participant_status: row.participant_status,
    joined_on: row.joined_on,
    ended_on: row.ended_on,
  }));
};

/*
 * An account can include more than one membership.
 * Every invoice is organization-scoped and linked to the member
 * through member_membership_members.
 *
 * Only posted payments, refunds and waivers affect balances.
 */

const getMemberInvoices = async (connection, context) => {
  const [rows] = await connection.query(
    `SELECT
       i.id,
       i.membership_id,
       i.branch_id,
       i.invoice_number,

       i.plan_code_snapshot,
       i.plan_name_snapshot,

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

       AND EXISTS (
         SELECT 1
         FROM member_membership_members mm
         WHERE mm.organization_id = i.organization_id
           AND mm.membership_id = i.membership_id
           AND mm.member_id = ?
       )

     ORDER BY i.invoice_date DESC, i.id DESC`,
    [
      context.organizationId,
      context.memberId,
    ]
  );

  return rows.map((row) => {
    const total = decimalToCents(row.total_amount);
    const allocated = decimalToCents(row.allocated_amount);
    const refunded = decimalToCents(row.refunded_amount);
    const waived = decimalToCents(row.waived_amount);

    const rawNetPaid = allocated - refunded;
    const netPaid = rawNetPaid > 0n ? rawNetPaid : 0n;

    let balance = total - netPaid - waived;
    if (balance < 0n) balance = 0n;

    // Voided invoices do not contribute to outstanding balances.
    if (row.status !== 'issued') {
      balance = 0n;
    }

    let paymentStatus = 'unpaid';

    if (row.status === 'void') {
      paymentStatus = 'void';
    } else if (total === 0n || (netPaid >= total && balance === 0n)) {
      paymentStatus = 'paid';
    } else if (balance === 0n && waived > 0n) {
      paymentStatus = netPaid > 0n
        ? 'settled'
        : 'waived';
    } else if (netPaid > 0n && waived > 0n) {
      paymentStatus = 'partially_paid_and_waived';
    } else if (netPaid > 0n) {
      paymentStatus = 'partially_paid';
    } else if (waived > 0n) {
      paymentStatus = 'partially_waived';
    }

    return {
      id: Number(row.id),
      membership_id: Number(row.membership_id),
      branch_id: Number(row.branch_id),
      invoice_number: row.invoice_number,

      plan_code: row.plan_code_snapshot,
      plan_name: row.plan_name_snapshot,

      billing_period_start: row.billing_period_start,
      billing_period_end: row.billing_period_end,

      invoice_date: row.invoice_date,
      due_date: row.due_date,

      total_amount: centsToDecimal(total),
      allocated_amount: centsToDecimal(allocated),
      refunded_amount: centsToDecimal(refunded),
      net_paid: centsToDecimal(netPaid),
      waived_amount: centsToDecimal(waived),
      balance_due: centsToDecimal(balance),

      currency_code: row.currency_code,
      payment_status: paymentStatus,
      status: row.status,
      notes: row.notes,

      is_overdue:
        row.status === 'issued' &&
        Boolean(row.due_date) &&
        row.due_date < new Date().toISOString().slice(0, 10) &&
        balance > 0n,
    };
  });
};

/*
 * All events are read from their original immutable ledgers.
 * Amounts are positive; event_type indicates whether the amount
 * represents an invoice, payment, refund or waiver.
 * Voided events remain visible in the account history.
 */

const ACCOUNT_EVENTS_SQL = `
  SELECT
    'invoice' AS event_type,
    i.id AS record_id,
    DATE_FORMAT(i.invoice_date, '%Y-%m-%d %H:%i:%s') AS event_date,
    i.invoice_number AS reference_number,
    i.total_amount AS amount,
    i.currency_code,
    i.status,
    i.branch_id,
    i.membership_id,
    i.id AS invoice_id,
    'Membership invoice' AS description

  FROM member_membership_invoices i

  WHERE i.organization_id = ?

    AND EXISTS (
      SELECT 1
      FROM member_membership_members mm
      WHERE mm.organization_id = i.organization_id
        AND mm.membership_id = i.membership_id
        AND mm.member_id = ?
    )

  UNION ALL

  SELECT
    'payment',
    p.id,
    DATE_FORMAT(p.payment_date, '%Y-%m-%d %H:%i:%s'),
    p.payment_number,
    a.allocated_amount,
    p.currency_code,
    p.status,
    p.branch_id,
    i.membership_id,
    i.id,
    CONCAT('Payment received - ', p.payment_method)

  FROM member_membership_payment_allocations a

  INNER JOIN member_membership_payments p
    ON p.organization_id = a.organization_id
   AND p.id = a.payment_id

  INNER JOIN member_membership_invoices i
    ON i.organization_id = a.organization_id
   AND i.id = a.invoice_id

  WHERE a.organization_id = ?

    AND EXISTS (
      SELECT 1
      FROM member_membership_members mm
      WHERE mm.organization_id = i.organization_id
        AND mm.membership_id = i.membership_id
        AND mm.member_id = ?
    )

  UNION ALL

  SELECT
    'refund',
    r.id,
    DATE_FORMAT(r.refund_date, '%Y-%m-%d %H:%i:%s'),
    r.refund_number,
    r.refund_amount,
    r.currency_code,
    r.status,
    r.branch_id,
    i.membership_id,
    i.id,
    CONCAT('Refund - ', r.reason)

  FROM member_membership_refunds r

  INNER JOIN member_membership_payment_allocations a
    ON a.organization_id = r.organization_id
   AND a.id = r.payment_allocation_id

  INNER JOIN member_membership_invoices i
    ON i.organization_id = a.organization_id
   AND i.id = a.invoice_id

  WHERE r.organization_id = ?

    AND EXISTS (
      SELECT 1
      FROM member_membership_members mm
      WHERE mm.organization_id = i.organization_id
        AND mm.membership_id = i.membership_id
        AND mm.member_id = ?
    )

  UNION ALL

  SELECT
    'waiver',
    w.id,
    DATE_FORMAT(w.waiver_date, '%Y-%m-%d %H:%i:%s'),
    w.waiver_number,
    w.waiver_amount,
    w.currency_code,
    w.status,
    w.branch_id,
    i.membership_id,
    i.id,
    CONCAT('Waiver - ', w.reason)

  FROM member_membership_invoice_waivers w

  INNER JOIN member_membership_invoices i
    ON i.organization_id = w.organization_id
   AND i.id = w.invoice_id

  WHERE w.organization_id = ?

    AND EXISTS (
      SELECT 1
      FROM member_membership_members mm
      WHERE mm.organization_id = i.organization_id
        AND mm.membership_id = i.membership_id
        AND mm.member_id = ?
    )
`;

const eventQueryParams = (context) => [
  context.organizationId,
  context.memberId,

  context.organizationId,
  context.memberId,

  context.organizationId,
  context.memberId,

  context.organizationId,
  context.memberId,
];

const getTransactions = async (
  connection,
  context,
  pagination
) => {
  const params = eventQueryParams(context);

  const [countRows] = await connection.query(
    `SELECT COUNT(*) AS total
     FROM (${ACCOUNT_EVENTS_SQL}) account_events`,
    params
  );

  const total = Number(countRows[0]?.total || 0);

  const [rows] = await connection.query(
    `SELECT *
     FROM (${ACCOUNT_EVENTS_SQL}) account_events
     ORDER BY event_date DESC, record_id DESC, event_type ASC
     LIMIT ? OFFSET ?`,
    [
      ...params,
      pagination.pageSize,
      pagination.offset,
    ]
  );

  return {
    page: pagination.page,
    page_size: pagination.pageSize,
    total,
    total_pages: Math.ceil(total / pagination.pageSize),

    items: rows.map((row) => ({
      event_type: row.event_type,
      record_id: Number(row.record_id),
      event_date: row.event_date,
      reference_number: row.reference_number,
      amount: String(row.amount),
      currency_code: row.currency_code,
      status: row.status,
      branch_id: Number(row.branch_id),
      membership_id: Number(row.membership_id),
      invoice_id: Number(row.invoice_id),
      description: row.description,
    })),
  };
};

const getFinancialSummary = (invoices) => {
  const summaries = new Map();

  for (const invoice of invoices) {
    if (invoice.status !== 'issued') continue;

    const currency = invoice.currency_code;

    if (!summaries.has(currency)) {
      summaries.set(currency, {
        currency_code: currency,
        invoice_count: 0,
        invoiced: 0n,
        allocated: 0n,
        refunded: 0n,
        netCollected: 0n,
        waived: 0n,
        outstanding: 0n,
      });
    }

    const summary = summaries.get(currency);

    const total = decimalToCents(invoice.total_amount);
    const allocated = decimalToCents(invoice.allocated_amount);
    const refunded = decimalToCents(invoice.refunded_amount);
    const waived = decimalToCents(invoice.waived_amount);
    const balance = decimalToCents(invoice.balance_due);
    const paid = decimalToCents(invoice.net_paid);

    summary.invoice_count += 1;
    summary.invoiced += total;
    summary.allocated += allocated;
    summary.refunded += refunded;
    summary.netCollected += paid;
    summary.waived += waived;
    summary.outstanding += balance;
  }

  return [...summaries.values()]
    .sort((a, b) => a.currency_code.localeCompare(b.currency_code))
    .map((summary) => ({
      currency_code: summary.currency_code,
      invoice_count: summary.invoice_count,
      invoiced_amount: centsToDecimal(summary.invoiced),
      allocated_payments: centsToDecimal(summary.allocated),
      refunds: centsToDecimal(summary.refunded),
      net_collected: centsToDecimal(summary.netCollected),
      waived_amount: centsToDecimal(summary.waived),
      outstanding_amount: centsToDecimal(summary.outstanding),
    }));
};

const getMemberBillingAccount = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const pagination = parsePagination(req.query);

    connection = await db.getConnection();

    await connection.beginTransaction();
    transactionStarted = true;

    const member = await getMember(connection, context);

    const memberships = await getMemberMemberships(
      connection,
      context
    );

    const invoices = await getMemberInvoices(
      connection,
      context
    );

    const transactions = await getTransactions(
      connection,
      context,
      pagination
    );

    const financialSummary = getFinancialSummary(invoices);

    await writeAuditLog(
      connection,
      req,
      {
        organizationId: context.organizationId,
        branchId: context.branchId,
        userId: context.userId,
      },
      {
        action: 'MEMBER_BILLING_ACCOUNT_VIEWED',
        entityType: 'member_billing_account',
        entityId: context.memberId,
        description:
          `Viewed billing account for member ${member.member_code}.`,
        metadata: {
          member: {
            id: member.id,
            member_code: member.member_code,
          },
          action_branch_id: context.branchId,
          membership_count: memberships.length,
          invoice_count: invoices.length,
        },
      }
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,

      member,

      scope: {
        organization_id: context.organizationId,
        branch_scope: 'organization',
        action_branch_id: context.branchId,
      },

      membership_summary: {
        total: memberships.length,
        active: memberships.filter(
          (item) =>
            item.membership_status === 'active' &&
            item.participant_status === 'active'
        ).length,
      },

      memberships,

      financial_summary: financialSummary,

      invoices,

      transactions,
    });

  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Member billing account rollback failed:',
          rollbackError.message
        );
      }
    }

    if (error instanceof MemberBillingAccountError) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    console.error(
      'MEMBER_BILLING_ACCOUNT_FAILED:',
      error.code || '',
      error.message
    );

    return res.status(500).json({
      success: false,
      code: 'MEMBER_BILLING_ACCOUNT_FAILED',
      message: 'Unable to load the member billing account.',
    });

  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getMemberBillingAccount,
};