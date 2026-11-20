'use strict';

const db = require('../src/config/db');

async function main() {
  const [databaseRows] = await db.query(
    'SELECT DATABASE() AS database_name'
  );

  if (databaseRows[0]?.database_name !== 'gym_management_db') {
    throw new Error('Wrong database selected.');
  }

  const [columns] = await db.query(
    `SELECT
       COLUMN_NAME,
       DATA_TYPE,
       CHARACTER_MAXIMUM_LENGTH,
       IS_NULLABLE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'member_membership_refunds'
       AND COLUMN_NAME = 'idempotency_key'`
  );

  if (!columns.length) {
    await db.query(`
      ALTER TABLE member_membership_refunds
      ADD COLUMN idempotency_key CHAR(36) NULL
        AFTER refund_number
    `);

    console.log('Added: idempotency_key');
  } else {
    const column = columns[0];

    if (
      column.DATA_TYPE !== 'char' ||
      Number(column.CHARACTER_MAXIMUM_LENGTH) !== 36 ||
      column.IS_NULLABLE !== 'YES'
    ) {
      throw new Error(
        'Existing idempotency_key column has an unexpected definition.'
      );
    }

    console.log('Verified existing: idempotency_key');
  }

  const [indexes] = await db.query(
    `SELECT
       INDEX_NAME,
       NON_UNIQUE,
       GROUP_CONCAT(
         COLUMN_NAME
         ORDER BY SEQ_IN_INDEX
       ) AS indexed_columns
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'member_membership_refunds'
     GROUP BY INDEX_NAME, NON_UNIQUE`
  );

  const correctIndex = indexes.find(
    (index) =>
      Number(index.NON_UNIQUE) === 0 &&
      index.indexed_columns === 'organization_id,idempotency_key'
  );

  if (!correctIndex) {
    const conflictingName = indexes.find(
      (index) => index.INDEX_NAME === 'uq_mm_refund_idempotency'
    );

    if (conflictingName) {
      throw new Error(
        'Index uq_mm_refund_idempotency exists with an unexpected definition.'
      );
    }

    await db.query(`
      ALTER TABLE member_membership_refunds
      ADD UNIQUE INDEX uq_mm_refund_idempotency
        (organization_id, idempotency_key)
    `);

    console.log('Added: uq_mm_refund_idempotency');
  } else {
    console.log(`Verified existing: ${correctIndex.INDEX_NAME}`);
  }

  console.log('\n===== REFUND IDEMPOTENCY MIGRATION SUCCESSFUL =====');
}

main()
  .catch((error) => {
    console.error('REFUND IDEMPOTENCY MIGRATION FAILED:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
