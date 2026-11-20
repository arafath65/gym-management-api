'use strict';

const db = require('../src/config/db');
const {
  createMembershipInvoice,
} = require('../src/controllers/memberMembershipInvoiceController');

async function main() {
  if (process.argv[2] !== '--execute') {
    throw new Error('Run with --execute to create the test invoice.');
  }

  const organizationId = 3;
  const membershipId = 2;

  const [memberships] = await db.query(
    `SELECT
       organization_id,
       id,
       primary_member_id,
       branch_id,
       created_by_user_id,
       status
     FROM member_memberships
     WHERE organization_id = ?
       AND id = ?
     LIMIT 1`,
    [organizationId, membershipId]
  );

  if (!memberships.length) {
    throw new Error('Test membership was not found.');
  }

  const membership = memberships[0];

  if (membership.status !== 'active') {
    throw new Error('Test membership is not active.');
  }

  const [existing] = await db.query(
    `SELECT id, invoice_number
     FROM member_membership_invoices
     WHERE organization_id = ?
       AND membership_id = ?
     LIMIT 1`,
    [organizationId, membershipId]
  );

  if (existing.length) {
    throw new Error(
      `An invoice already exists: ${existing[0].invoice_number}. ` +
      'No second invoice was created.'
    );
  }

  const req = {
    params: {
      memberId: String(membership.primary_member_id),
      membershipId: String(membership.id),
    },
    gymStaff: {
      organizationId: Number(membership.organization_id),
      branchId: Number(membership.branch_id),
      userId: Number(membership.created_by_user_id),
    },
    body: {},
    ip: '127.0.0.1',
    get: (header) =>
      header.toLowerCase() === 'user-agent'
        ? 'Innovex Billing Controller Integration Test'
        : null,
  };

  const res = {
    statusCode: 200,
    payload: null,

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  await createMembershipInvoice(req, res);

  if (res.statusCode !== 201 || !res.payload?.success) {
    throw new Error(
      `Invoice creation failed (HTTP ${res.statusCode}): ` +
      JSON.stringify(res.payload)
    );
  }

  const invoice = res.payload.invoice;

  const [auditRows] = await db.query(
    `SELECT
       id,
       action,
       entity_type,
       entity_id,
       branch_id,
       user_id
     FROM audit_logs
     WHERE organization_id = ?
       AND action = 'MEMBER_MEMBERSHIP_INVOICE_ISSUED'
       AND entity_type = 'member_membership_invoice'
       AND entity_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [organizationId, invoice.id]
  );

  console.log('\n===== INVOICE CREATION TEST SUCCESSFUL =====');
  console.log({
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    organization_id: invoice.organization_id,
    membership_id: invoice.membership_id,
    billing_period_start: invoice.billing_period_start,
    billing_period_end: invoice.billing_period_end,
    invoice_date: invoice.invoice_date,
    total_amount: invoice.total_amount,
    currency_code: invoice.currency_code,
    payment_status: invoice.payment_status,
    balance_due: invoice.balance_due,
    invoice_status: invoice.status,
  });

  if (!auditRows.length) {
    throw new Error(
      'Invoice exists, but its audit record could not be found.'
    );
  }

  console.log('\n===== AUDIT LOG VERIFIED =====');
  console.table(auditRows);
}

main()
  .catch((error) => {
    console.error('\nINVOICE TEST FAILED:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
