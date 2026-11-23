"use strict";

const db = require("../config/db");
const { writeAuditLog } = require("../services/gymAuditService");

const PERMISSIONS = Object.freeze({
  memberships: "member_memberships.view",
  attendance: "attendance.view",
  collected: "member_billing.dashboard.collected_collection.view",
  expected: "member_billing.dashboard.expected_collection.view",
  outstanding: "member_billing.dashboard.outstanding_collection.view",
  overdue: "member_billing.dashboard.overdue_members.view",
  targetManage: "dashboard.membership_target.manage",
  programCollections: "member_program_billing.payments.view",
});

class DashboardError extends Error {
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
    activeBranchId: positiveId(req.gymStaff?.branchId),
    userId: positiveId(req.gymStaff?.userId),
  };

  if (
    !context.organizationId ||
    !context.activeBranchId ||
    !context.userId
  ) {
    throw new DashboardError(
      401,
      "DASHBOARD_SESSION_REQUIRED",
      "A valid Gym Staff session and active branch are required."
    );
  }

  return context;
};

const hasPermission = (req, permission) =>
  Array.isArray(req.gymStaff?.permissions) &&
  req.gymStaff.permissions.includes(permission);

const getMetricVisibility = (req) => ({
  memberships: hasPermission(req, PERMISSIONS.memberships),
  attendance: hasPermission(req, PERMISSIONS.attendance),
  collected: hasPermission(req, PERMISSIONS.collected),
  expected: hasPermission(req, PERMISSIONS.expected),
  outstanding: hasPermission(req, PERMISSIONS.outstanding),
  overdue: hasPermission(req, PERMISSIONS.overdue),
  target_manage: hasPermission(req, PERMISSIONS.targetManage),
  program_collections: hasPermission(req, PERMISSIONS.programCollections),
});

const getBranchScope = (req, context, suppliedBranchId) => {
  const accessible = Array.isArray(req.gymStaff?.branches)
    ? req.gymStaff.branches
    : [];

  const branchMap = new Map();

  for (const branch of accessible) {
    const id = positiveId(branch?.id);
    if (!id) continue;

    branchMap.set(id, {
      id,
      name: String(branch.name || "Branch"),
      branch_code: branch.branch_code || null,
    });
  }

  if (!branchMap.has(context.activeBranchId)) {
    throw new DashboardError(
      403,
      "DASHBOARD_ACTIVE_BRANCH_NOT_AUTHORIZED",
      "Your active branch is not in your authorized branch list."
    );
  }

  if (
    suppliedBranchId === undefined ||
    suppliedBranchId === null ||
    suppliedBranchId === ""
  ) {
    const branch = branchMap.get(context.activeBranchId);

    return {
      type: "branch",
      branchId: branch.id,
      branches: [branch],
      branchIds: [branch.id],
    };
  }

  if (
    typeof suppliedBranchId === "string" &&
    suppliedBranchId.trim().toLowerCase() === "all"
  ) {
    const branches = [...branchMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name) || a.id - b.id
    );

    if (branches.length === 0) {
      throw new DashboardError(
        403,
        "DASHBOARD_NO_AUTHORIZED_BRANCHES",
        "No authorized branches are available for reporting."
      );
    }

    return {
      type: "all",
      branchId: null,
      branches,
      branchIds: branches.map((branch) => branch.id),
    };
  }

  const requestedBranchId = positiveId(suppliedBranchId);

  if (!requestedBranchId) {
    throw new DashboardError(
      400,
      "INVALID_DASHBOARD_BRANCH",
      "branch_id must be an authorized branch ID or 'all'."
    );
  }

  const selectedBranch = branchMap.get(requestedBranchId);

  if (!selectedBranch) {
    throw new DashboardError(
      403,
      "DASHBOARD_BRANCH_ACCESS_DENIED",
      "You do not have reporting access to the requested branch."
    );
  }

  return {
    type: "branch",
    branchId: selectedBranch.id,
    branches: [selectedBranch],
    branchIds: [selectedBranch.id],
  };
};

