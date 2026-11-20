'use strict';

const db = require('../config/db');
const { writeAuditLog } = require('../services/gymAuditService');

const METRIC_PERMISSIONS = Object.freeze({
  expected: 'member_billing.dashboard.expected_collection.view',
  collected: 'member_billing.dashboard.collected_collection.view',
  outstanding: 'member_billing.dashboard.outstanding_collection.view',
  overdue: 'member_billing.dashboard.overdue_members.view',
  waivers: 'member_billing.waivers.view',
});

class BillingDashboardError extends Error {
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
    organizationId: positiveId(req.gymStaff?.organizationId),
    branchId: positiveId(req.gymStaff?.branchId),
    userId: positiveId(req.gymStaff?.userId),
  };

  if (!context.organizationId || !context.branchId || !context.userId) {
    throw new BillingDashboardError(
      401,
      'MEMBER_BILLING_DASHBOARD_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const permissionFlags = (req) => {
  const permissions = new Set(
    Array.isArray(req.gymStaff?.permissions)
      ? req.gymStaff.permissions
      : []
  );

  return Object.fromEntries(
    Object.entries(METRIC_PERMISSIONS).map(([key, permission]) => [
      key,
      permissions.has(permission),
    ])
  );
};

const parseMonth = async (connection, suppliedMonth) => {
  let month = suppliedMonth;

  if (month === undefined || month === null || month === '') {
    const [rows] = await connection.query(
      "SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m') AS current_month"
    );

    month = rows[0]?.current_month;
  }

  if (
    typeof month !== 'string' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  ) {
    throw new BillingDashboardError(
      400,
      'INVALID_BILLING_MONTH',
      'month must use YYYY-MM format.'
    );
  }

  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthNumber = Number(monthText);

  if (year < 2000 || year > 9998) {
    throw new BillingDashboardError(
      400,
      'INVALID_BILLING_MONTH',
      'Billing month year must be between 2000 and 9998.'
    );
  }

  const nextMonth = new Date(Date.UTC(year, monthNumber, 1));

  const endDate = `${nextMonth.getUTCFullYear()}-${String(
    nextMonth.getUTCMonth() + 1
  ).padStart(2, '0')}-01`;

  return {
    month,
    year,
    monthNumber,
    startDate: `${month}-01`,
    endDate,
    daysInMonth: new Date(Date.UTC(year, monthNumber, 0)).getUTCDate(),
  };
};

const parseYear = async (connection, suppliedYear) => {
  let year = suppliedYear;

  if (year === undefined || year === null || year === '') {
    const [rows] = await connection.query(
      'SELECT YEAR(CURRENT_DATE()) AS current_year'
    );

    year = String(rows[0]?.current_year ?? '');
  }

  const text = String(year);
  const number = Number(text);

  if (
    !/^\d{4}$/.test(text) ||
    number < 2000 ||
    number > 9998
  ) {
    throw new BillingDashboardError(
      400,
      'INVALID_BILLING_YEAR',
      'year must be a four-digit year between 2000 and 9998.'
    );
  }

  return {
    year: number,
    startDate: `${text}-01-01`,
    endDate: `${number + 1}-01-01`,
  };
};

const cents = (value) => {
  const text = String(value ?? '0').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);

  if (!match) {
    throw new Error(`Invalid database decimal amount: ${text}`);
  }

  const result =
    BigInt(match[2]) * 100n +
    BigInt(((match[3] || '') + '00').slice(0, 2));

  return match[1] === '-' ? -result : result;
};

const money = (value) => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  return `${negative ? '-' : ''}${absolute / 100n}.` +
    String(absolute % 100n).padStart(2, '0');
};

/*
 * Invoice balance formula:
 *
 * Outstanding =
 * Invoice total
 * - net posted payments
 * - posted waivers
 *
 * Net posted payments =
 * Posted allocations - posted refunds
 *
 * Voided payments, refunds and waivers are excluded.
 */

