'use strict';

const db = require('../src/config/db');

const tables = [
  'member_membership_invoices',
  'member_membership_payments',
  'member_membership_payment_allocations',
  'member_membership_refunds',
  'member_membership_billing_sequences',
];

async function main() {
  for (const table of tables) {
    const [rows] = await db.query(
      `SHOW CREATE TABLE \`${table}\``
    );

    if (!rows.length) {
      throw new Error(`Table not found: ${table}`);
    }

    console.log(`\n========== ${table} ==========`);
    console.log(rows[0]['Create Table']);
  }
}

main()
  .catch((error) => {
    console.error('Billing schema inspection failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
