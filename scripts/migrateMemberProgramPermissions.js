'use strict';

const db = require('../src/config/db');
const {
  syncAllGymAdminRolePermissions,
} = require('../src/services/gymAdminPermissionService');

const PERMISSIONS = [
  {
    key: 'member_programs.view',
    description: 'View fitness program assignments and member program history.',
  },
  {
    key: 'member_programs.assign',
    description: 'Assign fitness programs to members.',
  },
  {
    key: 'member_programs.update',
    description: 'Update member program assignment status.',
  },
];

async function verifyPermissionSchema(connection) {
  const [columns] = await connection.query(
    'SHOW COLUMNS FROM permissions'
  );

  const names = new Set(columns.map((column) => column.Field));

  const required = [
    'permission_key',
    'module_name',
    'description',
    'permission_scope',
    'gym_admin_default',
  ];

  const missing = required.filter((name) => !names.has(name));

  if (missing.length > 0) {
    throw new Error(
      `permissions table is missing required columns: ${missing.join(', ')}`
    );
  }
}

async function verifyPermissionRows(connection) {
  const keys = PERMISSIONS.map((permission) => permission.key);
  const placeholders = keys.map(() => '?').join(', ');

  const [rows] = await connection.query(
    `SELECT
       id,
       permission_key,
       module_name,
       permission_scope,
       gym_admin_default
     FROM permissions
     WHERE permission_key IN (${placeholders})
     ORDER BY permission_key`,
    keys
  );

  if (rows.length !== PERMISSIONS.length) {
    throw new Error('Permission catalogue verification failed.');
  }

  for (const row of rows) {
    if (
      row.module_name !== 'Member Programs' ||
      row.permission_scope !== 'gym' ||
      Number(row.gym_admin_default) !== 1
    ) {
      throw new Error(
        `Incorrect permission metadata for ${row.permission_key}.`
      );
    }
  }

  return rows;
}

async function main() {
  let connection;
  let transactionStarted = false;

  try {
    console.log('Starting Member Program permission migration...');

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    await verifyPermissionSchema(connection);

    const values = PERMISSIONS.flatMap((permission) => [
      permission.key,
      'Member Programs',
      permission.description,
      'gym',
      1,
    ]);

    const placeholders = PERMISSIONS
      .map(() => '(?, ?, ?, ?, ?)')
      .join(', ');

    await connection.query(
      `INSERT INTO permissions
         (
           permission_key,
           module_name,
           description,
           permission_scope,
           gym_admin_default
         )
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         module_name = VALUES(module_name),
         description = VALUES(description),
         permission_scope = VALUES(permission_scope),
         gym_admin_default = VALUES(gym_admin_default)`,
      values
    );

    console.log('Permission catalogue entries inserted or verified.');

    // This service synchronizes only system Gym Admin roles.
    // Custom roles are not modified.
    const syncResult = await syncAllGymAdminRolePermissions(connection);

    const permissionRows = await verifyPermissionRows(connection);

    const [assignmentRows] = await connection.query(
      `SELECT
         r.organization_id,
         r.id AS role_id,
         p.permission_key
       FROM roles r
       INNER JOIN role_permissions rp
         ON rp.role_id = r.id
       INNER JOIN permissions p
         ON p.id = rp.permission_id
       WHERE r.name = 'Gym Admin'
         AND r.is_system_role = 1
         AND p.permission_key IN (?, ?, ?)
       ORDER BY r.organization_id, p.permission_key`,
      PERMISSIONS.map((permission) => permission.key)
    );

    const expectedAssignments =
      syncResult.organizationsProcessed * PERMISSIONS.length;

    if (assignmentRows.length !== expectedAssignments) {
      throw new Error(
        `Gym Admin assignment verification failed. Expected ${expectedAssignments}, found ${assignmentRows.length}.`
      );
    }

    await connection.commit();
    transactionStarted = false;

    console.log('\n===== MEMBER PROGRAM PERMISSIONS SUCCESSFUL =====');
    console.table(permissionRows);
    console.log(
      `System Gym Admin organizations synchronized: ${syncResult.organizationsProcessed}`
    );
    console.log(
      `New permission assignments verified: ${assignmentRows.length}`
    );

    for (const result of syncResult.results) {
      console.log(
        `Organization ${result.organizationId}, role ${result.roleId}:`,
        `added ${result.addedPermissionKeys.length}`,
        'default permission(s)'
      );
    }
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Permission migration rollback failed:', rollbackError.message);
      }
    }

    throw error;
  } finally {
    if (connection) connection.release();
  }
}

main()
  .catch((error) => {
    console.error(
      '\nMEMBER PROGRAM PERMISSION MIGRATION FAILED:',
      error.code || '',
      error.message
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
