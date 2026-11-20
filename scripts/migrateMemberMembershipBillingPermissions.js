'use strict';

const db = require('../src/config/db');

const MODULE_NAME = 'Membership Billing';

const PERMISSIONS = [
  {
    key: 'member_billing.view',
    description: 'View membership invoices, payments and refunds.',
  },
  {
    key: 'member_billing.invoices.create',
    description: 'Create membership billing invoices.',
  },
  {
    key: 'member_billing.invoices.void',
    description: 'Void an incorrect membership invoice.',
  },
  {
    key: 'member_billing.payments.receive',
    description: 'Receive and record membership payments.',
  },
  {
    key: 'member_billing.payments.void',
    description: 'Void an incorrect membership payment.',
  },
  {
    key: 'member_billing.refunds.manage',
    description: 'Create and void membership refund records.',
  },
];

async function verifySchema() {
  const [databaseRows] = await db.query(
    'SELECT DATABASE() AS database_name'
  );

  if (databaseRows[0]?.database_name !== 'gym_management_db') {
    throw new Error(
      `Wrong database: ${databaseRows[0]?.database_name}`
    );
  }

  const [permissionColumns] = await db.query(
    'SHOW COLUMNS FROM permissions'
  );

  const permissionColumnNames = new Set(
    permissionColumns.map((column) => column.Field)
  );

  const requiredPermissionColumns = [
    'permission_key',
    'module_name',
    'description',
    'permission_scope',
    'gym_admin_default',
  ];

  for (const column of requiredPermissionColumns) {
    if (!permissionColumnNames.has(column)) {
      throw new Error(
        `permissions.${column} is missing.`
      );
    }
  }

  const [roleColumns] = await db.query(
    'SHOW COLUMNS FROM roles'
  );

  const roleColumnNames = new Set(
    roleColumns.map((column) => column.Field)
  );

  for (const column of ['id', 'organization_id', 'is_system_role']) {
    if (!roleColumnNames.has(column)) {
      throw new Error(`roles.${column} is missing.`);
    }
  }

  const [rolePermissionTables] = await db.query(
    "SHOW TABLES LIKE 'role_permissions'"
  );

  if (rolePermissionTables.length === 0) {
    throw new Error('role_permissions table is missing.');
  }

  const [assignmentColumns] = await db.query(
    'SHOW COLUMNS FROM role_permissions'
  );

  const assignmentColumnNames = new Set(
    assignmentColumns.map((column) => column.Field)
  );

  for (const column of ['role_id', 'permission_id']) {
    if (!assignmentColumnNames.has(column)) {
      throw new Error(`role_permissions.${column} is missing.`);
    }
  }

  console.log('Database and permission schema verified.');
}

async function main() {
  await verifySchema();

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // Insert or refresh only the six explicitly defined permissions.
    for (const permission of PERMISSIONS) {
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
          permission.key,
          MODULE_NAME,
          permission.description,
        ]
      );
    }

    const permissionKeys = PERMISSIONS.map((item) => item.key);
    const placeholders = permissionKeys.map(() => '?').join(', ');

    // Synchronize only system Gym Admin roles.
    // Custom roles are never modified by this migration.
    const [insertResult] = await connection.query(
      `INSERT IGNORE INTO role_permissions
        (role_id, permission_id)
       SELECT
         r.id,
         p.id
       FROM roles r
       INNER JOIN permissions p
         ON p.permission_key IN (${placeholders})
        AND p.permission_scope = 'gym'
        AND p.gym_admin_default = 1
       WHERE r.is_system_role = 1`,
      permissionKeys
    );

    const [systemRoles] = await connection.query(
      `SELECT
         id,
         organization_id
       FROM roles
       WHERE is_system_role = 1
       ORDER BY organization_id, id`
    );

    if (systemRoles.length === 0) {
      throw new Error(
        'No system Gym Admin roles were found. Permission assignments were not committed.'
      );
    }

    // Verify all six permissions exist and are assigned to every system
    // Gym Admin role.
    const [verificationRows] = await connection.query(
      `SELECT
         r.id AS role_id,
         r.organization_id,
         COUNT(DISTINCT p.id) AS assigned_billing_permissions
       FROM roles r
       LEFT JOIN role_permissions rp
         ON rp.role_id = r.id
       LEFT JOIN permissions p
         ON p.id = rp.permission_id
        AND p.permission_key IN (${placeholders})
        AND p.permission_scope = 'gym'
       WHERE r.is_system_role = 1
       GROUP BY r.id, r.organization_id
       ORDER BY r.organization_id, r.id`,
      permissionKeys
    );

    for (const row of verificationRows) {
      if (Number(row.assigned_billing_permissions) !== PERMISSIONS.length) {
        throw new Error(
          `Billing permission verification failed for role ${row.role_id}, organization ${row.organization_id}.`
        );
      }
    }

    const [permissionRows] = await connection.query(
      `SELECT id, permission_key, module_name, permission_scope,
              gym_admin_default
       FROM permissions
       WHERE permission_key IN (${placeholders})
       ORDER BY id`,
      permissionKeys
    );

    if (permissionRows.length !== PERMISSIONS.length) {
      throw new Error('Not all six billing permissions were verified.');
    }

    await connection.commit();

    console.log('\n===== MEMBERSHIP BILLING PERMISSIONS SUCCESSFUL =====');
    console.table(permissionRows);

    console.log('\nSystem Gym Admin roles synchronized:');
    console.table(
      verificationRows.map((row) => ({
        organization_id: row.organization_id,
        role_id: row.role_id,
        billing_permissions: Number(row.assigned_billing_permissions),
      }))
    );

    console.log(`New role assignments: ${insertResult.affectedRows}`);
    console.log('Custom roles modified: 0');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

main()
  .catch((error) => {
    console.error('\nMEMBERSHIP BILLING PERMISSION MIGRATION FAILED');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