const parseMonth = (value, fallback) => {
  const month = value == null || value === "" ? fallback : value;

  if (
    typeof month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  ) {
    throw new DashboardError(
      400,
      "INVALID_DASHBOARD_MONTH",
      "month must use YYYY-MM format."
    );
  }

  const year = Number(month.slice(0, 4));
  if (year < 2000 || year > 9998) {
    throw new DashboardError(
      400,
      "INVALID_DASHBOARD_MONTH",
      "Month year must be between 2000 and 9998."
    );
  }

  return month;
};

const parseYear = (value, fallback) => {
  const yearText = value == null || value === "" ? fallback : String(value);
  const year = Number(yearText);

  if (
    !/^\d{4}$/.test(yearText) ||
    !Number.isSafeInteger(year) ||
    year < 2000 ||
    year > 9998
  ) {
    throw new DashboardError(
      400,
      "INVALID_DASHBOARD_YEAR",
      "year must be a four-digit year between 2000 and 9998."
    );
  }

  return year;
};

const getPeriods = async (connection, query) => {
  const [todayRows] = await connection.query(
    `SELECT
       DATE_FORMAT(CURRENT_DATE(), '%Y-%m') AS current_month,
       DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today_date`
  );

  const month = parseMonth(query?.month, todayRows[0].current_month);
  const year = parseYear(query?.year, month.slice(0, 4));

  const selectedMonthYear = Number(month.slice(0, 4));

  if (year !== selectedMonthYear) {
    throw new DashboardError(
      400,
      "DASHBOARD_PERIOD_YEAR_MISMATCH",
      "The selected reporting year must match the year in the selected month."
    );
  }

  const [monthYearText, monthNumberText] = month.split("-");
  const monthYear = Number(monthYearText);
  const monthNumber = Number(monthNumberText);

  const nextMonth = new Date(Date.UTC(monthYear, monthNumber, 1));
  const monthEnd =
    `${nextMonth.getUTCFullYear()}-${String(
      nextMonth.getUTCMonth() + 1
    ).padStart(2, "0")}-01`;

  return {
    month,
    year,
    monthStart: `${month}-01`,
    monthEnd,
    yearStart: `${year}-01-01`,
    yearEnd: `${year + 1}-01-01`,
    targetMonth: `${month}-01`,
    currentDate: todayRows[0].today_date,
  };
};

const branchPlaceholders = (branchIds) =>
  branchIds.map(() => "?").join(", ");

const decimalToCents = (value) => {
  const text = String(value ?? "0").trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);

  if (!match) {
    throw new Error(`Invalid database decimal amount: ${text}`);
  }

  const amount =
    BigInt(match[2]) * 100n +
    BigInt(((match[3] || "") + "00").slice(0, 2));

  return match[1] === "-" ? -amount : amount;
};

const centsToDecimal = (value) => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  return `${negative ? "-" : ""}${absolute / 100n}.` +
    String(absolute % 100n).padStart(2, "0");
};

const aggregateAmounts = (rows, dimensions, amountField) => {
  const groups = new Map();

  for (const row of rows) {
    const keyValues = dimensions.map((field) => row[field] ?? null);
    const key = JSON.stringify(keyValues);

    if (!groups.has(key)) {
      const item = {};
      dimensions.forEach((field, index) => {
        item[field] = keyValues[index];
      });
      item.amountCents = 0n;
      groups.set(key, item);
    }

    groups.get(key).amountCents += decimalToCents(row[amountField]);
  }

  return [...groups.values()]
    .sort((a, b) => {
      for (const field of dimensions) {
        const left = String(a[field] ?? "");
        const right = String(b[field] ?? "");
        const comparison = left.localeCompare(right);
        if (comparison !== 0) return comparison;
      }
      return 0;
    })
    .map((item) => {
      const amount = centsToDecimal(item.amountCents);
      delete item.amountCents;
      return { ...item, amount };
    });
};

