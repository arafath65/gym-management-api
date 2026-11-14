require("dotenv").config();

const db = require("../src/config/db");
const {
  syncAllGymAdminRolePermissions,
} = require("../src/services/gymAdminPermissionService");

const run = async () => {
  let connection;
  let transactionStarted = false;

  try {
    const [tables] = await db.query(
      `SELECT TABLE_NAME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'permissions'
       LIMIT 1`
    );

    if (tables.length === 0) {
      throw new Error("The permissions table was not found in the configured database.");
    }

    const [columns] = await db.query(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'permissions'
         AND COLUMN_NAME = 'permission_scope'
       LIMIT 1`
    );

    if (columns.length === 0) {
      console.log("Adding permissions.permission_scope...");
      await db.query(
        `ALTER TABLE permissions
         ADD COLUMN permission_scope ENUM('gym', 'platform')
         NOT NULL DEFAULT 'gym'
         AFTER module_name`
      );
    } else {
      console.log("permissions.permission_scope already exists.");
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    // These legacy entries belong to Platform Admin operations.
    // licenses.view remains a Gym permission because it is already part of
    // the Gym Admin default permission set.
    await connection.query(
      `UPDATE permissions
       SET permission_scope = 'platform'
       WHERE permission_key LIKE 'organizations.%'
          OR permission_key IN ('licenses.activate', 'licenses.suspend')`
    );

    // Owners may delete unused custom roles. System roles remain protected
    // by the controller and cannot be deleted through this endpoint.
    await connection.query(
      `UPDATE permissions
       SET gym_admin_default = 1
       WHERE permission_key = 'roles.delete'
         AND permission_scope = 'gym'`
    );

    const syncResult = await syncAllGymAdminRolePermissions(connection);

    await connection.commit();
    transactionStarted = false;

    const [scopeCounts] = await connection.query(
      `SELECT permission_scope, COUNT(*) AS permission_count
       FROM permissions
       GROUP BY permission_scope
       ORDER BY permission_scope`
    );

    console.log("Gym permission-scope migration completed.");
    console.log("Permission counts:", scopeCounts);
    console.log(
      "Existing Gym Admin roles synchronized:",
      syncResult.organizationsProcessed
    );

    for (const item of syncResult.results) {
      console.log({
        organizationId: item.organizationId,
        roleId: item.roleId,
        permissionCount: item.permissionCount,
        addedPermissionKeys: item.addedPermissionKeys,
        removedPermissionKeys: item.removedPermissionKeys,
      });
    }
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Permission-scope migration rollback failed:", rollbackError);
      }
    }
    console.error("Gym permission-scope migration failed:", error);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await db.end();
  }
};

run();
