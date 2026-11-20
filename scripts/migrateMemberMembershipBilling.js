'use strict';

const db = require('../src/config/db');

const REQUIRED_PARENT_TABLES = [
  'organizations',
  'branches',
  'users',
  'members',
  'member_memberships',
];

const TABLES = [
  {
    name: 'member_membership_invoices',
    constraints: [
      'fk_mm_invoice_org',
      'fk_mm_invoice_membership',
      'fk_mm_invoice_member',
      'fk_mm_invoice_branch',
      'fk_mm_invoice_created_by',
      'fk_mm_invoice_updated_by',
      'fk_mm_invoice_voided_by',
      'chk_mm_invoice_period',
      'chk_mm_invoice_amount',
      'chk_mm_invoice_void',
    ],
    sql: `
      CREATE TABLE IF NOT EXISTS member_membership_invoices (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id BIGINT UNSIGNED NOT NULL,
        membership_id BIGINT UNSIGNED NOT NULL,
        primary_member_id BIGINT UNSIGNED NOT NULL,
        branch_id BIGINT UNSIGNED NOT NULL,

        invoice_number VARCHAR(40) NOT NULL,

        plan_code_snapshot VARCHAR(30) NOT NULL,
        plan_name_snapshot VARCHAR(150) NOT NULL,
        member_code_snapshot VARCHAR(40) NOT NULL,
        member_name_snapshot VARCHAR(150) NOT NULL,

        billing_period_start DATE NOT NULL,
        billing_period_end DATE NOT NULL,
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

        UNIQUE KEY uq_mm_invoice_org_id
          (organization_id, id),

        UNIQUE KEY uq_mm_invoice_number
          (organization_id, invoice_number),

        UNIQUE KEY uq_mm_invoice_cycle
          (organization_id, membership_id, billing_period_start),

        KEY idx_mm_invoice_member_status
          (organization_id, primary_member_id, status, invoice_date),

        KEY idx_mm_invoice_branch_date
          (organization_id, branch_id, invoice_date),

        KEY idx_mm_invoice_membership
          (organization_id, membership_id),

        CONSTRAINT fk_mm_invoice_org
          FOREIGN KEY (organization_id)
          REFERENCES organizations (id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_invoice_membership
          FOREIGN KEY (organization_id, membership_id)
          REFERENCES member_memberships (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_invoice_member
          FOREIGN KEY (organization_id, primary_member_id)
          REFERENCES members (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_invoice_branch
          FOREIGN KEY (organization_id, branch_id)
          REFERENCES branches (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_invoice_created_by
          FOREIGN KEY (organization_id, created_by_user_id)
          REFERENCES users (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_invoice_updated_by
          FOREIGN KEY (organization_id, updated_by_user_id)
          REFERENCES users (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_invoice_voided_by
          FOREIGN KEY (organization_id, voided_by_user_id)
          REFERENCES users (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT chk_mm_invoice_period
          CHECK (billing_period_end >= billing_period_start),

        CONSTRAINT chk_mm_invoice_amount
          CHECK (total_amount >= 0),

        CONSTRAINT chk_mm_invoice_void
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
    `,
  },

  {
    name: 'member_membership_payments',
    constraints: [
      'fk_mm_payment_org',
      'fk_mm_payment_member',
      'fk_mm_payment_branch',
      'fk_mm_payment_received_by',
      'fk_mm_payment_voided_by',
      'chk_mm_payment_amount',
      'chk_mm_payment_method',
      'chk_mm_payment_void',
    ],
    sql: `
      CREATE TABLE IF NOT EXISTS member_membership_payments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id BIGINT UNSIGNED NOT NULL,

        payment_number VARCHAR(40) NOT NULL,
        idempotency_key CHAR(36) DEFAULT NULL,

        payer_member_id BIGINT UNSIGNED NOT NULL,
        branch_id BIGINT UNSIGNED NOT NULL,

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

        UNIQUE KEY uq_mm_payment_org_id
          (organization_id, id),

        UNIQUE KEY uq_mm_payment_number
          (organization_id, payment_number),

        UNIQUE KEY uq_mm_payment_idempotency
          (organization_id, idempotency_key),

        KEY idx_mm_payment_member_date
          (organization_id, payer_member_id, payment_date),

        KEY idx_mm_payment_branch_date
          (organization_id, branch_id, payment_date),

        CONSTRAINT fk_mm_payment_org
          FOREIGN KEY (organization_id)
          REFERENCES organizations (id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_payment_member
          FOREIGN KEY (organization_id, payer_member_id)
          REFERENCES members (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_payment_branch
          FOREIGN KEY (organization_id, branch_id)
          REFERENCES branches (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_payment_received_by
          FOREIGN KEY (organization_id, received_by_user_id)
          REFERENCES users (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_payment_voided_by
          FOREIGN KEY (organization_id, voided_by_user_id)
          REFERENCES users (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT chk_mm_payment_amount
          CHECK (amount > 0),

        CONSTRAINT chk_mm_payment_method
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

        CONSTRAINT chk_mm_payment_void
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
    `,
  },

  {
    name: 'member_membership_payment_allocations',
    constraints: [
      'fk_mm_allocation_org',
      'fk_mm_allocation_payment',
      'fk_mm_allocation_invoice',
      'fk_mm_allocation_created_by',
      'chk_mm_allocation_amount',
    ],
    sql: `
      CREATE TABLE IF NOT EXISTS member_membership_payment_allocations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id BIGINT UNSIGNED NOT NULL,

        payment_id BIGINT UNSIGNED NOT NULL,
        invoice_id BIGINT UNSIGNED NOT NULL,

        allocated_amount DECIMAL(12,2) NOT NULL,

        created_by_user_id BIGINT UNSIGNED NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),

        UNIQUE KEY uq_mm_allocation_org_id
          (organization_id, id),

        UNIQUE KEY uq_mm_allocation_payment_invoice
          (organization_id, payment_id, invoice_id),

        KEY idx_mm_allocation_invoice
          (organization_id, invoice_id),

        CONSTRAINT fk_mm_allocation_org
          FOREIGN KEY (organization_id)
          REFERENCES organizations (id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_allocation_payment
          FOREIGN KEY (organization_id, payment_id)
          REFERENCES member_membership_payments (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_allocation_invoice
          FOREIGN KEY (organization_id, invoice_id)
          REFERENCES member_membership_invoices (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_allocation_created_by
          FOREIGN KEY (organization_id, created_by_user_id)
          REFERENCES users (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT chk_mm_allocation_amount
          CHECK (allocated_amount > 0)
      ) ENGINE=InnoDB
        DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_unicode_ci
    `,
  },

  {
    name: 'member_membership_refunds',
    constraints: [
      'fk_mm_refund_org',
      'fk_mm_refund_allocation',
      'fk_mm_refund_branch',
      'fk_mm_refund_created_by',
      'fk_mm_refund_voided_by',
      'chk_mm_refund_amount',
      'chk_mm_refund_method',
      'chk_mm_refund_void',
    ],
    sql: `
      CREATE TABLE IF NOT EXISTS member_membership_refunds (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id BIGINT UNSIGNED NOT NULL,

        refund_number VARCHAR(40) NOT NULL,
        payment_allocation_id BIGINT UNSIGNED NOT NULL,

        branch_id BIGINT UNSIGNED NOT NULL,

        refund_amount DECIMAL(12,2) NOT NULL,
        currency_code CHAR(3) NOT NULL,

        refund_method VARCHAR(30) NOT NULL,
        refund_reference VARCHAR(120) DEFAULT NULL,

        refund_date DATETIME NOT NULL,
        reason VARCHAR(500) NOT NULL,

        status ENUM('posted','voided') NOT NULL DEFAULT 'posted',
        voided_at DATETIME DEFAULT NULL,
        voided_by_user_id BIGINT UNSIGNED DEFAULT NULL,
        void_reason VARCHAR(500) DEFAULT NULL,

        notes VARCHAR(500) DEFAULT NULL,

        created_by_user_id BIGINT UNSIGNED NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),

        UNIQUE KEY uq_mm_refund_org_id
          (organization_id, id),

        UNIQUE KEY uq_mm_refund_number
          (organization_id, refund_number),

        KEY idx_mm_refund_allocation
          (organization_id, payment_allocation_id),

        KEY idx_mm_refund_branch_date
          (organization_id, branch_id, refund_date),

        CONSTRAINT fk_mm_refund_org
          FOREIGN KEY (organization_id)
          REFERENCES organizations (id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_refund_allocation
          FOREIGN KEY (organization_id, payment_allocation_id)
          REFERENCES member_membership_payment_allocations (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_refund_branch
          FOREIGN KEY (organization_id, branch_id)
          REFERENCES branches (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_refund_created_by
          FOREIGN KEY (organization_id, created_by_user_id)
          REFERENCES users (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT fk_mm_refund_voided_by
          FOREIGN KEY (organization_id, voided_by_user_id)
          REFERENCES users (organization_id, id)
          ON DELETE RESTRICT,

        CONSTRAINT chk_mm_refund_amount
          CHECK (refund_amount > 0),

        CONSTRAINT chk_mm_refund_method
          CHECK (
            refund_method IN (
              'original_method',
              'cash',
              'bank_transfer',
              'other'
            )
          ),

        CONSTRAINT chk_mm_refund_void
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
    `,
  },
];

