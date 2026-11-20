'use strict';

const db = require('../src/config/db');

const {
  createMemberPaymentRefund,
} = require('../src/controllers/memberMembershipRefundController');

const ORG_ID = 3;
const MEMBER_ID = 2;
const MEMBERSHIP_ID = 2;
const INVOICE_ID = 1;
const PAYMENT_ID = 1;

const IDEMPOTENCY_KEY = '7ccf4f68-4a6a-4c3e-9b2e-8eaa2c7b6e40';

const requestBody = {
  refund_amount: '100.00',
  refund_method: 'cash',
  refund_reference: null,
  reason: 'Refund idempotency integration test',
  notes: 'Testing exact refund retry',
  idempotency_key: IDEMPOTENCY_KEY,
};

async function callRefund(membership, body) {
  const req = {
    params: {
      memberId: String(MEMBER_ID),
      membershipId: String(MEMBERSHIP_ID),
      invoiceId: String(INVOICE_ID),
      paymentId: String(PAYMENT_ID),
    },

    gymStaff: {
      organizationId: ORG_ID,
      branchId: Number(membership.branch_id),
      userId: Number(membership.created_by_user_id),
    },

    body,
    ip: '127.0.0.1',

    get(header) {
      return header.toLowerCase() === 'user-agent'
        ? 'Innovex Refund Idempotency Test'
        : null;
    },
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

  await createMemberPaymentRefund(req, res);
  return res;
}

async function main() {
  const [membershipRows] = await db.query(
    `SELECT
       id,
       primary_member_id,
       branch_id,
       created_by_user_id
     FROM member_memberships
     WHERE organization_id = ?
       AND id = ?
       AND primary_member_id = ?
     LIMIT 1`,
    [ORG_ID, MEMBERSHIP_ID, MEMBER_ID]
  );

  if (!membershipRows.length) {
    throw new Error('Test membership was not found.');
  }

  const membership = membershipRows[0];

  const [paymentRows] = await db.query(
    `SELECT
       p.id,
       p.status,
       p.payment_number,
       a.id AS allocation_id
     FROM member_membership_payments p
     INNER JOIN member_membership_payment_allocations a
       ON a.organization_id = p.organization_id
      AND a.payment_id = p.id
     WHERE p.organization_id = ?
       AND p.id = ?
       AND a.invoice_id = ?
     LIMIT 1`,
    [ORG_ID, PAYMENT_ID, INVOICE_ID]
  );

  if (
    !paymentRows.length ||
    paymentRows[0].status !== 'posted'
  ) {
    throw new Error('The test payment is not available.');
  }

  // Test 1: Create the refund, or retrieve it on a safe rerun.
  const first = await callRefund(membership, requestBody);

  if (
    ![200, 201].includes(first.statusCode) ||
    !first.payload?.success
  ) {
    throw new Error(
      `First refund request failed (${first.statusCode}): ` +
      JSON.stringify(first.payload)
    );
  }

  const refundId = Number(first.payload.refund.id);
  const refundNumber = first.payload.refund.refund_number;

  if (
    first.payload.refund.refund_amount !== '100.00' ||
    first.payload.refund.status !== 'posted'
  ) {
    throw new Error('Unexpected refund values.');
  }

  console.log('\n===== FIRST REFUND REQUEST PASSED =====');
  console.log({
    http_status: first.statusCode,
    refund_id: refundId,
    refund_number: refundNumber,
    amount: first.payload.refund.refund_amount,
    idempotent_replay: first.payload.idempotent_replay,
    invoice_balance: first.payload.invoice_balance,
  });

  // Test 2: Exact retry must return the original refund.
  const retry = await callRefund(membership, requestBody);

  if (
    retry.statusCode !== 200 ||
    retry.payload?.idempotent_replay !== true ||
    Number(retry.payload.refund.id) !== refundId
  ) {
    throw new Error(
      'Exact retry did not return the original refund: ' +
      JSON.stringify(retry.payload)
    );
  }

  console.log('\n===== REFUND IDEMPOTENCY TEST PASSED =====');
  console.log({
    http_status: retry.statusCode,
    idempotent_replay: retry.payload.idempotent_replay,
    original_refund_id: retry.payload.refund.id,
    refund_number: retry.payload.refund.refund_number,
  });

  // Test 3: Same UUID with a different amount must be rejected.
  const mismatch = await callRefund(
    membership,
    {
      ...requestBody,
      refund_amount: '101.00',
    }
  );

  if (
    mismatch.statusCode !== 409 ||
    mismatch.payload?.code !== 'REFUND_IDEMPOTENCY_KEY_REUSED'
  ) {
    throw new Error(
      'Different request using the same key was not rejected: ' +
      JSON.stringify(mismatch.payload)
    );
  }

  console.log('\n===== IDEMPOTENCY KEY REUSE PROTECTION PASSED =====');
  console.log({
    attempted_amount: '101.00',
    original_amount: '100.00',
    http_status: mismatch.statusCode,
    rejection_code: mismatch.payload.code,
  });

  // Final verification: one database refund and one posting audit.
  const [refundRows] = await db.query(
    `SELECT
       id,
       refund_number,
       refund_amount,
       status,
       idempotency_key
     FROM member_membership_refunds
     WHERE organization_id = ?
       AND idempotency_key = ?
     LIMIT 2`,
    [ORG_ID, IDEMPOTENCY_KEY]
  );

  if (
    refundRows.length !== 1 ||
    Number(refundRows[0].id) !== refundId ||
    String(refundRows[0].refund_amount) !== '100.00' ||
    refundRows[0].status !== 'posted'
  ) {
    throw new Error('Refund database uniqueness verification failed.');
  }

  const [auditRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM audit_logs
     WHERE organization_id = ?
       AND action = 'MEMBER_MEMBERSHIP_REFUND_POSTED'
       AND entity_type = 'member_membership_refund'
       AND entity_id = ?`,
    [ORG_ID, refundId]
  );

  if (Number(auditRows[0].total) !== 1) {
    throw new Error('Refund posting audit verification failed.');
  }

  const [balanceRows] = await db.query(
    `SELECT
       i.total_amount,

       COALESCE((
         SELECT SUM(a.allocated_amount)
         FROM member_membership_payment_allocations a
         INNER JOIN member_membership_payments p
           ON p.organization_id = a.organization_id
          AND p.id = a.payment_id
          AND p.status = 'posted'
         WHERE a.organization_id = i.organization_id
           AND a.invoice_id = i.id
       ), 0.00) AS allocated_amount,

       COALESCE((
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
       ), 0.00) AS refunded_amount

     FROM member_membership_invoices i
     WHERE i.organization_id = ?
       AND i.id = ?
     LIMIT 1`,
    [ORG_ID, INVOICE_ID]
  );

  const balance = balanceRows[0];

  const outstanding =
    Number(balance.total_amount) -
    Number(balance.allocated_amount) +
    Number(balance.refunded_amount);

  if (
    String(balance.allocated_amount) !== '1000.00' ||
    String(balance.refunded_amount) !== '100.00' ||
    outstanding.toFixed(2) !== '2900.00'
  ) {
    throw new Error('Invoice refund balance verification failed.');
  }

  console.log('\n===== FINAL REFUND VERIFICATION =====');
  console.table([{
    refund_count_for_key: refundRows.length,
    refund_id: refundId,
    refund_number: refundNumber,
    refund_amount: String(refundRows[0].refund_amount),
    refund_status: refundRows[0].status,
    audit_count: Number(auditRows[0].total),
    invoice_total: String(balance.total_amount),
    allocated_payment: String(balance.allocated_amount),
    posted_refunds: String(balance.refunded_amount),
    outstanding_balance: outstanding.toFixed(2),
  }]);

  console.log('\n===== ALL REFUND IDEMPOTENCY TESTS PASSED =====');
}

main()
  .catch((error) => {
    console.error('\nREFUND IDEMPOTENCY TEST FAILED:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
