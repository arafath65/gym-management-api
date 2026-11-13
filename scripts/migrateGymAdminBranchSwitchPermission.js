const db = require("../src/config/db");

const {
  syncAllGymAdminRolePermissions,
} = require("../src/services/gymAdminPermissionService");

const main = async () => {
  let connection;
  let transactionStarted = false;

  try {
    connection = await db.getConnection();

    await connection.beginTransaction();
    transactionStarted = true;

    // Add or update the branch switching permission.
    await connection.query(
      `INSERT INTO permissions
       (
         permission_key,
         module_name,
         description,
         gym_admin_default
       )
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         module_name = VALUES(module_name),
         description = VALUES(description),
         gym_admin_default = 1`,
      [
        "branches.switch",
        "Branches",
        "Switch the active working branch within authorized branch access",
      ]
    );

    // Synchronize only organization-scoped system Gym Admin roles.
    // Custom staff roles are not changed.
    const syncResult = await syncAllGymAdminRolePermissions(connection);

    // Verify the permission catalogue record.
    const [permissionRows] = await connection.query(
      `SELECT id, permission_key, module_name, gym_admin_default
       FROM permissions
       WHERE permission_key = ?
       LIMIT 1`,
      ["branches.switch"]
    );

    if (
      permissionRows.length !== 1 ||
      Number(permissionRows[0].gym_admin_default) !== 1
    ) {
      throw new Error("Branch switching permission verification failed");
    }

    // Verify every system Gym Admin role received it.
    const [roleRows] = await connection.query(
      `SELECT
         r.organization_id,
         r.id AS role_id,
         r.name AS role_name,
         COUNT(rp.permission_id) AS permission_count,
         SUM(p.permission_key = 'branches.switch') AS has_branch_switch
       FROM roles r
       LEFT JOIN role_permissions rp
         ON rp.role_id = r.id
       LEFT JOIN permissions p
         ON p.id = rp.permission_id
       WHERE r.name = 'Gym Admin'
         AND r.is_system_role = 1
       GROUP BY r.organization_id, r.id, r.name
       ORDER BY r.organization_id`
    );

    for (const role of roleRows) {
      if (
        Number(role.permission_count) !== 14 ||
        Number(role.has_branch_switch) !== 1
      ) {
        throw new Error(
          `Gym Admin permission verification failed for organization ${role.organization_id}`
        );
      }
    }

    await connection.commit();
    transactionStarted = false;

    console.log("\nBranch switching permission migration completed.");

    console.log(JSON.stringify({
      success: true,
      permission: permissionRows[0],
      organizationsProcessed: syncResult.organizationsProcessed,
      gymAdminRoles: roleRows,
      customRolesModified: false,
    }, null, 2));

  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError.message);
      }
    }

    console.error("\nBranch permission migration failed:", error);
    process.exitCode = 1;

  } finally {
    if (connection) {
      connection.release();
    }

    await db.end();
  }
};

main();