const formatCollections = (rows) =>
  rows.map((row) => {
    const gross = decimalToCents(row.gross_collected);
    const refunds = decimalToCents(row.refund_amount);

    return {
      branch_id: Number(row.branch_id),
      branch_name: row.branch_name,
      currency_code: row.currency_code,
      period_month: row.period_month,
      gross_collected: centsToDecimal(gross),
      refunds: centsToDecimal(refunds),
      net_collected: centsToDecimal(gross - refunds),
    };
  });

const aggregateCollections = (rows, dimensions) => {
  const groups = new Map();

  for (const row of rows) {
    const keyValues = dimensions.map((field) => row[field] ?? null);
    const key = JSON.stringify(keyValues);

    if (!groups.has(key)) {
      const item = {};
      dimensions.forEach((field, index) => {
        item[field] = keyValues[index];
      });
      item.grossCents = 0n;
      item.refundCents = 0n;
      groups.set(key, item);
    }

    const item = groups.get(key);
    item.grossCents += decimalToCents(row.gross_collected);
    item.refundCents += decimalToCents(row.refunds);
  }

  return [...groups.values()]
    .sort((a, b) => {
      for (const field of dimensions) {
        const comparison = String(a[field] ?? "")
          .localeCompare(String(b[field] ?? ""));
        if (comparison !== 0) return comparison;
      }
      return 0;
    })
    .map((item) => ({
      ...Object.fromEntries(
        dimensions.map((field) => [field, item[field]])
      ),
      gross_collected: centsToDecimal(item.grossCents),
      refunds: centsToDecimal(item.refundCents),
      net_collected: centsToDecimal(
        item.grossCents - item.refundCents
      ),
    }));
};

const loadMembershipMetrics = async (
  connection,
  context,
  scope,
  period
) => {
  const inSql = branchPlaceholders(scope.branchIds);

  const [createdRows] = await connection.query(
    `SELECT mm.branch_id, COUNT(*) AS total
     FROM member_memberships mm
     WHERE mm.organization_id = ?
       AND mm.branch_id IN (${inSql})
       AND mm.created_at >= ?
       AND mm.created_at < ?
     GROUP BY mm.branch_id`,
    [
      context.organizationId,
      ...scope.branchIds,
      period.monthStart,
      period.monthEnd,
    ]
  );

  const [statusRows] = await connection.query(
    `SELECT mm.status, COUNT(*) AS total
     FROM member_memberships mm
     WHERE mm.organization_id = ?
       AND mm.branch_id IN (${inSql})
     GROUP BY mm.status`,
    [context.organizationId, ...scope.branchIds]
  );

  const [targetRows] = await connection.query(
    `SELECT branch_id, SUM(target_count) AS total
     FROM dashboard_membership_targets
     WHERE organization_id = ?
       AND branch_id IN (${inSql})
       AND target_month = ?
     GROUP BY branch_id`,
    [
      context.organizationId,
      ...scope.branchIds,
      period.targetMonth,
    ]
  );

  const createdByBranch = new Map(
    createdRows.map((row) => [
      Number(row.branch_id),
      Number(row.total || 0),
    ])
  );

  const targetByBranch = new Map(
    targetRows.map((row) => [
      Number(row.branch_id),
      Number(row.total || 0),
    ])
  );

  const byBranch = scope.branches.map((branch) => {
    const created = createdByBranch.get(branch.id) || 0;
    const target = targetByBranch.get(branch.id) || 0;

    return {
      branch_id: branch.id,
      branch_name: branch.name,
      new_memberships: created,
      target_count: target,
      remaining: Math.max(target - created, 0),
      progress_percent: target > 0
        ? Math.round((created / target) * 10000) / 100
        : 0,
    };
  });

  const createdTotal = byBranch.reduce(
    (sum, row) => sum + row.new_memberships,
    0
  );
  const targetTotal = byBranch.reduce(
    (sum, row) => sum + row.target_count,
    0
  );

  const statusValues = new Map(
    statusRows.map((row) => [row.status, Number(row.total || 0)])
  );

  const statusOrder = ["active", "suspended", "expired", "cancelled"];

  return {
    new_memberships: createdTotal,
    target_count: targetTotal,
    remaining: Math.max(targetTotal - createdTotal, 0),
    progress_percent: targetTotal > 0
      ? Math.round((createdTotal / targetTotal) * 10000) / 100
      : 0,
    status_counts: statusOrder.map((status) => ({
      status,
      count: statusValues.get(status) || 0,
    })),
    by_branch: byBranch,
  };
};