async function tableExists(tableName) {
  const [rows] = await db.query(
    'SHOW TABLES LIKE ?',
    [tableName]
  );
  return rows.length > 0;
}

async function hasUniqueIndex(tableName, expectedColumns) {
  const [rows] = await db.query(
    `SHOW INDEX FROM \`${tableName}\``
  );

  const uniqueIndexes = new Map();

  for (const row of rows) {
    if (Number(row.Non_unique) !== 0) continue;

    if (!uniqueIndexes.has(row.Key_name)) {
      uniqueIndexes.set(row.Key_name, []);
    }

    uniqueIndexes.get(row.Key_name).push({
      position: Number(row.Seq_in_index),
      column: row.Column_name,
    });
  }

  return [...uniqueIndexes.values()].some((columns) => {
    const actual = columns
      .sort((a, b) => a.position - b.position)
      .map((item) => item.column);

    return (
      actual.length === expectedColumns.length &&
      actual.every((column, index) => column === expectedColumns[index])
    );
  });
}

async function verifyPrerequisites() {
  const [databaseRows] = await db.query(
    'SELECT DATABASE() AS database_name'
  );

  const databaseName = databaseRows[0]?.database_name;

  console.log(`Connected database: ${databaseName}`);

  if (databaseName !== 'gym_management_db') {
    throw new Error(
      `Wrong database selected. Expected gym_management_db, received ${databaseName}.`
    );
  }

  for (const table of REQUIRED_PARENT_TABLES) {
    if (!(await tableExists(table))) {
      throw new Error(`Required parent table is missing: ${table}`);
    }
  }

  const expectedUniqueKeys = [
    ['member_memberships', ['organization_id', 'id']],
    ['members', ['organization_id', 'id']],
    ['branches', ['organization_id', 'id']],
    ['users', ['organization_id', 'id']],
  ];

  for (const [table, columns] of expectedUniqueKeys) {
    if (!(await hasUniqueIndex(table, columns))) {
      throw new Error(
        `Required unique key (${columns.join(', ')}) is missing on ${table}.`
      );
    }
  }

  console.log('Parent tables and organization-scoped keys verified.');
}

