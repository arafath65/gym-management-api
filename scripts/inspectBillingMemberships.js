'use strict';

const db = require('../src/config/db');

async function main() {
  const [rows] = await db.query(`
    SELECT
      mm.organization_id,
      mm.id AS membership_id,
      mm.primary_member_id,
      mm.validity_type_snapshot,
      mm.status,
      DATE_FORMAT(mm.start_date, '%Y-%m-%d') AS start_date,
      DATE_FORMAT(mm.end_date, '%Y-%m-%d') AS end_date,
      DATE_FORMAT(mm.next_billing_date, '%Y-%m-%d') AS next_billing_date,
      mm.price_snapshot,
      mm.currency_code_snapshot,
      (
        SELECT COUNT(*)
        FROM member_membership_invoices i
        WHERE i.organization_id = mm.organization_id
          AND i.membership_id = mm.id
      ) AS invoice_count
    FROM member_memberships mm
    WHERE mm.status = 'active'
      AND mm.start_date <= CURRENT_DATE()
      AND (mm.end_date IS NULL OR mm.end_date > CURRENT_DATE())
    ORDER BY mm.id DESC
    LIMIT 20
  `);

  console.table(rows);
}

main()
  .catch((error) => {
    console.error('Membership inspection failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
