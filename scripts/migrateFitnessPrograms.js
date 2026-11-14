const db = require("../src/config/db");
const {
  syncAllGymAdminRolePermissions,
} = require("../src/services/gymAdminPermissionService");

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS fitness_programs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  program_code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(80) NOT NULL,
  description TEXT NULL,
  duration_value SMALLINT UNSIGNED NOT NULL,
  duration_unit ENUM('day', 'week', 'month', 'year') NOT NULL,
  instructions TEXT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  updated_by_user_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fitness_programs_org_code (organization_id, program_code),
  UNIQUE KEY uq_fitness_programs_org_id (organization_id, id),
  KEY idx_fitness_programs_org_status (organization_id, status),
  KEY idx_fitness_programs_org_category (organization_id, category),
  KEY idx_fitness_programs_org_created (organization_id, created_at),
  CONSTRAINT fk_fitness_programs_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fitness_programs_created_by
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fitness_programs_updated_by
    FOREIGN KEY (organization_id, updated_by_user_id)
    REFERENCES users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_fitness_programs_duration CHECK (duration_value >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const PERMISSIONS = [
  { key: "fitness_programs.view", description: "View fitness programs" },
  { key: "fitness_programs.create", description: "Create fitness programs" },
  { key: "fitness_programs.update", description: "Update fitness programs" },
  { key: "fitness_programs.deactivate", description: "Deactivate fitness programs" },
];

async function main() {
  let connection;
  try {
    console.log("Creating fitness_programs table if required...");
    await db.query(CREATE_TABLE_SQL);

    connection = await db.getConnection();
    await connection.beginTransaction();

    for (const permission of PERMISSIONS) {
      await connection.query(
        `INSERT INTO permissions
          (permission_key, module_name, description, gym_admin_default)
         VALUES (?, 'Fitness Programs', ?, 1)
         ON DUPLICATE KEY UPDATE
           module_name = VALUES(module_name),
           description = VALUES(description),
           gym_admin_default = 1`,
        [permission.key, permission.description]
      );
    }

    const syncResult = await syncAllGymAdminRolePermissions(connection);

    const [permissionRows] = await connection.query(
      `SELECT id, permission_key, module_name, gym_admin_default
       FROM permissions
       WHERE permission_key LIKE 'fitness_programs.%'
       ORDER BY permission_key`
    );

    const [roleRows] = await connection.query(
      `SELECT r.organization_id, r.id AS role_id, r.name AS role_name,
              COUNT(DISTINCT p.permission_key) AS fitness_program_permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p
         ON p.id = rp.permission_id
        AND p.permission_key LIKE 'fitness_programs.%'
       WHERE r.name = 'Gym Admin' AND r.is_system_role = 1
       GROUP BY r.organization_id, r.id, r.name
       ORDER BY r.organization_id`
    );

    const rolesValid = roleRows.length > 0 && roleRows.every(
      role => Number(role.fitness_program_permissions) === 4
    );

    if (permissionRows.length !== 4 || !rolesValid) {
      throw new Error("Verification failed: expected 4 permissions on every system Gym Admin role.");
    }

    await connection.commit();

    console.log("\n===== FITNESS PROGRAM PERMISSIONS =====");
    console.table(permissionRows);
    console.log("\n===== GYM ADMIN ROLE VERIFICATION =====");
    console.table(roleRows);
    console.log("\nMIGRATION SUCCESSFUL");
    console.log(JSON.stringify({
      success: true,
      table: "fitness_programs",
      permissions: permissionRows.length,
      organizationsProcessed: syncResult.organizationsProcessed,
      gymAdminRoles: roleRows.length,
      customRolesModified: false,
    }, null, 2));
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error("FITNESS PROGRAM MIGRATION FAILED:", error.code || "", error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await db.end();
  }
}

main();