const loadAttendanceMetrics = async (
  connection,
  context,
  scope
) => {
  const inSql = branchPlaceholders(scope.branchIds);

  const [rows] = await connection.query(
    `SELECT
       attendance.branch_id,
       branch.name AS branch_name,
       COUNT(*) AS total
     FROM member_attendance attendance
     INNER JOIN branches branch
       ON branch.organization_id = attendance.organization_id
      AND branch.id = attendance.branch_id
     WHERE attendance.organization_id = ?
       AND attendance.branch_id IN (${inSql})
       AND attendance.attendance_date = CURRENT_DATE()
     GROUP BY attendance.branch_id, branch.name
     ORDER BY branch.name ASC`,
    [context.organizationId, ...scope.branchIds]
  );

  const counts = new Map(
    rows.map((row) => [Number(row.branch_id), Number(row.total || 0)])
  );

  const byBranch = scope.branches.map((branch) => ({
    branch_id: branch.id,
    branch_name: branch.name,
    check_ins: counts.get(branch.id) || 0,
  }));

  return {
    today_check_ins: byBranch.reduce(
      (sum, row) => sum + row.check_ins,
      0
    ),
    by_branch: byBranch,
  };
};

const loadCollectionMetrics = async (
  connection,
  context,
  scope,
  period
) => {
  const inSql = branchPlaceholders(scope.branchIds);

  const [rows] = await connection.query(
    `SELECT
       branch_id,
       branch_name,
       currency_code,
       period_month,
       SUM(gross_collected) AS gross_collected,
       SUM(refund_amount) AS refund_amount
     FROM (
       SELECT
         payment.branch_id,
         branch.name AS branch_name,
         payment.currency_code,
         DATE_FORMAT(payment.payment_date, '%Y-%m') AS period_month,
         SUM(payment.amount) AS gross_collected,
         0.00 AS refund_amount
       FROM member_membership_payments payment
       INNER JOIN branches branch
         ON branch.organization_id = payment.organization_id
        AND branch.id = payment.branch_id
       WHERE payment.organization_id = ?
         AND payment.branch_id IN (${inSql})
         AND payment.status = 'posted'
         AND payment.payment_date >= ?
         AND payment.payment_date < ?
       GROUP BY
         payment.branch_id,
         branch.name,
         payment.currency_code,
         DATE_FORMAT(payment.payment_date, '%Y-%m')

       UNION ALL

       SELECT
         refund.branch_id,
         branch.name AS branch_name,
         refund.currency_code,
         DATE_FORMAT(refund.refund_date, '%Y-%m') AS period_month,
         0.00 AS gross_collected,
         SUM(refund.refund_amount) AS refund_amount
       FROM member_membership_refunds refund
       INNER JOIN branches branch
         ON branch.organization_id = refund.organization_id
        AND branch.id = refund.branch_id
       WHERE refund.organization_id = ?
         AND refund.branch_id IN (${inSql})
         AND refund.status = 'posted'
         AND refund.refund_date >= ?
         AND refund.refund_date < ?
       GROUP BY
         refund.branch_id,
         branch.name,
         refund.currency_code,
         DATE_FORMAT(refund.refund_date, '%Y-%m')
     ) activity
     GROUP BY branch_id, branch_name, currency_code, period_month
     ORDER BY period_month, branch_name, currency_code`,
    [
      context.organizationId,
      ...scope.branchIds,
      period.yearStart,
      period.yearEnd,
      context.organizationId,
      ...scope.branchIds,
      period.yearStart,
      period.yearEnd,
    ]
  );

  const yearlyRows = formatCollections(rows);
  const monthlyRows = yearlyRows.filter(
    (row) => row.period_month === period.month
  );

  return {
    monthly: {
      by_currency: aggregateCollections(
        monthlyRows,
        ["currency_code"]
      ),
      by_branch: aggregateCollections(
        monthlyRows,
        ["branch_id", "branch_name", "currency_code"]
      ),
    },
    yearly: {
      by_currency: aggregateCollections(
        yearlyRows,
        ["currency_code"]
      ),
      by_branch: aggregateCollections(
        yearlyRows,
        ["branch_id", "branch_name", "currency_code"]
      ),
      by_month: aggregateCollections(
        yearlyRows,
        ["period_month", "currency_code"]
      ),
    },
  };
};

