'use strict';

const db = require('../config/db');
const { writeAuditLog } = require('../services/gymAuditService');

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

const CURRENT_MEMBERSHIP_FILTER = `
  m.organization_id = ?
  AND m.membership_plan_id = ?
  AND m.status = 'active'
  AND m.start_date <= CURRENT_DATE()
  AND (m.end_date IS NULL OR m.end_date > CURRENT_DATE())

  AND EXISTS (
    SELECT 1
    FROM member_membership_members primary_link
    WHERE primary_link.organization_id = m.organization_id
      AND primary_link.membership_id = m.id
      AND primary_link.member_id = m.primary_member_id
      AND primary_link.member_role = 'primary'
      AND primary_link.status = 'active'
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
      `SELECT id, plan_code, name, package_type, validity_type
       FROM membership_plans
       WHERE organization_id = ?
         AND id = ?
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

    const [countRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM member_memberships m
       WHERE ${CURRENT_MEMBERSHIP_FILTER}`,
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
          m.plan_code_snapshot,
          m.plan_name_snapshot,
          m.package_type_snapshot,
          m.validity_type_snapshot,
          m.duration_value_snapshot,
          m.duration_unit_snapshot,
          m.billing_interval_value_snapshot,
          m.billing_interval_unit_snapshot,
          m.price_snapshot,
          m.currency_code_snapshot,
          m.next_billing_date
        FROM member_memberships m
        WHERE ${CURRENT_MEMBERSHIP_FILTER}
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
            CASE WHEN balance_due > 0 THEN due_date ELSE NULL END
          ) AS earliest_unpaid_due_date

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

        primary_member.member_code,
        primary_member.full_name AS member_name,

        tm.plan_code_snapshot AS plan_code,
        tm.plan_name_snapshot AS plan_name,
        tm.package_type_snapshot AS package_type,
        tm.validity_type_snapshot,
        tm.duration_value_snapshot,
        tm.duration_unit_snapshot,
        tm.billing_interval_value_snapshot,
        tm.billing_interval_unit_snapshot,

        tm.price_snapshot AS fee,
        tm.currency_code_snapshot AS currency_code,

        DATE_FORMAT(
          tm.next_billing_date,
          '%Y-%m-%d'
        ) AS next_billing_date,

        COALESCE(ap.active_participant_count, 1)
          AS active_participant_count,

        ap.included_members,

        COALESCE(mf.invoice_count, 0) AS invoice_count,
        COALESCE(mf.total_billed, 0.00) AS total_billed,
        COALESCE(mf.net_paid, 0.00) AS net_paid,
        COALESCE(mf.outstanding, 0.00) AS outstanding,
        COALESCE(mf.unpaid_invoice_count, 0) AS unpaid_invoice_count,

        DATE_FORMAT(
          mf.earliest_unpaid_due_date,
          '%Y-%m-%d'
        ) AS earliest_unpaid_due_date

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

      const nextDue = unpaidCount > 0
        ? row.earliest_unpaid_due_date
        : (
          row.validity_type_snapshot === 'ongoing'
            ? row.next_billing_date
            : null
        );

      const outstanding = String(row.outstanding ?? '0.00');

      return {
        membership_id: Number(row.membership_id),
        member_id: Number(row.member_id),
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

        next_due_date: nextDue,

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

module.exports = {
  getCollectionsSummary,
  getMembershipPlanCollections,
};