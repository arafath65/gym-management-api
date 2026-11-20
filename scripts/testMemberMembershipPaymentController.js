'use strict';

const db = require('../src/config/db');

const {
  receiveMemberInvoicePayment,
} = require('../src/controllers/memberMembershipPaymentController');

const ORGANIZATION_ID = 3;
const MEMBERSHIP_ID = 2;
const INVOICE_ID = 1;
const MEMBER_ID = 2;

const IDEMPOTENCY_KEY = '550e8400-e29b-41d4-a716-446655440000';
const OVERPAYMENT_KEY = '550e8400-e29b-41d4-a716-446655440001';

async function callPaymentController(membership, body) {
  const req = {
    params: {
      memberId: String(MEMBER_ID),
      membershipId: String(MEMBERSHIP_ID),
      invoiceId: String(INVOICE_ID),
    },

    gymStaff: {
      organizationId: ORGANIZATION_ID,
      branchId: Number(membership.branch_id),
      userId: Number(membership.created_by_user_id),
    },

    body,
    ip: '127.0.0.1',

    get(header) {
      return header.toLowerCase() === 'user-agent'
        ? 'Innovex Payment Integration Test'
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

  await receiveMemberInvoicePayment(req, res);
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
    [ORGANIZATION_ID, MEMBERSHIP_ID, MEMBER_ID]
  );

  if (!membershipRows.length) {
    throw new Error('Test membership was not found.');
  }

  const membership = membershipRows[0];

  const [invoiceRows] = await db.query(
    `SELECT
       id,
       invoice_number,
       total_amount,
       currency_code,
       status
     FROM member_membership_invoices
     WHERE organization_id = ?
       AND membership_id = ?
       AND id = ?
     LIMIT 1`,
    [ORGANIZATION_ID, MEMBERSHIP_ID, INVOICE_ID]
  );

  if (!invoiceRows.length) {
    throw new Error('Test invoice was not found.');
  }

  const invoice = invoiceRows[0];

  if (invoice.status !== 'issued') {
    throw new Error('Test invoice is not issued.');
  }

  if (
    invoice.currency_code !== 'LKR' ||
    String(invoice.total_amount) !== '3800.00'
  ) {
    throw new Error(
      'Test invoice is not the expected LKR 3,800.00 invoice.'
    );
  }

  const [existingRows] = await db.query(
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
     LIMIT 1`,
    [ORGANIZATION_ID, IDEMPOTENCY_KEY]
  );

  if (existingRows.length) {
    const existing = existingRows[0];

    const exactRetry =
      Number(existing.payer_member_id) === MEMBER_ID &&
      String(existing.amount) === '1000.00' &&
      existing.currency_code === 'LKR' &&
      existing.payment_method === 'cash' &&
      existing.payment_reference == null &&
      existing.notes === 'Integration test partial payment' &&
      Number(existing.invoice_id) === INVOICE_ID &&
      String(existing.allocated_amount) === '1000.00' &&
      existing.status === 'posted';

    if (!exactRetry) {
      throw new Error(
        'The test idempotency key is already attached to a different payment. Aborting.'
      );
    }
  } else {
    const [priorRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM member_membership_payment_allocations
       WHERE organization_id = ?
         AND invoice_id = ?`,
      [ORGANIZATION_ID, INVOICE_ID]
    );

    if (Number(priorRows[0].total) !== 0) {
      throw new Error(
        'The invoice already has payment allocations. ' +
        'Refusing to mix this integration test with existing payments.'
      );
    }
  }

  const paymentRequest = {
    amount: '1000.00',
    payment_method: 'cash',
    payment_reference: null,
    notes: 'Integration test partial payment',
    idempotency_key: IDEMPOTENCY_KEY,
  };

  // Test 1: create the partial payment, or replay the exact prior request.
  const first = await callPaymentController(
    membership,
    paymentRequest
  );

  if (
    ![200, 201].includes(first.statusCode) ||
    !first.payload?.success
  ) {
    throw new Error(
      `Payment creation failed (${first.statusCode}): ` +
      JSON.stringify(first.payload)
    );
  }

  const payment = first.payload.payment;

  if (
    payment.payment_number == null ||
    payment.amount !== '1000.00' ||
    payment.status !== 'posted'
  ) {
    throw new Error('Payment response did not match expected values.');
  }

  console.log('\n===== PARTIAL PAYMENT TEST PASSED =====');
  console.log({
    http_status: first.statusCode,
    payment_number: payment.payment_number,
    payment_id: payment.id,
    amount: payment.amount,
    currency_code: payment.currency_code,
    payment_method: payment.payment_method,
    payment_status: payment.status,
    invoice_balance: first.payload.invoice_balance,
  });

  // Test 2: repeat the exact request with the same idempotency key.
  const retry = await callPaymentController(
    membership,
    paymentRequest
  );

  if (
    retry.statusCode !== 200 ||
    !retry.payload?.success ||
    retry.payload.idempotent_replay !== true ||
    Number(retry.payload.payment.id) !== Number(payment.id)
  ) {
    throw new Error(
      'Idempotency retry did not return the original payment.'
    );
  }

  console.log('\n===== IDEMPOTENCY TEST PASSED =====');
  console.log({
    http_status: retry.statusCode,
    idempotent_replay: retry.payload.idempotent_replay,
    original_payment_id: retry.payload.payment.id,
    payment_number: retry.payload.payment.payment_number,
  });

  // Test 3: attempt to pay 0.01 more than the remaining balance.
  const remaining = retry.payload.invoice_balance.balance_due;

  const remainingCents = (() => {
    const [whole, fraction] = String(remaining).split('.');
    return BigInt(whole) * 100n + BigInt(fraction || '00');
  })();

  const overpayment = `${remainingCents / 100n}.` +
    String((remainingCents % 100n) + 1n).padStart(2, '0');

  const overpay = await callPaymentController(
    membership,
    {
      amount: overpayment,
      payment_method: 'cash',
      payment_reference: null,
      notes: 'Expected overpayment rejection test',
      idempotency_key: OVERPAYMENT_KEY,
    }
  );

  if (
    overpay.statusCode !== 409 ||
    overpay.payload?.code !== 'PAYMENT_EXCEEDS_INVOICE_BALANCE'
  ) {
    throw new Error(
      'Overpayment was not rejected as expected: ' +
      JSON.stringify(overpay.payload)
    );
  }

  console.log('\n===== OVERPAYMENT PROTECTION TEST PASSED =====');
  console.log({
    attempted_amount: overpayment,
    expected_balance: remaining,
    http_status: overpay.statusCode,
    rejection_code: overpay.payload.code,
  });

  // Final checks: exactly one receipt/allocation and one receipt audit.
  const [finalRows] = await db.query(
    `SELECT
       COUNT(DISTINCT p.id) AS payment_count,
       COUNT(DISTINCT a.id) AS allocation_count,
       COALESCE(SUM(
         CASE WHEN p.status = 'posted'
           THEN p.amount ELSE 0 END
       ), 0.00) AS posted_payment_total,
       COALESCE(SUM(
         CASE WHEN p.status = 'posted'
           THEN a.allocated_amount ELSE 0 END
       ), 0.00) AS posted_allocation_total
     FROM member_membership_payment_allocations a
     INNER JOIN member_membership_payments p
       ON p.organization_id = a.organization_id
      AND p.id = a.payment_id
     WHERE a.organization_id = ?
       AND a.invoice_id = ?`,
    [ORGANIZATION_ID, INVOICE_ID]
  );

  const [auditRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM audit_logs
     WHERE organization_id = ?
       AND action = 'MEMBER_MEMBERSHIP_PAYMENT_RECEIVED'
       AND entity_type = 'member_membership_payment'
       AND entity_id = ?`,
    [ORGANIZATION_ID, payment.id]
  );

  const final = finalRows[0];

  if (
    Number(final.payment_count) !== 1 ||
    Number(final.allocation_count) !== 1 ||
    String(final.posted_payment_total) !== '1000.00' ||
    String(final.posted_allocation_total) !== '1000.00' ||
    Number(auditRows[0].total) !== 1
  ) {
    throw new Error(
      'Final payment, allocation, or audit consistency verification failed.'
    );
  }

  console.log('\n===== FINAL PAYMENT DATABASE VERIFICATION =====');
  console.table([{
    payment_count: Number(final.payment_count),
    allocation_count: Number(final.allocation_count),
    posted_payment_total: String(final.posted_payment_total),
    posted_allocation_total: String(final.posted_allocation_total),
    audit_count: Number(auditRows[0].total),
  }]);

  console.log('\n===== ALL PAYMENT TESTS PASSED =====');
}

main()
  .catch((error) => {
    console.error('\nPAYMENT INTEGRATION TEST FAILED:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
