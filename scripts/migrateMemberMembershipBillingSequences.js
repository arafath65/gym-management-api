'use strict';

const db = require('../src/config/db');

async function main() {
  const [databaseRows] = await db.query(
    'SELECT DATABASE() AS database_name'
  );

  if (databaseRows[0]?.database_name !== 'gym_management_db') {
    throw new Error('Wrong database selected.');
  }

  const [organizationRows] = await db.query(
    "SHOW TABLES LIKE 'organizations'"
  );

  if (organizationRows.length === 0) {
    throw new Error('organizations table does not exist.');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS member_membership_billing_sequences (
      organization_id BIGINT UNSIGNED NOT NULL,
      document_type ENUM('invoice','payment','refund') NOT NULL,
      document_year SMALLINT UNSIGNED NOT NULL,
      sequence_value BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

      PRIMARY KEY (
        organization_id,
        document_type,
        document_year
      ),

      CONSTRAINT fk_mm_billing_sequence_org
        FOREIGN KEY (organization_id)
        REFERENCES organizations (id)
        ON DELETE RESTRICT,

      CONSTRAINT chk_mm_billing_sequence_value
        CHECK (sequence_value >= 0),

      CONSTRAINT chk_mm_billing_sequence_year
        CHECK (document_year BETWEEN 2000 AND 9999)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  const [rows] = await db.query(
    'SHOW CREATE TABLE member_membership_billing_sequences'
  );

  if (!rows[0]?.['Create Table']) {
    throw new Error('Sequence table verification failed.');
  }

  console.log('===== BILLING SEQUENCE MIGRATION SUCCESSFUL =====');
  console.log('Verified: member_membership_billing_sequences');
  console.log('Organization-scoped numbering is ready.');
}

main()
  .catch((error) => {
    console.error('BILLING SEQUENCE MIGRATION FAILED:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });

