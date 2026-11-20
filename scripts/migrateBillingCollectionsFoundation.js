'use strict';

const db = require('../src/config/db');

const {
  syncAllGymAdminRolePermissions,
} = require('../src/services/gymAdminPermissionService');

const REQUIRED_TABLES = [
  'organizations',
  'branches',
  'users',
  'members',
  'member_memberships',
  'membership_plans',
  'member_membership_invoices',
  'member_membership_billing_sequences',
];

const PERMISSIONS = [
  // Dashboard access
  ['member_billing.dashboard.view', 'Open Billing & Collections dashboard'],
  ['member_billing.monthly_calendar.view', 'View monthly collection calendar'],
  ['member_billing.yearly_dues.view', 'View yearly membership dues'],

  // Confidential summary cards - each independently controlled
  ['member_billing.dashboard.expected_collection.view', 'View expected collection amount'],
  ['member_billing.dashboard.collected_collection.view', 'View collected amount'],
  ['member_billing.dashboard.outstanding_collection.view', 'View outstanding collection amount'],
  ['member_billing.dashboard.overdue_members.view', 'View overdue member count and details'],

  // Member financial account
  ['member_billing.members.search', 'Search members in Billing & Collections'],
  ['member_billing.member_account.view', 'View a member financial account'],

  // Invoice operations
  ['member_billing.invoices.view', 'View membership invoices'],
  ['member_billing.invoices.create', 'Create membership invoices'],
  ['member_billing.invoices.void', 'Void membership invoices'],

  // Payment operations
  ['member_billing.payments.view', 'View payment and receipt details'],
  ['member_billing.payments.receive', 'Receive membership payments'],
  ['member_billing.payments.void', 'Void membership payments'],

  // Refund operations
  ['member_billing.refunds.view', 'View membership refunds'],
  ['member_billing.refunds.create', 'Create membership refunds'],
  ['member_billing.refunds.void', 'Void membership refunds'],

  // Invoice waiver operations
  ['member_billing.waivers.view', 'View membership invoice waivers'],
  ['member_billing.waivers.create', 'Waive unpaid membership invoice amounts'],
  ['member_billing.waivers.void', 'Void membership invoice waivers'],

  // Reports
  ['member_billing.reports.view', 'View financial reports'],
  ['member_billing.reports.export', 'Export financial reports'],

  // Manual membership status operations
  ['member_memberships.suspend', 'Manually suspend a membership'],
  ['member_memberships.reactivate', 'Reactivate a suspended membership'],

  // Legacy permissions - retained for compatibility
  ['member_billing.view', 'Legacy membership billing viewing permission'],
  ['member_billing.refunds.manage', 'Legacy membership refund management permission'],
];

async function getColumns(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );

  return rows;
}

async function getIndexes(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT DISTINCT INDEX_NAME
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );

  return new Set(rows.map(row => row.INDEX_NAME));
}

async function hasConstraint(connection, tableName, constraintName) {
  const [rows] = await connection.query(
    `SELECT CONSTRAINT_NAME
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?
     LIMIT 1`,
    [tableName, constraintName]
  );

  return rows.length > 0;
}

async function verifyDatabase(connection) {
  const [dbRows] = await connection.query(`
    SELECT
      DATABASE() AS database_name,
      CURRENT_DATE() AS database_date,
      NOW() AS database_datetime,
      @@session.time_zone AS session_timezone
  `);

  if (dbRows[0]?.database_name !== 'gym_management_db') {
    throw new Error(
      `Wrong database selected: ${dbRows[0]?.database_name}`
    );
  }

  console.log('\nDATABASE VERIFIED');
  console.table(dbRows);

  for (const table of REQUIRED_TABLES) {
    const [rows] = await connection.query(
      'SHOW TABLES LIKE ?',
      [table]
    );

    if (rows.length === 0) {
      throw new Error(`Required table is missing: ${table}`);
    }
  }

  console.log('All required parent and billing tables verified.');
}

async function extendMembershipSuspension(connection) {
  console.log('\n1. MEMBERSHIP SUSPENSION SUPPORT');

  let columns = await getColumns(connection, 'member_memberships');

  const statusColumn = columns.find(
    column => column.COLUMN_NAME === 'status'
  );

  if (!statusColumn) {
    throw new Error('member_memberships.status is missing.');
  }

  if (!statusColumn.COLUMN_TYPE.includes("'suspended'")) {
    await connection.query(`
      ALTER TABLE member_memberships
      MODIFY COLUMN status
        ENUM('active','suspended','expired','cancelled')
        NOT NULL DEFAULT 'active'
    `);

    console.log('Added suspended to membership status.');
  } else {
    console.log('Suspended status already exists.');
  }

  const additions = [
    {
      name: 'suspended_at',
      sql: 'ADD COLUMN suspended_at DATETIME NULL AFTER cancellation_reason',
    },
    {
      name: 'suspended_by_user_id',
      sql: 'ADD COLUMN suspended_by_user_id BIGINT UNSIGNED NULL AFTER suspended_at',
    },
    {
      name: 'suspension_reason',
      sql: 'ADD COLUMN suspension_reason VARCHAR(500) NULL AFTER suspended_by_user_id',
    },
  ];

  for (const item of additions) {
    columns = await getColumns(connection, 'member_memberships');

    if (!columns.some(column => column.COLUMN_NAME === item.name)) {
      await connection.query(
        `ALTER TABLE member_memberships ${item.sql}`
      );

      console.log(`Added member_memberships.${item.name}`);
    } else {
      console.log(`Verified member_memberships.${item.name}`);
    }
  }

  let indexes = await getIndexes(connection, 'member_memberships');

  if (!indexes.has('idx_mm_membership_billing_due')) {
    await connection.query(`
      ALTER TABLE member_memberships
      ADD INDEX idx_mm_membership_billing_due
        (organization_id, status, validity_type_snapshot, next_billing_date)
    `);
    console.log('Added recurring billing lookup index.');
  }

  indexes = await getIndexes(connection, 'member_memberships');

  if (!indexes.has('idx_member_memberships_suspended_by')) {
    await connection.query(`
      ALTER TABLE member_memberships
      ADD INDEX idx_member_memberships_suspended_by
        (organization_id, suspended_by_user_id)
    `);
    console.log('Added suspension user index.');
  }

  if (!await hasConstraint(
    connection,
    'member_memberships',
    'fk_member_memberships_suspended_by'
  )) {
    await connection.query(`
      ALTER TABLE member_memberships
      ADD CONSTRAINT fk_member_memberships_suspended_by
      FOREIGN KEY (organization_id, suspended_by_user_id)
      REFERENCES users (organization_id, id)
      ON DELETE RESTRICT
    `);

    console.log('Added suspension user foreign key.');
  }

  if (!await hasConstraint(
    connection,
    'member_memberships',
    'chk_member_memberships_suspended'
  )) {
    await connection.query(`
      ALTER TABLE member_memberships
      ADD CONSTRAINT chk_member_memberships_suspended
      CHECK (
        (
          status = 'suspended'
          AND suspended_at IS NOT NULL
          AND suspended_by_user_id IS NOT NULL
          AND suspension_reason IS NOT NULL
          AND CHAR_LENGTH(TRIM(suspension_reason)) > 0
        )
        OR
        (
          status <> 'suspended'
          AND suspended_at IS NULL
          AND suspended_by_user_id IS NULL
          AND suspension_reason IS NULL
        )
      )
    `);

    console.log('Added suspension status consistency check.');
  }

  console.log('Membership suspension schema verified.');
}