const loadProgramCollectionMetrics = async (
  connection,
  context,
  scope,
  period
) => {
  const inSql = branchPlaceholders(scope.branchIds);

  const [rows] = await connection.query(
    `SELECT
       payment.branch_id,
       branch.name AS branch_name,
       payment.currency_code,
       DATE_FORMAT(payment.payment_date, '%Y-%m') AS period_month,
       SUM(payment.amount) AS gross_collected,
       0.00 AS refund_amount
     FROM member_program_payments payment
     INNER JOIN branches branch
       ON branch.organization_id = payment.organization_id
      AND branch.id = payment.branch_id
     WHERE payment.organization_id = ?
       AND payment.branch_id IN (${inSql})
       AND payment.status = 'posted'
       AND payment.payment_date >= ?
       AND payment.payment_date < ?
     GROUP BY
       payment.branch_id,
       branch.name,
       payment.currency_code,
       DATE_FORMAT(payment.payment_date, '%Y-%m')
     ORDER BY period_month, branch.name, payment.currency_code`,
    [
      context.organizationId,
      ...scope.branchIds,
      period.yearStart,
      period.yearEnd,
    ]
  );

  const yearlyRows = formatCollections(rows);
  const monthlyRows = yearlyRows.filter(
    (row) => row.period_month === period.month
  );

  return {
    monthly: {
      by_currency: aggregateCollections(
        monthlyRows,
        ["currency_code"]
      ),
      by_branch: aggregateCollections(
        monthlyRows,
        ["branch_id", "branch_name", "currency_code"]
      ),
    },
    yearly: {
      by_currency: aggregateCollections(
        yearlyRows,
        ["currency_code"]
      ),
      by_branch: aggregateCollections(
        yearlyRows,
        ["branch_id", "branch_name", "currency_code"]
      ),
      by_month: aggregateCollections(
        yearlyRows,
        ["period_month", "currency_code"]
      ),
    },
  };
};
const loadExpectedCollections = async (
  connection,
  context,
  scope,
  period
) => {
  const ledger = invoiceLedgerSql(context, scope);

  const [rows] = await connection.query(
    `SELECT
       branch_id,
       branch_name,
       currency_code,
       SUM(balance_due) AS amount
     FROM (${ledger.sql}) invoice_ledger
     WHERE due_date IS NOT NULL
       AND due_date >= ?
       AND due_date < ?
       AND balance_due > 0
     GROUP BY branch_id, branch_name, currency_code
     ORDER BY branch_name, currency_code`,
    [
      ...ledger.params,
      period.monthStart,
      period.monthEnd,
    ]
  );

  return {
    by_currency: aggregateAmounts(rows, ["currency_code"], "amount"),
    by_branch: aggregateAmounts(
      rows,
      ["branch_id", "branch_name", "currency_code"],
      "amount"
    ),
  };
};