const invoiceLedgerSql = `
  SELECT
    i.id AS invoice_id,
    i.primary_member_id,
    i.currency_code,
    i.due_date,
    i.total_amount,

    GREATEST(
      i.total_amount
      - GREATEST(
          COALESCE(ledger.allocated_amount, 0.00)
          - COALESCE(ledger.refunded_amount, 0.00),
          0.00
        )
      - COALESCE(w.waived_amount, 0.00),
      0.00
    ) AS balance_due,

    GREATEST(
      i.total_amount - COALESCE(w.waived_amount, 0.00),
      0.00
    ) AS expected_amount

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
      WHERE organization_id = ?
        AND status = 'posted'
      GROUP BY organization_id, payment_allocation_id
    ) r
      ON r.organization_id = a.organization_id
     AND r.payment_allocation_id = a.id

    WHERE a.organization_id = ?
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
    WHERE organization_id = ?
      AND status = 'posted'
    GROUP BY organization_id, invoice_id
  ) w
    ON w.organization_id = i.organization_id
   AND w.invoice_id = i.id

  WHERE i.organization_id = ?
    AND i.branch_id = ?
    AND i.status = 'issued'
`;

const ledgerParams = (context) => [
  context.organizationId,
  context.organizationId,
  context.organizationId,
  context.organizationId,
  context.branchId,
];

/*
 * Combines invoice, payment, refund and waiver activity.
 *
 * format is selected internally:
 *   %Y-%m-%d = daily calendar
 *   %Y-%m    = yearly dues
 */

const loadMonthlyActivity = async (
  connection,
  context,
  startDate,
  endDate,
  format
) => {
  if (format !== '%Y-%m-%d' && format !== '%Y-%m') {
    throw new Error('Unsupported billing activity date format.');
  }

  const sql = `
    SELECT
      period_key,
      currency_code,
      SUM(expected_amount) AS expected_amount,
      SUM(outstanding_amount) AS outstanding_amount,
      SUM(gross_collected) AS gross_collected,
      SUM(refund_amount) AS refund_amount,
      SUM(waived_amount) AS waived_amount,
      SUM(due_invoice_count) AS due_invoice_count

    FROM (
      SELECT
        DATE_FORMAT(due_date, '${format}') AS period_key,
        currency_code,
        SUM(expected_amount) AS expected_amount,
        SUM(balance_due) AS outstanding_amount,
        0.00 AS gross_collected,
        0.00 AS refund_amount,
        0.00 AS waived_amount,
        COUNT(*) AS due_invoice_count

      FROM (${invoiceLedgerSql}) invoice_ledger

      WHERE due_date >= ?
        AND due_date < ?

      GROUP BY DATE_FORMAT(due_date, '${format}'), currency_code

      UNION ALL

      SELECT
        DATE_FORMAT(payment_date, '${format}') AS period_key,
        currency_code,
        0.00, 0.00, SUM(amount), 0.00, 0.00, 0

      FROM member_membership_payments

      WHERE organization_id = ?
        AND branch_id = ?
        AND status = 'posted'
        AND payment_date >= ?
        AND payment_date < ?

      GROUP BY DATE_FORMAT(payment_date, '${format}'), currency_code

      UNION ALL

      SELECT
        DATE_FORMAT(refund_date, '${format}') AS period_key,
        currency_code,
        0.00, 0.00, 0.00, SUM(refund_amount), 0.00, 0

      FROM member_membership_refunds

      WHERE organization_id = ?
        AND branch_id = ?
        AND status = 'posted'
        AND refund_date >= ?
        AND refund_date < ?

      GROUP BY DATE_FORMAT(refund_date, '${format}'), currency_code

      UNION ALL

      SELECT
        DATE_FORMAT(waiver_date, '${format}') AS period_key,
        currency_code,
        0.00, 0.00, 0.00, 0.00, SUM(waiver_amount), 0

      FROM member_membership_invoice_waivers

      WHERE organization_id = ?
        AND branch_id = ?
        AND status = 'posted'
        AND waiver_date >= ?
        AND waiver_date < ?

      GROUP BY DATE_FORMAT(waiver_date, '${format}'), currency_code

    ) activity

    GROUP BY period_key, currency_code
    ORDER BY period_key, currency_code
  `;

  const params = [
    ...ledgerParams(context),
    startDate,
    endDate,

    context.organizationId,
    context.branchId,
    startDate,
    endDate,

    context.organizationId,
    context.branchId,
    startDate,
    endDate,

    context.organizationId,
    context.branchId,
    startDate,
    endDate,
  ];

  const [rows] = await connection.query(sql, params);
  return rows;
};

const byCurrency = (rows, field) => {
  const totals = new Map();

  for (const row of rows) {
    const currency = row.currency_code;

    totals.set(
      currency,
      (totals.get(currency) || 0n) + cents(row[field])
    );
  }

  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency_code, amount]) => ({
      currency_code,
      amount: money(amount),
    }));
};

