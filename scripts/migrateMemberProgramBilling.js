'use strict';

const readline = require('node:readline');
const db = require('../src/config/db');

const {
  syncAllGymAdminRolePermissions,
} = require('../src/services/gymAdminPermissionService');

const EXPECTED_DATABASE = 'gym_management_db';

const PERMISSIONS = [
  [
    'member_program_billing.invoices.view',
    'View member program invoices and outstanding balances.',
  ],
  [
    'member_program_billing.payments.view',
    'View member program payment history and receipts.',
  ],
  [
    'member_program_billing.payments.receive',
    'Receive full or installment payments for member programs.',
  ],
  [
    'member_program_billing.payments.void',
    'Void posted member program payments with a reason.',
  ],
];

const hasColumn = async (connection, table, column) => {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  );

  return Number(rows[0]?.total || 0) > 0;
};

const ensureColumn = async (connection, table, column, ddl) => {
  if (await hasColumn(connection, table, column)) {
    console.log(`Verified column: ${table}.${column}`);
    return;
  }

  await connection.query(ddl);
  console.log(`Added column: ${table}.${column}`);
};

const ensureRequiredTables = async (connection) => {
  const required = [
    'organizations',
    'branches',
    'users',
    'members',
    'membership_plans',
    'member_program_assignments',
  ];

  for (const table of required) {
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?`,
      [table]
    );

    if (Number(rows[0]?.total || 0) !== 1) {
      throw new Error(`Required table is missing: ${table}`);
    }
  }

  for (const column of ['membership_plan_id', 'assigned_by_user_id']) {
    if (!(await hasColumn(connection, 'member_program_assignments', column))) {
      throw new Error(
        `member_program_assignments.${column} is missing. Run the existing program catalog migrations first.`
      );
    }
  }

  for (const column of ['price', 'currency_code', 'price_configured', 'plan_category']) {
    if (!(await hasColumn(connection, 'membership_plans', column))) {
      throw new Error(`membership_plans.${column} is missing.`);
    }
  }

  console.log('Required parent tables and columns verified.');
};

const createInvoiceTable = async (connection) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS member_program_invoices (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      organization_id BIGINT UNSIGNED NOT NULL,
      assignment_id BIGINT UNSIGNED NOT NULL,
      member_id BIGINT UNSIGNED NOT NULL,
      branch_id BIGINT UNSIGNED NOT NULL,

      invoice_number VARCHAR(48) NOT NULL,

      program_code_snapshot VARCHAR(30) NOT NULL,
      program_name_snapshot VARCHAR(120) NOT NULL,
      member_code_snapshot VARCHAR(40) NOT NULL,
      member_name_snapshot VARCHAR(150) NOT NULL,

      invoice_date DATE NOT NULL,
      due_date DATE DEFAULT NULL,

      total_amount DECIMAL(12,2) NOT NULL,
      currency_code CHAR(3) NOT NULL,

      status ENUM('issued','void') NOT NULL DEFAULT 'issued',

      voided_at DATETIME DEFAULT NULL,
      voided_by_user_id BIGINT UNSIGNED DEFAULT NULL,
      void_reason VARCHAR(500) DEFAULT NULL,

      notes VARCHAR(500) DEFAULT NULL,

      created_by_user_id BIGINT UNSIGNED NOT NULL,
      updated_by_user_id BIGINT UNSIGNED NOT NULL,

      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

      PRIMARY KEY (id),

      UNIQUE KEY uq_mpi_org_id
        (organization_id, id),

      UNIQUE KEY uq_mpi_assignment
        (organization_id, assignment_id),

      UNIQUE KEY uq_mpi_invoice_number
        (organization_id, invoice_number),

      KEY idx_mpi_member_date
        (organization_id, member_id, invoice_date),

      KEY idx_mpi_branch_date
        (organization_id, branch_id, invoice_date),

      CONSTRAINT fk_mpi_org
        FOREIGN KEY (organization_id)
        REFERENCES organizations (id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpi_assignment
        FOREIGN KEY (organization_id, assignment_id)
        REFERENCES member_program_assignments (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpi_member
        FOREIGN KEY (organization_id, member_id)
        REFERENCES members (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpi_branch
        FOREIGN KEY (organization_id, branch_id)
        REFERENCES branches (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpi_created_by
        FOREIGN KEY (organization_id, created_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpi_updated_by
        FOREIGN KEY (organization_id, updated_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpi_voided_by
        FOREIGN KEY (organization_id, voided_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT chk_mpi_amount
        CHECK (total_amount >= 0),

      CONSTRAINT chk_mpi_void
        CHECK (
          (
            status = 'void'
            AND voided_at IS NOT NULL
            AND voided_by_user_id IS NOT NULL
            AND void_reason IS NOT NULL
          )
          OR
          (
            status = 'issued'
            AND voided_at IS NULL
            AND voided_by_user_id IS NULL
            AND void_reason IS NULL
          )
        )
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  const [rows] = await connection.query(
    'SHOW CREATE TABLE member_program_invoices'
  );

  if (!rows[0]?.['Create Table']) {
    throw new Error('Program invoice table verification failed.');
  }

  console.log('Verified: member_program_invoices');
};

const createPaymentTable = async (connection) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS member_program_payments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      organization_id BIGINT UNSIGNED NOT NULL,

      invoice_id BIGINT UNSIGNED NOT NULL,
      payer_member_id BIGINT UNSIGNED NOT NULL,
      branch_id BIGINT UNSIGNED NOT NULL,

      payment_number VARCHAR(48) NOT NULL,
      idempotency_key CHAR(36) NOT NULL,

      payment_date DATETIME NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      currency_code CHAR(3) NOT NULL,

      payment_method VARCHAR(30) NOT NULL,
      payment_reference VARCHAR(120) DEFAULT NULL,

      status ENUM('posted','voided') NOT NULL DEFAULT 'posted',

      voided_at DATETIME DEFAULT NULL,
      voided_by_user_id BIGINT UNSIGNED DEFAULT NULL,
      void_reason VARCHAR(500) DEFAULT NULL,

      notes VARCHAR(500) DEFAULT NULL,

      received_by_user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

      PRIMARY KEY (id),

      UNIQUE KEY uq_mpp_org_id
        (organization_id, id),

      UNIQUE KEY uq_mpp_payment_number
        (organization_id, payment_number),

      UNIQUE KEY uq_mpp_idempotency
        (organization_id, idempotency_key),

      KEY idx_mpp_invoice_date
        (organization_id, invoice_id, payment_date),

      KEY idx_mpp_member_date
        (organization_id, payer_member_id, payment_date),

      KEY idx_mpp_branch_date
        (organization_id, branch_id, payment_date),

      CONSTRAINT fk_mpp_org
        FOREIGN KEY (organization_id)
        REFERENCES organizations (id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpp_invoice
        FOREIGN KEY (organization_id, invoice_id)
        REFERENCES member_program_invoices (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpp_member
        FOREIGN KEY (organization_id, payer_member_id)
        REFERENCES members (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpp_branch
        FOREIGN KEY (organization_id, branch_id)
        REFERENCES branches (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpp_received_by
        FOREIGN KEY (organization_id, received_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mpp_voided_by
        FOREIGN KEY (organization_id, voided_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT chk_mpp_amount
        CHECK (amount > 0),

      CONSTRAINT chk_mpp_method
        CHECK (
          payment_method IN (
            'cash',
            'card',
            'bank_transfer',
            'cheque',
            'mobile_wallet',
            'online',
            'other'
          )
        ),

      CONSTRAINT chk_mpp_void
        CHECK (
          (
            status = 'voided'
            AND voided_at IS NOT NULL
            AND voided_by_user_id IS NOT NULL
            AND void_reason IS NOT NULL
          )
          OR
          (
            status = 'posted'
            AND voided_at IS NULL
            AND voided_by_user_id IS NULL
            AND void_reason IS NULL
          )
        )
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  const [rows] = await connection.query(
    'SHOW CREATE TABLE member_program_payments'
  );

  if (!rows[0]?.['Create Table']) {
    throw new Error('Program payment table verification failed.');
  }

  console.log('Verified: member_program_payments');
};

const createSequenceTable = async (connection) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS member_program_billing_sequences (
      organization_id BIGINT UNSIGNED NOT NULL,
      document_year SMALLINT UNSIGNED NOT NULL,
      sequence_value BIGINT UNSIGNED NOT NULL DEFAULT 0,

      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

      PRIMARY KEY (organization_id, document_year),

      CONSTRAINT fk_mpbs_org
        FOREIGN KEY (organization_id)
        REFERENCES organizations (id)
        ON DELETE RESTRICT,

      CONSTRAINT chk_mpbs_year
        CHECK (document_year BETWEEN 2000 AND 9999),

      CONSTRAINT chk_mpbs_value
        CHECK (sequence_value >= 0)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  const [rows] = await connection.query(
    'SHOW CREATE TABLE member_program_billing_sequences'
  );

  if (!rows[0]?.['Create Table']) {
    throw new Error('Program billing sequence table verification failed.');
  }

  console.log('Verified: member_program_billing_sequences');
};

const snapshotExistingProgramFees = async (connection) => {
  const [result] = await connection.query(`
    UPDATE member_program_assignments mpa

    INNER JOIN membership_plans mp
      ON mp.organization_id = mpa.organization_id
     AND mp.plan_category = 'program'
     AND (
       mp.id = mpa.membership_plan_id
       OR (
         mpa.membership_plan_id IS NULL
         AND mp.legacy_program_id = mpa.program_id
       )
     )

    SET
      mpa.fee_snapshot = mp.price,
      mpa.currency_code_snapshot = mp.currency_code,
      mpa.price_configured_snapshot = mp.price_configured

    WHERE mpa.fee_snapshot IS NULL
       OR mpa.currency_code_snapshot IS NULL
  `);

  console.log(
    `Existing assignment fee snapshots updated: ${result.affectedRows}`
  );
};

const createExistingInvoices = async (connection) => {
  const [result] = await connection.query(`
    INSERT INTO member_program_invoices
      (
        organization_id,
        assignment_id,
        member_id,
        branch_id,
        invoice_number,
        program_code_snapshot,
        program_name_snapshot,
        member_code_snapshot,
        member_name_snapshot,
        invoice_date,
        due_date,
        total_amount,
        currency_code,
        status,
        created_by_user_id,
        updated_by_user_id
      )

    SELECT
      mpa.organization_id,
      mpa.id,
      mpa.member_id,
      mpa.branch_id,

      CONCAT(
        'PGI-',
        YEAR(COALESCE(mpa.created_at, CURRENT_DATE())),
        '-',
        LPAD(mpa.id, 8, '0')
      ),

      mpa.program_code_snapshot,
      mpa.program_name_snapshot,
      member.member_code,
      member.full_name,

      COALESCE(DATE(mpa.created_at), CURRENT_DATE()),
      COALESCE(DATE(mpa.created_at), CURRENT_DATE()),

      mpa.fee_snapshot,
      mpa.currency_code_snapshot,

      'issued',

      mpa.assigned_by_user_id,
      COALESCE(mpa.updated_by_user_id, mpa.assigned_by_user_id)

    FROM member_program_assignments mpa

    INNER JOIN members member
      ON member.organization_id = mpa.organization_id
     AND member.id = mpa.member_id

    WHERE mpa.price_configured_snapshot = 1
      AND mpa.fee_snapshot IS NOT NULL
      AND mpa.currency_code_snapshot IS NOT NULL

      AND NOT EXISTS (
        SELECT 1
        FROM member_program_invoices existing
        WHERE existing.organization_id = mpa.organization_id
          AND existing.assignment_id = mpa.id
      )
  `);

  console.log(
    `Invoices created for existing configured program fees: ${result.affectedRows}`
  );
};

const createPermissions = async (connection) => {
  for (const [permissionKey, description] of PERMISSIONS) {
    await connection.query(
      `INSERT INTO permissions
        (
          permission_key,
          module_name,
          description,
          permission_scope,
          gym_admin_default
        )
       VALUES (?, 'Member Program Billing', ?, 'gym', 1)
       ON DUPLICATE KEY UPDATE
         module_name = VALUES(module_name),
         description = VALUES(description),
         permission_scope = 'gym',
         gym_admin_default = 1`,
      [permissionKey, description]
    );
  }

  const syncResult = await syncAllGymAdminRolePermissions(connection);

  console.log(
    `System Gym Admin organizations synchronized: ${syncResult.organizationsProcessed}`
  );

  for (const [permissionKey] of PERMISSIONS) {
    const [rows] = await connection.query(
      `SELECT id
       FROM permissions
       WHERE permission_key = ?
         AND permission_scope = 'gym'
         AND gym_admin_default = 1
       LIMIT 1`,
      [permissionKey]
    );

    if (!rows.length) {
      throw new Error(`Permission verification failed: ${permissionKey}`);
    }
  }

  console.log('Program billing permissions verified.');
};

const main = async () => {
  let connection;

  try {
    connection = await db.getConnection();

    const [databaseRows] = await connection.query(
      'SELECT DATABASE() AS database_name'
    );

    const databaseName = databaseRows[0]?.database_name;

    console.log(`\nProgram billing migration target: ${databaseName}`);

    if (databaseName !== EXPECTED_DATABASE) {
      throw new Error(
        `Expected ${EXPECTED_DATABASE}, received ${databaseName || '(none)'}.`
      );
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise((resolve) => {
      rl.question(
        `Type the exact database name (${EXPECTED_DATABASE}) to continue: `,
        resolve
      );
    });

    rl.close();

    if (String(answer).trim() !== EXPECTED_DATABASE) {
      throw new Error('Database confirmation did not match. Migration cancelled.');
    }

    await ensureRequiredTables(connection);

    console.log('\nAdding program fee snapshot columns...');

    await ensureColumn(
      connection,
      'member_program_assignments',
      'fee_snapshot',
      `ALTER TABLE member_program_assignments
       ADD COLUMN fee_snapshot DECIMAL(12,2) NULL
       AFTER duration_unit_snapshot`
    );

    await ensureColumn(
      connection,
      'member_program_assignments',
      'currency_code_snapshot',
      `ALTER TABLE member_program_assignments
       ADD COLUMN currency_code_snapshot CHAR(3) NULL
       AFTER fee_snapshot`
    );

    await ensureColumn(
      connection,
      'member_program_assignments',
      'price_configured_snapshot',
      `ALTER TABLE member_program_assignments
       ADD COLUMN price_configured_snapshot TINYINT(1) NOT NULL DEFAULT 0
       AFTER currency_code_snapshot`
    );

    console.log('\nCreating program billing tables...');

    await createInvoiceTable(connection);
    await createPaymentTable(connection);
    await createSequenceTable(connection);

    console.log('\nBackfilling existing program assignments...');

    await snapshotExistingProgramFees(connection);
    await createExistingInvoices(connection);

    console.log('\nRegistering program billing permissions...');

    await createPermissions(connection);

    const [counts] = await connection.query(`
      SELECT
        (SELECT COUNT(*) FROM member_program_assignments)
          AS assignments,

        (SELECT COUNT(*) FROM member_program_invoices)
          AS invoices,

        (SELECT COUNT(*) FROM member_program_payments)
          AS payments
    `);

    const result = counts[0];

    console.log('\n===== PROGRAM BILLING MIGRATION SUCCESSFUL =====');
    console.log(`Assignments: ${result.assignments}`);
    console.log(`Program invoices: ${result.invoices}`);
    console.log(`Program payments: ${result.payments}`);
    console.log('Existing membership billing tables were not modified.');
  } catch (error) {
    console.error('\nPROGRAM BILLING MIGRATION FAILED');
    console.error(error.code || '', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await db.end();
  }
};

main();