async function createWaiverTable(connection) {
  console.log('\n2. INVOICE WAIVER LEDGER');

  await connection.query(`
    CREATE TABLE IF NOT EXISTS member_membership_invoice_waivers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

      organization_id BIGINT UNSIGNED NOT NULL,
      waiver_number VARCHAR(40) NOT NULL,
      idempotency_key CHAR(36) DEFAULT NULL,

      invoice_id BIGINT UNSIGNED NOT NULL,
      branch_id BIGINT UNSIGNED NOT NULL,

      waiver_amount DECIMAL(12,2) NOT NULL,
      currency_code CHAR(3) NOT NULL,

      waiver_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reason VARCHAR(500) NOT NULL,

      status ENUM('posted','voided')
        NOT NULL DEFAULT 'posted',

      voided_at DATETIME DEFAULT NULL,
      voided_by_user_id BIGINT UNSIGNED DEFAULT NULL,
      void_reason VARCHAR(500) DEFAULT NULL,

      notes VARCHAR(500) DEFAULT NULL,
      created_by_user_id BIGINT UNSIGNED NOT NULL,

      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

      PRIMARY KEY (id),

      UNIQUE KEY uq_mm_waiver_org_id
        (organization_id, id),

      UNIQUE KEY uq_mm_waiver_number
        (organization_id, waiver_number),

      UNIQUE KEY uq_mm_waiver_idempotency
        (organization_id, idempotency_key),

      KEY idx_mm_waiver_invoice
        (organization_id, invoice_id, status),

      KEY idx_mm_waiver_branch_date
        (organization_id, branch_id, waiver_date),

      KEY idx_mm_waiver_created_by
        (organization_id, created_by_user_id),

      KEY idx_mm_waiver_voided_by
        (organization_id, voided_by_user_id),

      CONSTRAINT fk_mm_waiver_org
        FOREIGN KEY (organization_id)
        REFERENCES organizations (id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mm_waiver_invoice
        FOREIGN KEY (organization_id, invoice_id)
        REFERENCES member_membership_invoices (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mm_waiver_branch
        FOREIGN KEY (organization_id, branch_id)
        REFERENCES branches (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mm_waiver_created_by
        FOREIGN KEY (organization_id, created_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT fk_mm_waiver_voided_by
        FOREIGN KEY (organization_id, voided_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT,

      CONSTRAINT chk_mm_waiver_amount
        CHECK (waiver_amount > 0),

      CONSTRAINT chk_mm_waiver_reason
        CHECK (CHAR_LENGTH(TRIM(reason)) > 0),

      CONSTRAINT chk_mm_waiver_void
        CHECK (
          (
            status = 'voided'
            AND voided_at IS NOT NULL
            AND voided_by_user_id IS NOT NULL
            AND void_reason IS NOT NULL
            AND CHAR_LENGTH(TRIM(void_reason)) > 0
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

  const columns = await getColumns(
    connection,
    'member_membership_invoice_waivers'
  );

  const required = [
    'organization_id',
    'waiver_number',
    'idempotency_key',
    'invoice_id',
    'branch_id',
    'waiver_amount',
    'currency_code',
    'waiver_date',
    'reason',
    'status',
    'voided_at',
    'voided_by_user_id',
    'void_reason',
    'notes',
    'created_by_user_id',
  ];

  const available = new Set(columns.map(column => column.COLUMN_NAME));

  for (const column of required) {
    if (!available.has(column)) {
      throw new Error(
        `Waiver table is incomplete. Missing column: ${column}`
      );
    }
  }

  console.log('Invoice waiver ledger created and verified.');
}

async function extendBillingSequence(connection) {
  console.log('\n3. WAIVER DOCUMENT NUMBERING');

  const columns = await getColumns(
    connection,
    'member_membership_billing_sequences'
  );

  const documentType = columns.find(
    column => column.COLUMN_NAME === 'document_type'
  );

  if (!documentType) {
    throw new Error(
      'member_membership_billing_sequences.document_type is missing.'
    );
  }

  if (!documentType.COLUMN_TYPE.includes("'waiver'")) {
    for (const type of ['invoice', 'payment', 'refund']) {
      if (!documentType.COLUMN_TYPE.includes(`'${type}'`)) {
        throw new Error(
          `Unexpected billing sequence enum: ${documentType.COLUMN_TYPE}`
        );
      }
    }

    await connection.query(`
      ALTER TABLE member_membership_billing_sequences
      MODIFY COLUMN document_type
        ENUM('invoice','payment','refund','waiver')
        NOT NULL
    `);

    console.log('Added waiver document sequence type.');
  } else {
    console.log('Waiver document sequence already exists.');
  }
}

async function synchronizePermissions(connection) {
  console.log('\n4. GRANULAR BILLING PERMISSIONS');

  await connection.beginTransaction();

  try {
    for (const [key, description] of PERMISSIONS) {
      await connection.query(
        `INSERT INTO permissions
          (
            permission_key,
            module_name,
            description,
            permission_scope,
            gym_admin_default
          )
         VALUES (?, ?, ?, 'gym', 1)
         ON DUPLICATE KEY UPDATE
           module_name = VALUES(module_name),
           description = VALUES(description),
           permission_scope = 'gym',
           gym_admin_default = 1`,
        [
          key,
          key.startsWith('member_memberships.')
            ? 'Member Memberships'
            : 'Billing & Collections',
          description,
        ]
      );
    }

    const syncResult = await syncAllGymAdminRolePermissions(connection);

    if (syncResult.organizationsProcessed === 0) {
      throw new Error(
        'No system Gym Admin roles found. Permission synchronization was not committed.'
      );
    }

    const keys = PERMISSIONS.map(item => item[0]);
    const placeholders = keys.map(() => '?').join(', ');

    const [verification] = await connection.query(
      `SELECT
         r.id AS role_id,
         r.organization_id,
         COUNT(DISTINCT p.permission_key) AS assigned_permissions
       FROM roles r
       LEFT JOIN role_permissions rp
         ON rp.role_id = r.id
       LEFT JOIN permissions p
         ON p.id = rp.permission_id
        AND p.permission_key IN (${placeholders})
        AND p.permission_scope = 'gym'
       WHERE r.name = 'Gym Admin'
         AND r.is_system_role = 1
       GROUP BY r.id, r.organization_id
       ORDER BY r.organization_id, r.id`,
      keys
    );

    for (const row of verification) {
      if (Number(row.assigned_permissions) !== keys.length) {
        throw new Error(
          `Permission verification failed for Gym Admin role ${row.role_id}, organization ${row.organization_id}.`
        );
      }
    }

    await connection.commit();

    console.log(`Permissions registered: ${keys.length}`);
    console.log(
      `System Gym Admin roles synchronized: ${syncResult.organizationsProcessed}`
    );
    console.log('Custom staff roles modified: 0');
    console.table(verification);
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function main() {
  const connection = await db.getConnection();

  try {
    await verifyDatabase(connection);

    await extendMembershipSuspension(connection);

    await createWaiverTable(connection);

    await extendBillingSequence(connection);

    await synchronizePermissions(connection);

    console.log('\n==============================================');
    console.log(' BILLING COLLECTIONS FOUNDATION SUCCESSFUL');
    console.log('==============================================');

    console.log('\nVerified:');
    console.log('- Membership suspension schema');
    console.log('- Invoice waiver ledger');
    console.log('- Waiver document numbering');
    console.log('- Granular Billing & Collections permissions');
    console.log('- System Gym Admin permission synchronization');

    console.log('\nNo existing invoices, payments, allocations or refunds were deleted.');
  } finally {
    connection.release();
  }
}

main()
  .catch(error => {
    console.error('\nBILLING COLLECTIONS FOUNDATION FAILED');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