const netCollections = (rows) => rows.map((row) => ({
  currency_code: row.currency_code,
  gross_collected: String(row.gross_collected ?? '0.00'),
  refunds: String(row.refund_amount ?? '0.00'),
  net_collected: money(
    cents(row.gross_collected) - cents(row.refund_amount)
  ),
}));

/*
 * Financial dashboard reads are audited.
 * Read and audit log use the same transaction.
 */

const withAuditedRead = async (req, res, config, handler) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const flags = permissionFlags(req);

    connection = await db.getConnection();

    await connection.beginTransaction();
    transactionStarted = true;

    const data = await handler(connection, context, flags);

    await writeAuditLog(
      connection,
      req,
      {
        organizationId: context.organizationId,
        branchId: context.branchId,
        userId: context.userId,
      },
      {
        action: config.action,
        entityType: 'member_billing_dashboard',
        entityId: null,
        description: config.description,
        metadata: {
          active_branch_id: context.branchId,
          view: config.view,
          ...data.auditMetadata,
        },
      }
    );

    await connection.commit();
    transactionStarted = false;

    delete data.auditMetadata;

    return res.json({
      success: true,
      ...data,
    });

  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Billing dashboard rollback failed:',
          rollbackError.message
        );
      }
    }

    if (error instanceof BillingDashboardError) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    console.error(
      `${config.fallbackCode}:`,
      error.code || '',
      error.message
    );

    return res.status(500).json({
      success: false,
      code: config.fallbackCode,
      message: config.fallbackMessage,
    });

  } finally {
    if (connection) connection.release();
  }
};

const visibleMetrics = (flags, values) => ({
  expected_collection: flags.expected
    ? values.expected_collection : null,

  collected_collection: flags.collected
    ? values.collected_collection : null,

  outstanding_collection: flags.outstanding
    ? values.outstanding_collection : null,

  overdue_members: flags.overdue
    ? values.overdue_members : null,

  overdue_outstanding: flags.overdue
    ? values.overdue_outstanding : null,

  waived_amount: flags.waivers
    ? values.waived_amount : null,
});

/*
 * GET /api/members/billing/dashboard?month=YYYY-MM
 */

const getMemberBillingDashboard = (req, res) => withAuditedRead(
  req,
  res,
  {
    action: 'MEMBER_BILLING_DASHBOARD_VIEWED',
    description: 'Viewed the member Billing & Collections dashboard.',
    view: 'dashboard',
    fallbackCode: 'MEMBER_BILLING_DASHBOARD_FAILED',
    fallbackMessage: 'Unable to load the Billing & Collections dashboard.',
  },

  async (connection, context, flags) => {
    const period = await parseMonth(connection, req.query?.month);

    const activityRows = await loadMonthlyActivity(
      connection,
      context,
      period.startDate,
      period.endDate,
      '%Y-%m'
    );

    const [outstandingRows] = await connection.query(
      `SELECT
         currency_code,
         SUM(balance_due) AS amount
       FROM (${invoiceLedgerSql}) ledger
       GROUP BY currency_code
       ORDER BY currency_code`,
      ledgerParams(context)
    );

    const [overdueRows] = await connection.query(
      `SELECT COUNT(DISTINCT primary_member_id) AS member_count
       FROM (${invoiceLedgerSql}) ledger
       WHERE due_date IS NOT NULL
         AND due_date < CURRENT_DATE()
         AND balance_due > 0`,
      ledgerParams(context)
    );

    const monthlyRows = activityRows.filter(
      (row) => row.period_key === period.month
    );

    const [overdueAmountRows] = await connection.query(
      `SELECT
         currency_code,
         SUM(balance_due) AS amount
       FROM (${invoiceLedgerSql}) ledger
       WHERE due_date IS NOT NULL
         AND due_date < CURRENT_DATE()
         AND balance_due > 0
       GROUP BY currency_code
       ORDER BY currency_code`,
      ledgerParams(context)
    );

    const values = {
      expected_collection: byCurrency(
        monthlyRows,
        'expected_amount'
      ),

      collected_collection: netCollections(monthlyRows),

      outstanding_collection: outstandingRows.map((row) => ({
        currency_code: row.currency_code,
        amount: String(row.amount ?? '0.00'),
      })),

      overdue_members: Number(
        overdueRows[0]?.member_count || 0
      ),

      overdue_outstanding: byCurrency(
        overdueAmountRows,
        'amount'
      ),

      waived_amount: byCurrency(
        monthlyRows,
        'waived_amount'
      ),
    };

    return {
      period: {
        month: period.month,
        start_date: period.startDate,
        end_date_exclusive: period.endDate,
        branch_id: context.branchId,
      },

      metrics: visibleMetrics(flags, values),
      metric_visibility: flags,

      auditMetadata: {
        month: period.month,
      },
    };
  }
);