const invoiceLedgerSql = (context, scope) => {
  const inSql = branchPlaceholders(scope.branchIds);

  return {
    sql: `
      SELECT
        invoice.id AS invoice_id,
        invoice.primary_member_id,
        invoice.branch_id,
        branch.name AS branch_name,
        invoice.currency_code,
        invoice.due_date,

        GREATEST(
          invoice.total_amount
          - GREATEST(
              COALESCE(ledger.allocated_amount, 0.00)
              - COALESCE(ledger.refunded_amount, 0.00),
              0.00
            )
          - COALESCE(waiver.waived_amount, 0.00),
          0.00
        ) AS balance_due

      FROM member_membership_invoices invoice

      INNER JOIN branches branch
        ON branch.organization_id = invoice.organization_id
       AND branch.id = invoice.branch_id

      LEFT JOIN (
        SELECT
          allocation.organization_id,
          allocation.invoice_id,
          SUM(allocation.allocated_amount) AS allocated_amount,
          SUM(COALESCE(refunds.refunded_amount, 0.00)) AS refunded_amount

        FROM member_membership_payment_allocations allocation

        INNER JOIN member_membership_payments payment
          ON payment.organization_id = allocation.organization_id
         AND payment.id = allocation.payment_id
         AND payment.status = 'posted'

        LEFT JOIN (
          SELECT
            organization_id,
            payment_allocation_id,
            SUM(refund_amount) AS refunded_amount
          FROM member_membership_refunds
          WHERE organization_id = ?
            AND status = 'posted'
          GROUP BY organization_id, payment_allocation_id
        ) refunds
          ON refunds.organization_id = allocation.organization_id
         AND refunds.payment_allocation_id = allocation.id

        WHERE allocation.organization_id = ?
        GROUP BY allocation.organization_id, allocation.invoice_id

      ) ledger
        ON ledger.organization_id = invoice.organization_id
       AND ledger.invoice_id = invoice.id

      LEFT JOIN (
        SELECT
          organization_id,
          invoice_id,
          SUM(waiver_amount) AS waived_amount
        FROM member_membership_invoice_waivers
        WHERE organization_id = ?
          AND status = 'posted'
        GROUP BY organization_id, invoice_id
      ) waiver
        ON waiver.organization_id = invoice.organization_id
       AND waiver.invoice_id = invoice.id

      WHERE invoice.organization_id = ?
        AND invoice.branch_id IN (${inSql})
        AND invoice.status = 'issued'
    `,
    params: [
      context.organizationId,
      context.organizationId,
      context.organizationId,
      context.organizationId,
      ...scope.branchIds,
    ],
  };
};

const loadOutstandingCollections = async (
  connection,
  context,
  scope
) => {
  const ledger = invoiceLedgerSql(context, scope);

  const [rows] = await connection.query(
    `SELECT
       branch_id,
       branch_name,
       currency_code,
       SUM(balance_due) AS amount
     FROM (${ledger.sql}) invoice_ledger
     GROUP BY branch_id, branch_name, currency_code
     ORDER BY branch_name, currency_code`,
    ledger.params
  );

  return {
    by_currency: aggregateAmounts(rows, ["currency_code"], "amount"),
    by_branch: aggregateAmounts(
      rows,
      ["branch_id", "branch_name", "currency_code"],
      "amount"
    ),
  };
};

const loadOverdueMembers = async (
  connection,
  context,
  scope
) => {
  const ledger = invoiceLedgerSql(context, scope);

  const [countRows] = await connection.query(
    `SELECT COUNT(DISTINCT primary_member_id) AS total
     FROM (${ledger.sql}) invoice_ledger
     WHERE due_date IS NOT NULL
       AND due_date < CURRENT_DATE()
       AND balance_due > 0`,
    ledger.params
  );

  const [amountRows] = await connection.query(
    `SELECT currency_code, SUM(balance_due) AS amount
     FROM (${ledger.sql}) invoice_ledger
     WHERE due_date IS NOT NULL
       AND due_date < CURRENT_DATE()
       AND balance_due > 0
     GROUP BY currency_code
     ORDER BY currency_code`,
    ledger.params
  );

  return {
    count: Number(countRows[0]?.total || 0),
    outstanding_by_currency: aggregateAmounts(
      amountRows,
      ["currency_code"],
      "amount"
    ),
  };
};

const emptyMembershipMetrics = () => ({
  new_memberships: 0,
  target_count: 0,
  remaining: 0,
  progress_percent: 0,
  status_counts: [
    { status: "active", count: 0 },
    { status: "suspended", count: 0 },
    { status: "expired", count: 0 },
    { status: "cancelled", count: 0 },
  ],
  by_branch: [],
});

