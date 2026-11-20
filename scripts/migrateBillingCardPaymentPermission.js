'use strict';

const db = require('../src/config/db');

const {
  syncAllGymAdminRolePermissions,
} = require('../src/services/gymAdminPermissionService');

async function main() {
  const connection = await db.getConnection();

  try {
    const [databaseRows] = await connection.query(
      'SELECT DATABASE() AS database_name'
    );

    if (databaseRows[0]?.database_name !== 'gym_management_db') {
      throw new Error('Wrong database selected.');
    }

    await connection.beginTransaction();

    await connection.query(
      `INSERT INTO permissions
        (
          permission_key,
          module_name,
          description,
          permission_scope,
          gym_admin_default
        )
       VALUES (
         'member_billing.payments.receive.card',
         'Billing & Collections',
         'Receive card payments',
         'gym',
         1
       )
       ON DUPLICATE KEY UPDATE
         module_name = VALUES(module_name),
         description = VALUES(description),
         permission_scope = 'gym',
         gym_admin_default = 1`
    );

    const syncResult = await syncAllGymAdminRolePermissions(connection);

    if (syncResult.organizationsProcessed === 0) {
      throw new Error('No system Gym Admin roles were synchronized.');
    }

    const [rows] = await connection.query(
      `SELECT
         p.id,
         p.permission_key,
         COUNT(DISTINCT rp.role_id) AS assigned_system_roles
       FROM permissions p
       LEFT JOIN role_permissions rp
         ON rp.permission_id = p.id
       LEFT JOIN roles r
         ON r.id = rp.role_id
        AND r.name = 'Gym Admin'
        AND r.is_system_role = 1
       WHERE p.permission_key =
         'member_billing.payments.receive.card'
       GROUP BY p.id, p.permission_key`,
    );

    if (
      rows.length !== 1 ||
      Number(rows[0].assigned_system_roles) === 0
    ) {
      throw new Error('Card permission assignment verification failed.');
    }

    await connection.commit();

    console.log('\nCARD PAYMENT PERMISSION MIGRATION SUCCESSFUL');
    console.table(rows);
    console.log(
      `System Gym Admin roles synchronized: ${syncResult.organizationsProcessed}`
    );
    console.log('Custom roles modified: 0');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

main()
  .catch(error => {
    console.error('CARD PAYMENT PERMISSION MIGRATION FAILED:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (typeof db.end === 'function') {
      await db.end();
    }
  });