/*
 * GET /api/members/billing/calendar/monthly?month=YYYY-MM
 */

const getMemberBillingMonthlyCalendar = (req, res) => withAuditedRead(
  req,
  res,
  {
    action: 'MEMBER_BILLING_MONTHLY_CALENDAR_VIEWED',
    description: 'Viewed the monthly member billing calendar.',
    view: 'monthly_calendar',
    fallbackCode: 'MEMBER_BILLING_MONTHLY_CALENDAR_FAILED',
    fallbackMessage: 'Unable to load the monthly billing calendar.',
  },

  async (connection, context, flags) => {
    const period = await parseMonth(connection, req.query?.month);

    const rows = await loadMonthlyActivity(
      connection,
      context,
      period.startDate,
      period.endDate,
      '%Y-%m-%d'
    );

    const byDay = new Map();

    for (const row of rows) {
      if (!byDay.has(row.period_key)) {
        byDay.set(row.period_key, []);
      }

      byDay.get(row.period_key).push(row);
    }

    const days = [];

    for (let day = 1; day <= period.daysInMonth; day += 1) {
      const date =
        `${period.month}-${String(day).padStart(2, '0')}`;

      const dailyRows = byDay.get(date) || [];

      days.push({
        date,

        due_invoice_count: dailyRows.reduce(
          (sum, row) => sum + Number(row.due_invoice_count || 0),
          0
        ),

        expected_collection: flags.expected
          ? byCurrency(dailyRows, 'expected_amount')
          : null,

        outstanding_collection: flags.outstanding
          ? byCurrency(dailyRows, 'outstanding_amount')
          : null,

        collected_collection: flags.collected
          ? netCollections(dailyRows)
          : null,

        waived_amount: flags.waivers
          ? byCurrency(dailyRows, 'waived_amount')
          : null,
      });
    }

    return {
      period: {
        month: period.month,
        start_date: period.startDate,
        end_date_exclusive: period.endDate,
        branch_id: context.branchId,
      },

      days,
      metric_visibility: flags,

      auditMetadata: {
        month: period.month,
      },
    };
  }
);

/*
 * GET /api/members/billing/dues/yearly?year=YYYY
 */

const getMemberBillingYearlyDues = (req, res) => withAuditedRead(
  req,
  res,
  {
    action: 'MEMBER_BILLING_YEARLY_DUES_VIEWED',
    description: 'Viewed the yearly membership dues report.',
    view: 'yearly_dues',
    fallbackCode: 'MEMBER_BILLING_YEARLY_DUES_FAILED',
    fallbackMessage: 'Unable to load the yearly membership dues report.',
  },

  async (connection, context, flags) => {
    const period = await parseYear(connection, req.query?.year);

    const rows = await loadMonthlyActivity(
      connection,
      context,
      period.startDate,
      period.endDate,
      '%Y-%m'
    );

    const byMonth = new Map();

    for (const row of rows) {
      const month = Number(row.period_key.slice(5, 7));

      if (!byMonth.has(month)) {
        byMonth.set(month, []);
      }

      byMonth.get(month).push(row);
    }

    const months = [];

    for (let month = 1; month <= 12; month += 1) {
      const monthRows = byMonth.get(month) || [];

      months.push({
        month,

        expected_collection: flags.expected
          ? byCurrency(monthRows, 'expected_amount')
          : null,

        outstanding_collection: flags.outstanding
          ? byCurrency(monthRows, 'outstanding_amount')
          : null,

        collected_collection: flags.collected
          ? netCollections(monthRows)
          : null,

        waived_amount: flags.waivers
          ? byCurrency(monthRows, 'waived_amount')
          : null,
      });
    }

    return {
      year: period.year,
      branch_id: context.branchId,
      months,
      metric_visibility: flags,

      auditMetadata: {
        year: period.year,
      },
    };
  }
);

module.exports = {
  getMemberBillingDashboard,
  getMemberBillingMonthlyCalendar,
  getMemberBillingYearlyDues,
};