async function createAndVerifyTable(spec) {
  const existedBefore = await tableExists(spec.name);

  await db.query(spec.sql);

  const [createRows] = await db.query(
    `SHOW CREATE TABLE \`${spec.name}\``
  );

  const createSql = createRows[0]?.['Create Table'];

  if (!createSql) {
    throw new Error(`Could not verify table ${spec.name}.`);
  }

  const [columns] = await db.query(
    `SHOW COLUMNS FROM \`${spec.name}\``
  );

  const columnNames = new Set(columns.map((column) => column.Field));

  const requiredColumns = {
    member_membership_invoices: [
      'organization_id',
      'membership_id',
      'primary_member_id',
      'branch_id',
      'invoice_number',
      'total_amount',
      'currency_code',
      'status',
      'created_by_user_id',
    ],
    member_membership_payments: [
      'organization_id',
      'payment_number',
      'payer_member_id',
      'branch_id',
      'amount',
      'currency_code',
      'payment_method',
      'status',
      'received_by_user_id',
    ],
    member_membership_payment_allocations: [
      'organization_id',
      'payment_id',
      'invoice_id',
      'allocated_amount',
      'created_by_user_id',
    ],
    member_membership_refunds: [
      'organization_id',
      'refund_number',
      'payment_allocation_id',
      'branch_id',
      'refund_amount',
      'currency_code',
      'refund_method',
      'status',
      'created_by_user_id',
    ],
  }[spec.name];

  for (const column of requiredColumns) {
    if (!columnNames.has(column)) {
      throw new Error(
        `Verification failed: ${spec.name}.${column} is missing.`
      );
    }
  }

  for (const constraint of spec.constraints) {
    if (!createSql.includes(`CONSTRAINT \`${constraint}\``)) {
      throw new Error(
        `Verification failed: ${spec.name} is missing constraint ${constraint}.`
      );
    }
  }

  console.log(
    `${spec.name}: ${existedBefore ? 'already existed and verified' : 'created and verified'}`
  );
}

async function main() {
  await verifyPrerequisites();

  console.log('\nCreating membership billing tables...');

  for (const spec of TABLES) {
    await createAndVerifyTable(spec);
  }

  console.log('\n===== MEMBERSHIP BILLING MIGRATION SUCCESSFUL =====');

  for (const spec of TABLES) {
    console.log(`Verified: ${spec.name}`);
  }

  console.log('\nExisting membership and membership-plan tables were not modified.');
}

main()
  .catch((error) => {
    console.error('\nMEMBERSHIP BILLING MIGRATION FAILED');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
