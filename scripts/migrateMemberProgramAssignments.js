'use strict';

const db = require('../src/config/db');

const REQUIRED_TABLES = [
  'organizations',
  'branches',
  'users',
  'members',
  'fitness_programs',
];

const REQUIRED_COLUMNS = [
  'id',
  'organization_id',
  'member_id',
  'program_id',
  'branch_id',
  'program_code_snapshot',
  'program_name_snapshot',
  'duration_value_snapshot',
  'duration_unit_snapshot',
  'start_date',
  'expected_end_date',
  'status',
  'completed_on',
  'cancelled_on',
  'assigned_by_user_id',
  'updated_by_user_id',
  'active_program_id',
  'created_at',
  'updated_at',
];

const REQUIRED_INDEXES = [
  'PRIMARY',
  'uq_mpa_org_id',
  'uq_mpa_in_progress',
  'idx_mpa_org_member_start',
  'idx_mpa_org_branch_start',
  'idx_mpa_org_program_status',
];

const REQUIRED_CONSTRAINTS = [
  'fk_mpa_organization',
  'fk_mpa_member',
  'fk_mpa_program',
  'fk_mpa_branch',
  'fk_mpa_assigned_by',
  'fk_mpa_updated_by',
  'chk_mpa_duration',
  'chk_mpa_status_dates',
];

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS member_program_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  program_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,

  program_code_snapshot VARCHAR(30) NOT NULL,
  program_name_snapshot VARCHAR(120) NOT NULL,
  duration_value_snapshot SMALLINT UNSIGNED NOT NULL,
  duration_unit_snapshot ENUM('day', 'week', 'month', 'year') NOT NULL,

  start_date DATE NOT NULL,
  expected_end_date DATE NOT NULL,

  status ENUM('active', 'paused', 'completed', 'cancelled')
    NOT NULL DEFAULT 'active',

  completed_on DATE DEFAULT NULL,
  cancelled_on DATE DEFAULT NULL,

  assigned_by_user_id BIGINT UNSIGNED NOT NULL,
  updated_by_user_id BIGINT UNSIGNED DEFAULT NULL,

  active_program_id BIGINT UNSIGNED
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('active', 'paused') THEN program_id
        ELSE NULL
      END
    ) STORED,

  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  UNIQUE KEY uq_mpa_org_id (organization_id, id),

  UNIQUE KEY uq_mpa_in_progress (
    organization_id,
    member_id,
    active_program_id
  ),

  KEY idx_mpa_org_member_start (
    organization_id,
    member_id,
    start_date
  ),

  KEY idx_mpa_org_branch_start (
    organization_id,
    branch_id,
    start_date
  ),

  KEY idx_mpa_org_program_status (
    organization_id,
    program_id,
    status
  ),

  CONSTRAINT fk_mpa_organization
    FOREIGN KEY (organization_id)
    REFERENCES organizations (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_mpa_member
    FOREIGN KEY (organization_id, member_id)
    REFERENCES members (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_mpa_program
    FOREIGN KEY (organization_id, program_id)
    REFERENCES fitness_programs (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_mpa_branch
    FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_mpa_assigned_by
    FOREIGN KEY (organization_id, assigned_by_user_id)
    REFERENCES users (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_mpa_updated_by
    FOREIGN KEY (organization_id, updated_by_user_id)
    REFERENCES users (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT chk_mpa_duration
    CHECK (duration_value_snapshot >= 1),

  CONSTRAINT chk_mpa_status_dates
    CHECK (
      (
        status IN ('active', 'paused')
        AND completed_on IS NULL
        AND cancelled_on IS NULL
      )
      OR
      (
        status = 'completed'
        AND completed_on IS NOT NULL
        AND cancelled_on IS NULL
      )
      OR
      (
        status = 'cancelled'
        AND cancelled_on IS NOT NULL
        AND completed_on IS NULL
      )
    )
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
`;

async function assertPrerequisites() {
  for (const table of REQUIRED_TABLES) {
    const [rows] = await db.query(
      `SHOW TABLES LIKE ?`,
      [table]
    );

    if (rows.length === 0) {
      throw new Error(
        `Required table "${table}" does not exist. Migration stopped.`
      );
    }
  }

  console.log('Required parent tables verified.');
}

async function verifyCreatedTable() {
  const [columns] = await db.query(
    'SHOW COLUMNS FROM member_program_assignments'
  );

  const columnNames = new Set(columns.map((row) => row.Field));
  const missingColumns = REQUIRED_COLUMNS.filter(
    (column) => !columnNames.has(column)
  );

  if (missingColumns.length > 0) {
    throw new Error(
      `Table exists but is missing columns: ${missingColumns.join(', ')}.`
    );
  }

  const [indexes] = await db.query(
    'SHOW INDEX FROM member_program_assignments'
  );

  const indexNames = new Set(indexes.map((row) => row.Key_name));
  const missingIndexes = REQUIRED_INDEXES.filter(
    (index) => !indexNames.has(index)
  );

  if (missingIndexes.length > 0) {
    throw new Error(
      `Missing expected indexes: ${missingIndexes.join(', ')}.`
    );
  }

  const [constraints] = await db.query(
    `SELECT CONSTRAINT_NAME
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'member_program_assignments'`
  );

  const constraintNames = new Set(
    constraints.map((row) => row.CONSTRAINT_NAME)
  );

  const missingConstraints = REQUIRED_CONSTRAINTS.filter(
    (constraint) => !constraintNames.has(constraint)
  );

  if (missingConstraints.length > 0) {
    throw new Error(
      `Missing expected constraints: ${missingConstraints.join(', ')}.`
    );
  }

  const [definition] = await db.query(
    'SHOW CREATE TABLE member_program_assignments'
  );

  console.log('\nVerified member_program_assignments structure.');
  console.log('\nExpected columns:', REQUIRED_COLUMNS.length);
  console.log('Expected indexes:', REQUIRED_INDEXES.length);
  console.log('Expected constraints:', REQUIRED_CONSTRAINTS.length);
  console.log('\nTable definition:');
  console.log(definition[0]['Create Table']);
}

async function main() {
  console.log('Starting Member Program Assignment migration...');

  await assertPrerequisites();

  const [existing] = await db.query(
    `SHOW TABLES LIKE 'member_program_assignments'`
  );

  if (existing.length === 0) {
    await db.query(TABLE_SQL);
    console.log('Created member_program_assignments table.');
  } else {
    console.log(
      'member_program_assignments already exists. Checking its structure.'
    );
  }

  await verifyCreatedTable();

  console.log('\nMEMBER PROGRAM ASSIGNMENT MIGRATION SUCCESSFUL.');
}

main()
  .catch((error) => {
    console.error(
      '\nMEMBER PROGRAM ASSIGNMENT MIGRATION FAILED:',
      error.code || '',
      error.message
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