const emptyAttendanceMetrics = () => ({
  today_check_ins: 0,
  by_branch: [],
});

const emptyCollectionMetrics = () => ({
  monthly: { by_currency: [], by_branch: [] },
  yearly: { by_currency: [], by_branch: [], by_month: [] },
});

const getDashboardSummary = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const scope = getBranchScope(
      req,
      context,
      req.query?.branch_id
    );
    const visibility = getMetricVisibility(req);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const period = await getPeriods(connection, req.query);

    const metrics = {
      memberships: emptyMembershipMetrics(),
      attendance: emptyAttendanceMetrics(),
      collections: emptyCollectionMetrics(),
      program_collections: emptyCollectionMetrics(),
      expected_collection: { by_currency: [], by_branch: [] },
      outstanding_collection: { by_currency: [], by_branch: [] },
      overdue_members: {
        count: 0,
        outstanding_by_currency: [],
      },
    };

    // Each data group is queried only when its own permission is present.
    if (visibility.memberships) {
      metrics.memberships = await loadMembershipMetrics(
        connection,
        context,
        scope,
        period
      );
    }

    if (visibility.attendance) {
      metrics.attendance = await loadAttendanceMetrics(
        connection,
        context,
        scope
      );
    }

    if (visibility.collected) {
      metrics.collections = await loadCollectionMetrics(
        connection,
        context,
        scope,
        period
      );
    }

    if (visibility.program_collections) {
      metrics.program_collections = await loadProgramCollectionMetrics(
        connection,
        context,
        scope,
        period
      );
    }

    if (visibility.expected) {
      metrics.expected_collection = await loadExpectedCollections(
        connection,
        context,
        scope,
        period
      );
    }

    if (visibility.outstanding) {
      metrics.outstanding_collection = await loadOutstandingCollections(
        connection,
        context,
        scope
      );
    }

    if (visibility.overdue) {
      metrics.overdue_members = await loadOverdueMembers(
        connection,
        context,
        scope
      );
    }

    await writeAuditLog(
      connection,
      req,
      {
        organizationId: context.organizationId,
        branchId: context.activeBranchId,
        userId: context.userId,
      },
      {
        action: "DASHBOARD_SUMMARY_VIEWED",
        entityType: "dashboard",
        entityId: null,
        description: "Viewed the Gym Management dashboard summary.",
        metadata: {
          report_scope: scope.type,
          report_branch_ids: scope.branchIds,
          month: period.month,
          year: period.year,
          metric_visibility: visibility,
        },
      }
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      period: {
        month: period.month,
        year: period.year,
      },
      branch_scope: {
        type: scope.type,
        branch_id: scope.branchId,
        branches: scope.branches,
      },
      metric_visibility: visibility,
      metrics,
    });

  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Dashboard summary rollback failed:",
          rollbackError.message
        );
      }
    }

    if (error instanceof DashboardError) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    console.error(
      "DASHBOARD_SUMMARY_FAILED:",
      error.code || "",
      error.message
    );

    return res.status(500).json({
      success: false,
      code: "DASHBOARD_SUMMARY_FAILED",
      message: "Unable to load the Gym Management dashboard.",
    });

  } finally {
    if (connection) connection.release();
  }
};

