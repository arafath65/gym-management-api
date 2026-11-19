'use strict';

const db = require('../src/config/db');

const REQUIRED_COLUMNS = [
  'old_values',
  'new_values',
  'metadata',
];

async function closeDatabase() {
  if (typeof db.end === 'function') {
    await db.end();
  }
}

async function migrate() {
  const [tables] = await db.query(
    `SELECT TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'audit_logs'
     LIMIT 1`
  );

  if (tables.length === 0) {
    throw new Error('The audit_logs table does not exist in the selected database.');
  }

  const [columns] = await db.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'audit_logs'`
  );

  const existing = new Set(columns.map((row) => row.COLUMN_NAME));

  const definitions = {
    old_values: 'ADD COLUMN old_values JSON NULL',
    new_values: 'ADD COLUMN new_values JSON NULL',
    metadata: 'ADD COLUMN metadata JSON NULL',
  };

  const missing = REQUIRED_COLUMNS.filter(
    (column) => !existing.has(column)
  );

  if (missing.length > 0) {
    const clauses = missing.map((column) => definitions[column]);

    await db.query(
      `ALTER TABLE audit_logs ${clauses.join(', ')}`
    );

    console.log('Added audit columns:', missing.join(', '));
  } else {
    console.log('All audit snapshot columns already exist.');
  }

  const [verified] = await db.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'audit_logs'
       AND COLUMN_NAME IN (?, ?, ?)
     ORDER BY COLUMN_NAME`,
    REQUIRED_COLUMNS
  );

  const verifiedNames = new Set(
    verified.map((row) => row.COLUMN_NAME)
  );

  const missingAfterMigration = REQUIRED_COLUMNS.filter(
    (column) => !verifiedNames.has(column)
  );

  if (missingAfterMigration.length > 0) {
    throw new Error(
      `Audit schema verification failed: ${missingAfterMigration.join(', ')}`
    );
  }

  console.log('\nVerified audit snapshot columns:');
  console.table(verified);

  console.log('Member audit snapshot migration completed.');
}

migrate()
  .catch((error) => {
    console.error(
      'Member audit migration failed:',
      error.code || error.message
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeDatabase();
    } catch (error) {
      console.error('Database close failed:', error.message);
      process.exitCode = 1;
    }
  });