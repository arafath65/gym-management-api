'use strict';

const db = require('../config/db');
const { writeAuditLog } = require('../services/gymAuditService');
const {
  ensureDueMembershipInvoicesForBranch,
} = require('./memberMembershipInvoiceController');

class CollectionsError extends Error {
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
    throw new CollectionsError(
      401,
      'MEMBER_BILLING_COLLECTIONS_SESSION_REQUIRED',
      'A valid Gym Staff session and active branch are required.'
    );
  }

  return context;
};

const parsePagination = (query) => {
  const page = query?.page === undefined ? 1 : Number(query.page);
  const pageSize = query?.page_size === undefined ? 25 : Number(query.page_size);

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    throw new CollectionsError(
      400,
      'INVALID_COLLECTION_PAGINATION',
      'page must be positive and page_size must be between 1 and 100.'
    );
  }

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
};

const hasPermission = (req, key) =>
  Array.isArray(req.gymStaff?.permissions) &&
  req.gymStaff.permissions.includes(key);

const withAuditedRead = async (req, res, config, handler) => {
  let connection;
  let started = false;

  try {
    const context = getContext(req);

    connection = await db.getConnection();
    await connection.beginTransaction();
    started = true;

    const data = await handler(connection, context);

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
        entityType: 'member_billing_collections',
        entityId: null,
        description: config.description,
        metadata: {
          report_scope: 'active_branch',
          active_branch_id: context.branchId,
          ...(data.auditMetadata || {}),
        },
      }
    );

    await connection.commit();
    started = false;

    delete data.auditMetadata;

    return res.json({
      success: true,
      ...data,
    });

  } catch (error) {
    if (connection && started) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          'Collections read rollback failed:',
          rollbackError.message
        );
      }
    }

    if (error instanceof CollectionsError) {
      return res.status(error.status).json({
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

const INVOICE_BALANCE_JOINS = `
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
  ) waivers
    ON waivers.organization_id = i.organization_id
   AND waivers.invoice_id = i.id
`;

const invoiceJoinParams = (orgId) => [
  orgId,
  orgId,
  orgId,
];

const getCollectionsSummary = (req, res) => withAuditedRead(
  req,
  res,
  {
    action: 'MEMBER_BILLING_COLLECTIONS_SUMMARY_VIEWED',
    description: 'Viewed active-branch membership billing collection summary.',
    fallbackCode: 'MEMBER_BILLING_COLLECTIONS_SUMMARY_FAILED',
    fallbackMessage: 'Unable to load the organization billing summary.',
  },

  async (connection, context) => {
    const orgId = context.organizationId;

    // Catch up recurring invoices due for this registration branch before
    // calculating billed, collected and outstanding totals.
    await ensureDueMembershipInvoicesForBranch(
      connection,
      req,
      context
    );

    // Count memberships, not individual couple participants.
    const [activeRows] = await connection.query(
      `SELECT COUNT(*) AS active_memberships
       FROM member_memberships m

       INNER JOIN members primary_member
         ON primary_member.organization_id = m.organization_id
        AND primary_member.id = m.primary_member_id
        AND primary_member.registration_branch_id = ?

       WHERE m.organization_id = ?
         AND m.status = 'active'
         AND m.start_date <= CURRENT_DATE()
         AND (m.end_date IS NULL OR m.end_date > CURRENT_DATE())

         AND EXISTS (
           SELECT 1
           FROM member_membership_members mm
           WHERE mm.organization_id = m.organization_id
             AND mm.membership_id = m.id
             AND mm.member_id = m.primary_member_id
             AND mm.member_role = 'primary'
             AND mm.status = 'active'
         )`,
      [context.branchId, orgId]
    );

    // Billed and outstanding totals from issued invoices.
const [invoiceRows] = await connection.query(
      `SELECT
         i.currency_code,
         SUM(i.total_amount) AS total_billed,

         SUM(
           GREATEST(
             i.total_amount
             - GREATEST(
                 COALESCE(ledger.allocated_amount, 0.00)
                 - COALESCE(ledger.refunded_amount, 0.00),
                 0.00
               )
             - COALESCE(waivers.waived_amount, 0.00),
             0.00
           )
         ) AS outstanding

       FROM member_membership_invoices i

       INNER JOIN member_memberships billing_membership
         ON billing_membership.organization_id = i.organization_id
        AND billing_membership.id = i.membership_id

       INNER JOIN members primary_member
         ON primary_member.organization_id = billing_membership.organization_id
        AND primary_member.id = billing_membership.primary_member_id
        AND primary_member.registration_branch_id = ?

       ${INVOICE_BALANCE_JOINS}

       WHERE i.organization_id = ?
         AND i.status = 'issued'

       GROUP BY i.currency_code
       ORDER BY i.currency_code`,
      [context.branchId, ...invoiceJoinParams(orgId), orgId]
    );

    // Net collected = posted payments less posted refunds.
    // A refund linked to a voided payment is excluded.
    const [collectionRows] = await connection.query(
      `SELECT
         currency_code,
         SUM(amount_delta) AS total_collected
       FROM (
         SELECT
           currency_code,
           SUM(amount) AS amount_delta
         FROM member_membership_payments
         WHERE organization_id = ?
           AND branch_id = ?
           AND status = 'posted'
         GROUP BY currency_code

         UNION ALL

         SELECT
           r.currency_code,
           -SUM(r.refund_amount) AS amount_delta
         FROM member_membership_refunds r

         INNER JOIN member_membership_payment_allocations a
           ON a.organization_id = r.organization_id
          AND a.id = r.payment_allocation_id

         INNER JOIN member_membership_payments p
           ON p.organization_id = a.organization_id
          AND p.id = a.payment_id
          AND p.status = 'posted'

         WHERE r.organization_id = ?
           AND r.branch_id = ?
           AND r.status = 'posted'

         GROUP BY r.currency_code
       ) net_collection_events

       GROUP BY currency_code
       ORDER BY currency_code`,
      [orgId, context.branchId, orgId, context.branchId]
    );

    const currencies = new Map();

    for (const row of invoiceRows) {
      currencies.set(row.currency_code, {
        currency_code: row.currency_code,
        total_billed: String(row.total_billed ?? '0.00'),
        total_collected: '0.00',
        outstanding: String(row.outstanding ?? '0.00'),
      });
    }

    for (const row of collectionRows) {
      const item = currencies.get(row.currency_code) || {
        currency_code: row.currency_code,
        total_billed: '0.00',
        total_collected: '0.00',
        outstanding: '0.00',
      };

      item.total_collected = String(row.total_collected ?? '0.00');
      currencies.set(row.currency_code, item);
    }

    const canActive = hasPermission(req, 'member_memberships.view');

    const canBilled = hasPermission(
      req,
      'member_billing.dashboard.expected_collection.view'
    );

    const canCollected = hasPermission(
      req,
      'member_billing.dashboard.collected_collection.view'
    );

    const canOutstanding = hasPermission(
      req,
      'member_billing.dashboard.outstanding_collection.view'
    );

    return {
      summary: {
        active_memberships: canActive
          ? Number(activeRows[0]?.active_memberships || 0)
          : null,

        financial_totals: [...currencies.values()].map((row) => ({
          currency_code: row.currency_code,
          total_billed: canBilled ? row.total_billed : null,
          total_collected: canCollected ? row.total_collected : null,
          outstanding: canOutstanding ? row.outstanding : null,
        })),
      },

      metric_visibility: {
        active_memberships: canActive,
        total_billed: canBilled,
        total_collected: canCollected,
        outstanding: canOutstanding,
      },

      report_scope: 'active_branch',

      auditMetadata: {
        view: 'collections_summary',
      },
    };
  }
);

const OUTSTANDING_INVOICE_EXISTS = `EXISTS (
    SELECT 1
    FROM member_membership_invoices due_invoice
    WHERE due_invoice.organization_id = m.organization_id
      AND due_invoice.membership_id = m.id
      AND due_invoice.status = 'issued'
      AND GREATEST(
        due_invoice.total_amount
        - GREATEST(
            COALESCE((
              SELECT SUM(due_allocation.allocated_amount)
              FROM member_membership_payment_allocations due_allocation
              INNER JOIN member_membership_payments due_payment
                ON due_payment.organization_id = due_allocation.organization_id
               AND due_payment.id = due_allocation.payment_id
               AND due_payment.status = 'posted'
              WHERE due_allocation.organization_id = due_invoice.organization_id
                AND due_allocation.invoice_id = due_invoice.id
            ), 0.00)
            - COALESCE((
              SELECT SUM(due_refund.refund_amount)
              FROM member_membership_refunds due_refund
              INNER JOIN member_membership_payment_allocations refund_allocation
                ON refund_allocation.organization_id = due_refund.organization_id
               AND refund_allocation.id = due_refund.payment_allocation_id
              INNER JOIN member_membership_payments refund_payment
                ON refund_payment.organization_id = refund_allocation.organization_id
               AND refund_payment.id = refund_allocation.payment_id
               AND refund_payment.status = 'posted'
              WHERE due_refund.organization_id = due_invoice.organization_id
                AND refund_allocation.invoice_id = due_invoice.id
                AND due_refund.status = 'posted'
            ), 0.00),
            0.00
          )
        - COALESCE((
            SELECT SUM(due_waiver.waiver_amount)
            FROM member_membership_invoice_waivers due_waiver
            WHERE due_waiver.organization_id = due_invoice.organization_id
              AND due_waiver.invoice_id = due_invoice.id
              AND due_waiver.status = 'posted'
          ), 0.00),
        0.00
      ) > 0
  )`;

const CURRENT_MEMBERSHIP_FILTER = `
  m.organization_id = ?
  AND m.membership_plan_id = ?
  AND (
    (
      m.status = 'active'
      AND m.start_date <= CURRENT_DATE()
      AND (m.end_date IS NULL OR m.end_date > CURRENT_DATE())
    )
    OR (
      -- Keep existing debt visible after a fixed-term membership expires,
      -- is suspended, or is cancelled. Financial obligations do not vanish
      -- simply because access to the gym has ended.
      m.start_date <= CURRENT_DATE()
      AND ${OUTSTANDING_INVOICE_EXISTS}
    )
  )

  AND EXISTS (
    SELECT 1
    FROM member_membership_members primary_link
    WHERE primary_link.organization_id = m.organization_id
      AND primary_link.membership_id = m.id
      AND primary_link.member_id = m.primary_member_id
      AND primary_link.member_role = 'primary'
  )

  AND EXISTS (
    SELECT 1
    FROM members branch_member
    WHERE branch_member.organization_id = m.organization_id
      AND branch_member.id = m.primary_member_id
      AND branch_member.registration_branch_id = ?
  )
`;
const periodLabel = (row) => {
  if (row.billing_mode_snapshot === 'attendance') return 'Pay per attendance';
  const ongoing = row.validity_type_snapshot === 'ongoing';

  const value = Number(
    ongoing
      ? row.billing_interval_value_snapshot
      : row.duration_value_snapshot
  );

  const unit = ongoing
    ? row.billing_interval_unit_snapshot
    : row.duration_unit_snapshot;

  if (!Number.isSafeInteger(value) || value < 1 || !unit) {
    return '—';
  }

  if (ongoing && value === 1 && unit === 'month') return 'Monthly';
  if (ongoing && value === 1 && unit === 'year') return 'Yearly';
  if (ongoing && value === 1 && unit === 'day') return 'Daily';

  return `${ongoing ? 'Every ' : ''}${value} ${
    value === 1 ? unit : `${unit}s`
  }`;
};

const getMembershipPlanCollections = (req, res) => withAuditedRead(
  req,
  res,
  {
    action: 'MEMBERSHIP_PLAN_COLLECTIONS_VIEWED',
    description: 'Viewed paginated membership collections for a plan.',
    fallbackCode: 'MEMBERSHIP_PLAN_COLLECTIONS_FAILED',
    fallbackMessage: 'Unable to load membership plan collections.',
  },

  async (connection, context) => {
    const planId = positiveId(req.query?.plan_id);

    if (!planId) {
      throw new CollectionsError(
        400,
        'INVALID_MEMBERSHIP_PLAN_ID',
        'plan_id must be a positive integer.'
      );
    }

    const pagination = parsePagination(req.query);
    const orgId = context.organizationId;

    const [plans] = await connection.query(
      `SELECT id, plan_code, name, package_type, validity_type, billing_mode, plan_category
       FROM membership_plans
       WHERE organization_id = ?
         AND id = ?
         AND plan_category = 'membership'
         AND status = 'active'
       LIMIT 1`,
      [orgId, planId]
    );

    if (!plans.length) {
      throw new CollectionsError(
        404,
        'ACTIVE_MEMBERSHIP_PLAN_NOT_FOUND',
        'The selected active membership plan was not found in this organization.'
      );
    }

    await ensureDueMembershipInvoicesForBranch(
      connection,
      req,
      context,
      planId
    );

    // Attendance plans are listed in Collections only while at least one
    // attendance invoice remains unpaid. A member with no visits or fully
    // settled visits must not appear as owing money.
    const attendanceDueOnlyFilter = plans[0].billing_mode === 'attendance'
      ? `AND ${OUTSTANDING_INVOICE_EXISTS}`
      : '';
    const membershipFilter = `${CURRENT_MEMBERSHIP_FILTER}
  ${attendanceDueOnlyFilter}`;

    const [countRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM member_memberships m
       WHERE ${membershipFilter}`,
      [orgId, planId, context.branchId]
    );
const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(
      1,
      Math.ceil(total / pagination.pageSize)
    );

    const page = Math.min(pagination.page, totalPages);
    const offset = (page - 1) * pagination.pageSize;

    const sql = `
      WITH target_memberships AS (
        SELECT
          m.id,
          m.organization_id,
          m.primary_member_id,
          m.status,
          m.plan_code_snapshot,
          m.plan_name_snapshot,
          m.package_type_snapshot,
          m.validity_type_snapshot,
          m.billing_mode_snapshot,
          m.duration_value_snapshot,
          m.duration_unit_snapshot,
          m.billing_interval_value_snapshot,
          m.billing_interval_unit_snapshot,
          m.price_snapshot,
          m.currency_code_snapshot
        FROM member_memberships m
        WHERE ${membershipFilter}
      ),

      refunds_by_allocation AS (
        SELECT
          organization_id,
          payment_allocation_id,
          SUM(refund_amount) AS refunded_amount
        FROM member_membership_refunds
        WHERE organization_id = ?
          AND status = 'posted'
        GROUP BY organization_id, payment_allocation_id
      ),

      allocations_by_invoice AS (
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
        LEFT JOIN refunds_by_allocation r
          ON r.organization_id = a.organization_id
         AND r.payment_allocation_id = a.id
        WHERE a.organization_id = ?
        GROUP BY a.organization_id, a.invoice_id
      ),

      waivers_by_invoice AS (
        SELECT
          organization_id,
          invoice_id,
          SUM(waiver_amount) AS waived_amount
        FROM member_membership_invoice_waivers
        WHERE organization_id = ?
          AND status = 'posted'
        GROUP BY organization_id, invoice_id
      ),

      invoice_financials AS (
        SELECT
          i.organization_id,
          i.membership_id,
          i.due_date,
          i.billing_period_start,
          i.total_amount,

          GREATEST(
            COALESCE(a.allocated_amount, 0.00)
            - COALESCE(a.refunded_amount, 0.00),
            0.00
          ) AS net_paid,

          GREATEST(
            i.total_amount
            - GREATEST(
                COALESCE(a.allocated_amount, 0.00)
                - COALESCE(a.refunded_amount, 0.00),
                0.00
              )
            - COALESCE(w.waived_amount, 0.00),
            0.00
          ) AS balance_due

        FROM member_membership_invoices i

        INNER JOIN target_memberships tm
          ON tm.organization_id = i.organization_id
         AND tm.id = i.membership_id

        LEFT JOIN allocations_by_invoice a
          ON a.organization_id = i.organization_id
         AND a.invoice_id = i.id

        LEFT JOIN waivers_by_invoice w
          ON w.organization_id = i.organization_id
         AND w.invoice_id = i.id

        WHERE i.organization_id = ?
          AND i.status = 'issued'
      ),

      membership_financials AS (
        SELECT
          organization_id,
          membership_id,
          COUNT(*) AS invoice_count,
          SUM(total_amount) AS total_billed,
          SUM(net_paid) AS net_paid,
          SUM(balance_due) AS outstanding,

          SUM(
            CASE WHEN balance_due > 0 THEN 1 ELSE 0 END
          ) AS unpaid_invoice_count,

          MIN(
            CASE WHEN balance_due > 0 THEN billing_period_start ELSE NULL END
          ) AS earliest_unpaid_period_start,

          MAX(
            CASE WHEN balance_due > 0 THEN billing_period_start ELSE NULL END
          ) AS latest_unpaid_period_start

        FROM invoice_financials
        GROUP BY organization_id, membership_id
      ),

      active_participants AS (
        SELECT
          mm.organization_id,
          mm.membership_id,
          COUNT(*) AS active_participant_count,

          GROUP_CONCAT(
            CASE
              WHEN mm.member_role = 'included'
              THEN CONCAT(
                participant.full_name,
                ' (',
                COALESCE(participant.member_code, '—'),
                ')'
              )
              ELSE NULL
            END
            ORDER BY participant.full_name SEPARATOR ', '
          ) AS included_members

        FROM member_membership_members mm

        INNER JOIN target_memberships tm
          ON tm.organization_id = mm.organization_id
         AND tm.id = mm.membership_id

        INNER JOIN members participant
          ON participant.organization_id = mm.organization_id
         AND participant.id = mm.member_id

        WHERE mm.status = 'active'

        GROUP BY mm.organization_id, mm.membership_id
      )

      SELECT
        tm.id AS membership_id,
        tm.primary_member_id AS member_id,
        tm.status AS membership_status,

        primary_member.member_code,
        primary_member.full_name AS member_name,

        tm.plan_code_snapshot AS plan_code,
        tm.plan_name_snapshot AS plan_name,
        tm.package_type_snapshot AS package_type,
        tm.validity_type_snapshot,
        tm.billing_mode_snapshot,
        tm.duration_value_snapshot,
        tm.duration_unit_snapshot,
        tm.billing_interval_value_snapshot,
        tm.billing_interval_unit_snapshot,

        tm.price_snapshot AS fee,
        tm.currency_code_snapshot AS currency_code,

        COALESCE(ap.active_participant_count, 1)
          AS active_participant_count,

        ap.included_members,

        COALESCE(mf.invoice_count, 0) AS invoice_count,
        COALESCE(mf.total_billed, 0.00) AS total_billed,
        COALESCE(mf.net_paid, 0.00) AS net_paid,
        COALESCE(mf.outstanding, 0.00) AS outstanding,
        COALESCE(mf.unpaid_invoice_count, 0) AS unpaid_invoice_count,

        DATE_FORMAT(
          mf.earliest_unpaid_period_start,
          '%Y-%m-%d'
        ) AS due_period_start,

        DATE_FORMAT(
          mf.latest_unpaid_period_start,
          '%Y-%m-%d'
        ) AS due_period_end

      FROM target_memberships tm

      INNER JOIN members primary_member
        ON primary_member.organization_id = tm.organization_id
       AND primary_member.id = tm.primary_member_id

      LEFT JOIN membership_financials mf
        ON mf.organization_id = tm.organization_id
       AND mf.membership_id = tm.id

      LEFT JOIN active_participants ap
        ON ap.organization_id = tm.organization_id
       AND ap.membership_id = tm.id

      ORDER BY primary_member.full_name ASC, tm.id DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.query(sql, [
      orgId,
      planId,
      context.branchId,
      orgId,
      orgId,
      orgId,
      orgId,
      pagination.pageSize,
      offset,
    ]);

    const collections = rows.map((row) => {
      const invoiceCount = Number(row.invoice_count || 0);
      const unpaidCount = Number(row.unpaid_invoice_count || 0);

      const outstanding = String(row.outstanding ?? '0.00');

      return {
        membership_id: Number(row.membership_id),
        member_id: Number(row.member_id),
        membership_status: row.membership_status,
        member_code: row.member_code,
        member_name: row.member_name,

        plan_code: row.plan_code,
        plan_name: row.plan_name,
        package_type: row.package_type,
        plan_period: periodLabel(row),

        fee: String(row.fee),
        currency_code: row.currency_code,

        total_billed: String(row.total_billed ?? '0.00'),
        net_paid: String(row.net_paid ?? '0.00'),
        outstanding,

        due_period_start: row.due_period_start,
        due_period_end: row.due_period_end,

        invoice_count: invoiceCount,
        unpaid_invoice_count: unpaidCount,

        billing_state: invoiceCount === 0
          ? 'not_yet_billed'
          : (
            Number(outstanding) > 0
              ? 'outstanding'
              : 'settled'
          ),

        active_participant_count: Number(
          row.active_participant_count || 1
        ),

        included_members: row.included_members || null,
      };
    });

    return {
      plan: {
        id: Number(plans[0].id),
        plan_code: plans[0].plan_code,
        name: plans[0].name,
        package_type: plans[0].package_type,
        validity_type: plans[0].validity_type,
        billing_mode: plans[0].billing_mode || 'standard',
      },

      collections,

      pagination: {
        page,
        page_size: pagination.pageSize,
        total,
        total_pages: totalPages,
      },

      report_scope: 'active_branch',

      auditMetadata: {
        view: 'membership_plan_collections',
        membership_plan_id: planId,
        page,
        page_size: pagination.pageSize,
      },
    };
  }
);

// GET /api/members/billing/program-assignments
// Read-only branch-scoped report. Program assignments have no
// membership financial ledger, so this endpoint returns status
// and date information only.
const getProgramAssignmentReport = (req, res) => withAuditedRead(
  req,
  res,
  {
    action: 'PROGRAM_ASSIGNMENT_REPORT_VIEWED',
    description: 'Viewed branch-scoped program assignment report.',
    fallbackCode: 'PROGRAM_ASSIGNMENT_REPORT_FAILED',
    fallbackMessage: 'Unable to load program assignment report.',
  },

  async (connection, context) => {
    const rawProgramId = req.query?.program_id;
    const normalizedProgramId = rawProgramId == null
      ? ''
      : String(rawProgramId).trim();

    const programId = normalizedProgramId
      ? positiveId(normalizedProgramId)
      : null;

    if (normalizedProgramId && !programId) {
      throw new CollectionsError(
        400,
        'INVALID_PROGRAM_ID',
        'program_id must be a positive integer.'
      );
    }

    const pagination = parsePagination(req.query);
    const orgId = context.organizationId;

    let program = null;

    if (programId) {
      const [programRows] = await connection.query(
        `SELECT id, plan_code, name
         FROM membership_plans
         WHERE organization_id = ?
           AND id = ?
           AND plan_category = 'program'
         LIMIT 1`,
        [orgId, programId]
      );

      if (!programRows.length) {
        throw new CollectionsError(
          404,
          'PROGRAM_NOT_FOUND',
          'The selected program was not found in this organization.'
        );
      }

      program = {
        id: Number(programRows[0].id),
        plan_code: programRows[0].plan_code,
        name: programRows[0].name,
      };
    }

    const filters = [
      'mpa.organization_id = ?',
      'mpa.branch_id = ?',
    ];

    const params = [orgId, context.branchId];

    if (programId) {
      filters.push('mpa.membership_plan_id = ?');
      params.push(programId);
    }

    const whereSql = filters.join('\n       AND ');

    const [countRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM member_program_assignments mpa
       WHERE ${whereSql}`,
      params
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(
      1,
      Math.ceil(total / pagination.pageSize)
    );

    const page = Math.min(pagination.page, totalPages);
    const offset = (page - 1) * pagination.pageSize;

    const [rows] = await connection.query(
      `SELECT
         mpa.id AS assignment_id,
         mpa.member_id,
         member.member_code,
         member.full_name AS member_name,
         mpa.program_id,
         mpa.membership_plan_id,
         mpa.branch_id,

         COALESCE(
           mp.plan_code,
           mpa.program_code_snapshot
         ) AS program_code,

         COALESCE(
           mp.name,
           mpa.program_name_snapshot
         ) AS program_name,

         mpa.duration_value_snapshot AS duration_value,
         mpa.duration_unit_snapshot AS duration_unit,

         mpa.fee_snapshot AS fee,
         mpa.currency_code_snapshot AS currency_code,
         mpa.price_configured_snapshot AS price_configured,

         mpi.id AS invoice_id,
         mpi.invoice_number,
         COALESCE(mpi.total_amount, 0.00) AS total_billed,
         COALESCE(program_payment_totals.net_paid, 0.00) AS net_paid,

         CASE
           WHEN mpi.status = 'issued'
           THEN GREATEST(
             COALESCE(mpi.total_amount, 0.00)
             - COALESCE(program_payment_totals.net_paid, 0.00),
             0.00
           )
           ELSE 0.00
         END AS outstanding,

         CASE
           WHEN mpi.id IS NULL AND mpa.price_configured_snapshot = 1
             THEN 'not_invoiced'
           WHEN mpi.id IS NULL
             THEN 'not_configured'
           WHEN mpi.status <> 'issued'
             THEN mpi.status
           WHEN COALESCE(program_payment_totals.net_paid, 0.00) >= mpi.total_amount
             THEN 'paid'
           WHEN COALESCE(program_payment_totals.net_paid, 0.00) > 0
             THEN 'partially_paid'
           ELSE 'unpaid'
         END AS billing_state,

         DATE_FORMAT(mpa.start_date, '%Y-%m-%d') AS start_date,
         DATE_FORMAT(mpa.expected_end_date, '%Y-%m-%d') AS expected_end_date,
         mpa.status,
         DATE_FORMAT(mpa.completed_on, '%Y-%m-%d') AS completed_on,
         DATE_FORMAT(mpa.cancelled_on, '%Y-%m-%d') AS cancelled_on,

         (
           SELECT DATE_FORMAT(pause_row.paused_on, '%Y-%m-%d')
           FROM member_program_assignment_pauses pause_row
           WHERE pause_row.organization_id = mpa.organization_id
             AND pause_row.assignment_id = mpa.id
             AND pause_row.resumed_at IS NULL
             AND pause_row.closed_at IS NULL
           ORDER BY pause_row.id DESC
           LIMIT 1
         ) AS current_pause_on,

         mpa.created_at

       FROM member_program_assignments mpa

       INNER JOIN members member
         ON member.organization_id = mpa.organization_id
        AND member.id = mpa.member_id

       LEFT JOIN membership_plans mp
         ON mp.organization_id = mpa.organization_id
        AND mp.id = mpa.membership_plan_id
        AND mp.plan_category = 'program'

       LEFT JOIN member_program_invoices mpi
         ON mpi.organization_id = mpa.organization_id
        AND mpi.assignment_id = mpa.id

       LEFT JOIN (
         SELECT
           organization_id,
           invoice_id,
           SUM(amount) AS net_paid
         FROM member_program_payments
         WHERE status = 'posted'
         GROUP BY organization_id, invoice_id
       ) program_payment_totals
         ON program_payment_totals.organization_id = mpi.organization_id
        AND program_payment_totals.invoice_id = mpi.id

       WHERE ${whereSql}

       ORDER BY mpa.start_date DESC, mpa.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, offset]
    );

    const assignments = rows.map((row) => ({
      assignment_id: Number(row.assignment_id),
      member_id: Number(row.member_id),
      member_code: row.member_code,
      member_name: row.member_name,

      program_id: row.program_id == null
        ? null
        : Number(row.program_id),

      membership_plan_id: row.membership_plan_id == null
        ? null
        : Number(row.membership_plan_id),

      branch_id: Number(row.branch_id),
      program_code: row.program_code,
      program_name: row.program_name,

      duration_value: Number(row.duration_value),
      duration_unit: row.duration_unit,

      fee: row.fee == null ? null : String(row.fee),
      currency_code: row.currency_code || null,
      price_configured: Number(row.price_configured) === 1,

      invoice_id: row.invoice_id == null ? null : Number(row.invoice_id),
      invoice_number: row.invoice_number || null,
      total_billed: String(row.total_billed ?? '0.00'),
      net_paid: String(row.net_paid ?? '0.00'),
      outstanding: String(row.outstanding ?? '0.00'),
      billing_state: row.billing_state,

      start_date: row.start_date,
      expected_end_date: row.expected_end_date,
      status: row.status,
      completed_on: row.completed_on,
      cancelled_on: row.cancelled_on,
      current_pause_on: row.current_pause_on,
      created_at: row.created_at,
    }));

    return {
      program,
      assignments,
      pagination: {
        page,
        page_size: pagination.pageSize,
        total,
        total_pages: totalPages,
      },
      report_scope: 'active_branch',
      auditMetadata: {
        view: 'program_assignment_report',
        program_id: programId,
        page,
        page_size: pagination.pageSize,
      },
    };
  }
);
module.exports = {
  getCollectionsSummary,
  getMembershipPlanCollections,
  getProgramAssignmentReport,
};