const setMembershipTarget = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const context = getContext(req);
    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DashboardError(
        400,
        "INVALID_MEMBERSHIP_TARGET_REQUEST",
        "Request body must be a valid object."
      );
    }

    const allowedFields = new Set([
      "branch_id",
      "month",
      "target_count",
      "notes",
    ]);

    const unexpected = Object.keys(body).filter(
      (key) => !allowedFields.has(key)
    );

    if (unexpected.length) {
      throw new DashboardError(
        400,
        "UNSUPPORTED_MEMBERSHIP_TARGET_FIELDS",
        `Unsupported fields: ${unexpected.join(", ")}`
      );
    }

    const branchId = positiveId(body.branch_id);

    if (!branchId) {
      throw new DashboardError(
        400,
        "INVALID_MEMBERSHIP_TARGET_BRANCH",
        "A valid branch_id is required."
      );
    }

    const scope = getBranchScope(req, context, branchId);
    const month = parseMonth(body.month, null);

    if (
      typeof body.target_count !== "number" ||
      !Number.isSafeInteger(body.target_count) ||
      body.target_count < 0 ||
      body.target_count > 4294967295
    ) {
      throw new DashboardError(
        400,
        "INVALID_MEMBERSHIP_TARGET_COUNT",
        "target_count must be a whole number between 0 and 4294967295."
      );
    }

    let notes = null;

    if (body.notes !== undefined && body.notes !== null && body.notes !== "") {
      if (typeof body.notes !== "string" || body.notes.trim().length > 500) {
        throw new DashboardError(
          400,
          "INVALID_MEMBERSHIP_TARGET_NOTES",
          "Notes must be text with a maximum of 500 characters."
        );
      }

      notes = body.notes.trim() || null;
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const targetMonth = `${month}-01`;

    const [existingRows] = await connection.query(
      `SELECT id, target_count, notes
       FROM dashboard_membership_targets
       WHERE organization_id = ?
         AND branch_id = ?
         AND target_month = ?
       LIMIT 1
       FOR UPDATE`,
      [context.organizationId, branchId, targetMonth]
    );

    const oldTarget = existingRows[0] || null;
    let targetId;

    if (oldTarget) {
      targetId = Number(oldTarget.id);

      await connection.query(
        `UPDATE dashboard_membership_targets
         SET target_count = ?,
             notes = ?,
             updated_by_user_id = ?
         WHERE organization_id = ?
           AND branch_id = ?
           AND target_month = ?`,
        [
          body.target_count,
          notes,
          context.userId,
          context.organizationId,
          branchId,
          targetMonth,
        ]
      );
    } else {
      const [insertResult] = await connection.query(
        `INSERT INTO dashboard_membership_targets
          (
            organization_id,
            branch_id,
            target_month,
            target_count,
            notes,
            created_by_user_id,
            updated_by_user_id
          )
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          context.organizationId,
          branchId,
          targetMonth,
          body.target_count,
          notes,
          context.userId,
          context.userId,
        ]
      );

      targetId = Number(insertResult.insertId);
    }

    await writeAuditLog(
      connection,
      req,
      {
        organizationId: context.organizationId,
        branchId: context.activeBranchId,
        userId: context.userId,
      },
      {
        action: oldTarget
          ? "DASHBOARD_MEMBERSHIP_TARGET_UPDATED"
          : "DASHBOARD_MEMBERSHIP_TARGET_CREATED",
        entityType: "dashboard_membership_target",
        entityId: targetId,
        description: oldTarget
          ? "Updated a branch monthly membership target."
          : "Created a branch monthly membership target.",
        oldValues: oldTarget
          ? {
              target_count: Number(oldTarget.target_count),
              notes: oldTarget.notes,
            }
          : null,
        newValues: {
          target_count: body.target_count,
          notes,
        },
        metadata: {
          target_branch_id: branchId,
          target_month: month,
        },
      }
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: oldTarget
        ? "Monthly membership target updated successfully."
        : "Monthly membership target created successfully.",
      target: {
        id: targetId,
        branch_id: branchId,
        month,
        target_count: body.target_count,
        notes,
      },
    });

  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Membership target rollback failed:",
          rollbackError.message
        );
      }
    }

    if (error instanceof DashboardError) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        code: "MEMBERSHIP_TARGET_CONFLICT",
        message: "This branch target was updated by another request. Reload and try again.",
      });
    }

    console.error(
      "DASHBOARD_MEMBERSHIP_TARGET_FAILED:",
      error.code || "",
      error.message
    );

    return res.status(500).json({
      success: false,
      code: "DASHBOARD_MEMBERSHIP_TARGET_FAILED",
      message: "Unable to save the monthly membership target.",
    });

  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getDashboardSummary,
  setMembershipTarget,
};