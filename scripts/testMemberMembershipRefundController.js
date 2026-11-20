'use strict';

const db = require('../src/config/db');

const {
  createMemberPaymentRefund,
  voidMemberPaymentRefund,
} = require('../src/controllers/memberMembershipRefundController');

const ORG_ID = 3;
const MEMBER_ID = 2;
const MEMBERSHIP_ID = 2;
const INVOICE_ID = 1;
const PAYMENT_ID = 1;

const REFUND_REASON = 'Integration test partial refund';
const VOID_REASON = 'Integration test refund reversal';

async function callController(controller, membership, body, refundId = null) {
  const req = {
    params: {
      memberId: String(MEMBER_ID),
      membershipId: String(MEMBERSHIP_ID),
      invoiceId: String(INVOICE_ID),
      paymentId: String(PAYMENT_ID),
      ...(refundId ? { refundId: String(refundId) } : {}),
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
        ? 'Innovex Refund Integration Test'
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

  await controller(req, res);
  return res;
}

async function main() {
  const [membershipRows] = await db.query(
    `SELECT
       organization_id,
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
       p.payment_number,
       p.payer_member_id,
       p.amount,
       p.currency_code,
       p.status AS payment_status,
       a.id AS allocation_id,
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
       AND a.invoice_id = ?
       AND i.membership_id = ?
     LIMIT 1`,
    [ORG_ID, PAYMENT_ID, INVOICE_ID, MEMBERSHIP_ID]
  );

  if (!paymentRows.length) {
    throw new Error('Test payment allocation was not found.');
  }

  const payment = paymentRows[0];

  if (
    payment.payment_status !== 'posted' ||
    String(payment.amount) !== '1000.00' ||
    String(payment.allocated_amount) !== '1000.00' ||
    Number(payment.payer_member_id) !== MEMBER_ID
  ) {
    throw new Error('Original payment does not match the expected test receipt.');
  }

  const [existingRefunds] = await db.query(
    `SELECT
       id,
       refund_number,
       refund_amount,
       reason,
       status
     FROM member_membership_refunds
     WHERE organization_id = ?
       AND payment_allocation_id = ?
     ORDER BY id`,
    [ORG_ID, payment.allocation_id]
  );

  let refundId = null;
  let refundAlreadyVoided = false;

  if (existingRefunds.length > 1) {
    throw new Error(
      'Multiple refunds already exist for this allocation. Aborting test.'
    );
  }

  if (existingRefunds.length === 1) {
    const existing = existingRefunds[0];

    if (
      existing.reason !== REFUND_REASON ||
      String(existing.refund_amount) !== '400.00'
    ) {
      throw new Error(
        'An unrelated refund exists for this allocation. Aborting test.'
      );
    }

    refundId = Number(existing.id);
    refundAlreadyVoided = existing.status === 'voided';

    console.log('Existing test refund found:', {
      refund_id: refundId,
      refund_number: existing.refund_number,
      status: existing.status,
    });
  }

  // Test 1: create the LKR 400 partial refund.
  if (!refundId) {
    const created = await callController(
      createMemberPaymentRefund,
      membership,
      {
        refund_amount: '400.00',
        refund_method: 'cash',
        refund_reference: null,
        reason: REFUND_REASON,
        notes: 'Integration test partial refund',
      }
    );

    if (created.statusCode !== 201 || !created.payload?.success) {
      throw new Error(
        `Refund creation failed (${created.statusCode}): ` +
        JSON.stringify(created.payload)
      );
    }

    refundId = Number(created.payload.refund.id);

    if (
      created.payload.refund.refund_amount !== '400.00' ||
      created.payload.refund.status !== 'posted' ||
      created.payload.invoice_balance.balance_due !== '3200.00' ||
      created.payload.invoice_balance.payment_status !== 'partially_paid' ||
      created.payload.refundable_balance.refundable_amount !== '600.00'
    ) {
      throw new Error(
        'Partial refund response did not match the expected balances.'
      );
    }

    console.log('\n===== PARTIAL REFUND TEST PASSED =====');
    console.log({
      http_status: created.statusCode,
      refund_number: created.payload.refund.refund_number,
      refund_id: refundId,
      refund_amount: created.payload.refund.refund_amount,
      refund_status: created.payload.refund.status,
      remaining_refundable:
        created.payload.refundable_balance.refundable_amount,
      invoice_balance: created.payload.invoice_balance,
    });
  } else {
    console.log('\nPartial refund creation was already completed.');
  }

  // Test 2: void the test refund.
  if (!refundAlreadyVoided) {
    const voided = await callController(
      voidMemberPaymentRefund,
      membership,
      { reason: VOID_REASON },
      refundId
    );

    if (voided.statusCode !== 200 || !voided.payload?.success) {
      throw new Error(
        `Refund void failed (${voided.statusCode}): ` +
        JSON.stringify(voided.payload)
      );
    }

    if (
      voided.payload.refund.status !== 'voided' ||
      voided.payload.invoice_balance.balance_due !== '2800.00' ||
      voided.payload.invoice_balance.net_paid !== '1000.00'
    ) {
      throw new Error(
        'Refund void response did not restore the expected invoice balance.'
      );
    }

    console.log('\n===== REFUND VOID TEST PASSED =====');
    console.log({
      http_status: voided.statusCode,
      refund_id: refundId,
      refund_status: voided.payload.refund.status,
      void_reason: voided.payload.refund.void_reason,
      invoice_balance: voided.payload.invoice_balance,
    });
  } else {
    console.log('\nRefund was already voided by a previous test run.');
  }

  // Final verification.
  const [finalRefundRows] = await db.query(
    `SELECT
       id,
       refund_number,
       refund_amount,
       status,
       void_reason
     FROM member_membership_refunds
     WHERE organization_id = ?
       AND id = ?
     LIMIT 1`,
    [ORG_ID, refundId]
  );

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

  const [auditRows] = await db.query(
    `SELECT
       action,
       entity_type,
       entity_id,
       COUNT(*) AS total
     FROM audit_logs
     WHERE organization_id = ?
       AND entity_type = 'member_membership_refund'
       AND entity_id = ?
       AND action IN (
         'MEMBER_MEMBERSHIP_REFUND_POSTED',
         'MEMBER_MEMBERSHIP_REFUND_VOIDED'
       )
     GROUP BY action, entity_type, entity_id`,
    [ORG_ID, refundId]
  );

  if (!finalRefundRows.length || !balanceRows.length) {
    throw new Error('Final refund or invoice verification failed.');
  }

  const finalRefund = finalRefundRows[0];
  const balance = balanceRows[0];

  if (
    finalRefund.status !== 'voided' ||
    String(finalRefund.refund_amount) !== '400.00' ||
    String(balance.total_amount) !== '3800.00' ||
    String(balance.allocated_amount) !== '1000.00' ||
    String(balance.refunded_amount) !== '0.00'
  ) {
    throw new Error('Final database balances are incorrect.');
  }

  const postedAudit = auditRows.find(
    (row) => row.action === 'MEMBER_MEMBERSHIP_REFUND_POSTED'
  );

  const voidAudit = auditRows.find(
    (row) => row.action === 'MEMBER_MEMBERSHIP_REFUND_VOIDED'
  );

  if (
    Number(postedAudit?.total || 0) !== 1 ||
    Number(voidAudit?.total || 0) !== 1
  ) {
    throw new Error('Refund audit records were not verified.');
  }

  const balanceDue =
    Number(balance.total_amount) -
    Number(balance.allocated_amount) +
    Number(balance.refunded_amount);

  console.log('\n===== FINAL REFUND DATABASE VERIFICATION =====');
  console.table([{
    refund_id: Number(finalRefund.id),
    refund_number: finalRefund.refund_number,
    refund_amount: String(finalRefund.refund_amount),
    refund_status: finalRefund.status,
    invoice_total: String(balance.total_amount),
    allocated_payment: String(balance.allocated_amount),
    posted_refunds: String(balance.refunded_amount),
    final_balance_due: balanceDue.toFixed(2),
    refund_posted_audit: Number(postedAudit.total),
    refund_voided_audit: Number(voidAudit.total),
  }]);

  console.log('\n===== ALL REFUND TESTS PASSED =====');
}

main()
  .catch((error) => {
    console.error('\nREFUND INTEGRATION TEST FAILED:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
