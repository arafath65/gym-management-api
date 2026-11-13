
/**
 * Gym Admin Permission Service
 *
 * Synchronizes only organization-scoped system Gym Admin roles.
 * Custom staff roles are never modified.
 *
 * This service must be executed inside an existing DB transaction.
 */

const syncGymAdminRolePermissions = async (
  connection,
  { organizationId, roleId }
) => {
  if (
    !connection ||
    typeof connection.query !== "function" ||
    organizationId == null ||
    roleId == null
  ) {
    throw new Error("Invalid Gym Admin permission synchronization input");
  }

  // Verify and lock the correct system Gym Admin role.
  const [roles] = await connection.query(
    `SELECT id, organization_id
     FROM roles
     WHERE id = ?
       AND organization_id = ?
       AND name = 'Gym Admin'
       AND is_system_role = 1
     LIMIT 1
     FOR UPDATE`,
    [roleId, organizationId]
  );

  if (roles.length !== 1) {
    throw new Error(
      `System Gym Admin role not found for organization ${organizationId}`
    );
  }

  // Retrieve all permissions currently eligible for Gym Admin.
  const [defaultPermissions] = await connection.query(
    `SELECT id, permission_key
     FROM permissions
     WHERE gym_admin_default = 1
     ORDER BY permission_key ASC`
  );

  if (defaultPermissions.length === 0) {
    throw new Error("No Gym Admin default permissions are configured");
  }

  // Retrieve current role assignments.
  const [currentPermissions] = await connection.query(
    `SELECT
       rp.permission_id,
       p.permission_key
     FROM role_permissions rp
     INNER JOIN permissions p
       ON p.id = rp.permission_id
     WHERE rp.role_id = ?
     ORDER BY p.permission_key ASC`,
    [roleId]
  );

  const desiredIds = new Set(
    defaultPermissions.map((permission) => String(permission.id))
  );

  const currentIds = new Set(
    currentPermissions.map((permission) =>
      String(permission.permission_id)
    )
  );

  // Find missing permissions.
  const permissionsToAdd = defaultPermissions.filter(
    (permission) => !currentIds.has(String(permission.id))
  );

  // Find permissions which are no longer eligible.
  const permissionsToRemove = currentPermissions.filter(
    (permission) => !desiredIds.has(String(permission.permission_id))
  );

  // Insert missing permissions.
  if (permissionsToAdd.length > 0) {
    const placeholders = permissionsToAdd
      .map(() => "(?, ?)")
      .join(", ");

    const values = permissionsToAdd.flatMap((permission) => [
      roleId,
      permission.id,
    ]);

    await connection.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES ${placeholders}`,
      values
    );
  }

  // Remove excluded permissions from this system role only.
  if (permissionsToRemove.length > 0) {
    const placeholders = permissionsToRemove
      .map(() => "?")
      .join(", ");

    await connection.query(
      `DELETE FROM role_permissions
       WHERE role_id = ?
         AND permission_id IN (${placeholders})`,
      [
        roleId,
        ...permissionsToRemove.map(
          (permission) => permission.permission_id
        ),
      ]
    );
  }

  return {
    organizationId,
    roleId,
    permissionCount: defaultPermissions.length,

    permissionKeys: defaultPermissions.map(
      (permission) => permission.permission_key
    ),

    addedPermissionKeys: permissionsToAdd.map(
      (permission) => permission.permission_key
    ),

    removedPermissionKeys: permissionsToRemove.map(
      (permission) => permission.permission_key
    ),
  };
};

/**
 * Synchronize every existing organization-scoped system Gym Admin role.
 *
 * Intended for permission catalogue migrations/deployments.
 * Caller must provide an active database transaction.
 */
const syncAllGymAdminRolePermissions = async (connection) => {
  const [roles] = await connection.query(
    `SELECT id, organization_id
     FROM roles
     WHERE name = 'Gym Admin'
       AND is_system_role = 1
     ORDER BY organization_id, id
     FOR UPDATE`
  );

  const results = [];

  for (const role of roles) {
    const result = await syncGymAdminRolePermissions(connection, {
      organizationId: role.organization_id,
      roleId: role.id,
    });

    results.push(result);
  }

  return {
    organizationsProcessed: results.length,
    results,
  };
};

module.exports = {
  syncGymAdminRolePermissions,
  syncAllGymAdminRolePermissions,
};
