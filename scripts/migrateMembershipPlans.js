const db = require("../src/config/db");
const {
  syncAllGymAdminRolePermissions,
} = require("../src/services/gymAdminPermissionService");

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS membership_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,

  plan_code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NULL,

  package_type ENUM('individual', 'couple')
    NOT NULL DEFAULT 'individual',

  tier VARCHAR(50) DEFAULT NULL,

  validity_type ENUM('fixed', 'ongoing') NOT NULL DEFAULT 'fixed',

  duration_value SMALLINT UNSIGNED NULL,
  duration_unit ENUM('day', 'week', 'month', 'year') NULL,

  billing_interval_value SMALLINT UNSIGNED NULL,
  billing_interval_unit ENUM('day', 'week', 'month', 'year') NULL,

  price DECIMAL(12,2) NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'LKR',

  included_members SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  paying_members SMALLINT UNSIGNED NOT NULL DEFAULT 1,


  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',

  created_by_user_id BIGINT UNSIGNED NOT NULL,
  updated_by_user_id BIGINT UNSIGNED DEFAULT NULL,

  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  UNIQUE KEY uq_membership_plans_org_code
    (organization_id, plan_code),

  UNIQUE KEY uq_membership_plans_org_id
    (organization_id, id),

  KEY idx_membership_plans_org_status
    (organization_id, status),

  KEY idx_membership_plans_org_created
    (organization_id, created_at),

  CONSTRAINT fk_membership_plans_organization
    FOREIGN KEY (organization_id)
    REFERENCES organizations (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_membership_plans_created_by
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_membership_plans_updated_by
    FOREIGN KEY (organization_id, updated_by_user_id)
    REFERENCES users (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT chk_membership_plans_price
    CHECK (price >= 0),

  CONSTRAINT chk_membership_plans_duration
    CHECK (duration_value >= 1),

  CONSTRAINT chk_membership_plans_validity_config
    CHECK (
      (
        validity_type = 'fixed'
        AND duration_value IS NOT NULL
        AND duration_value >= 1
        AND duration_unit IS NOT NULL
        AND billing_interval_value IS NULL
        AND billing_interval_unit IS NULL
      )
      OR
      (
        validity_type = 'ongoing'
        AND duration_value IS NULL
        AND duration_unit IS NULL
        AND billing_interval_value IS NOT NULL
        AND billing_interval_value >= 1
        AND billing_interval_unit IS NOT NULL
      )
    ),

  CONSTRAINT chk_membership_plans_member_counts
    CHECK (
      included_members >= paying_members
      AND paying_members >= 1
    ),

  CONSTRAINT chk_membership_plans_individual
    CHECK (
      package_type <> 'individual'
      OR (included_members = 1 AND paying_members = 1)
    ),

  CONSTRAINT chk_membership_plans_couple
    CHECK (
      package_type <> 'couple'
      OR (included_members = 2 AND paying_members = 1)
    )

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
`;

const PERMISSIONS = [
  {
    key: "membership_plans.view",
    description: "View membership plans",
  },
  {
    key: "membership_plans.create",
    description: "Create membership plans",
  },
  {
    key: "membership_plans.update",
    description: "Update membership plans",
  },
  {
    key: "membership_plans.deactivate",
    description: "Deactivate membership plans",
  },
];

async function main() {
  let connection;

  try {
    console.log("Creating membership_plans table if required...");

    await db.query(CREATE_TABLE_SQL);

    connection = await db.getConnection();
    await connection.beginTransaction();

    for (const permission of PERMISSIONS) {
      await connection.query(
        `INSERT INTO permissions
          (permission_key, module_name, description, gym_admin_default)
         VALUES (?, 'Membership Plans', ?, 1)
         ON DUPLICATE KEY UPDATE
           module_name = VALUES(module_name),
           description = VALUES(description),
           gym_admin_default = 1`,
        [permission.key, permission.description]
      );
    }

    console.log("Synchronizing existing system Gym Admin roles...");

    const syncResult =
      await syncAllGymAdminRolePermissions(connection);

    await connection.commit();

    const [permissionRows] = await connection.query(
      `SELECT id, permission_key, module_name, gym_admin_default
       FROM permissions
       WHERE permission_key LIKE 'membership_plans.%'
       ORDER BY permission_key`
    );

    const [roleRows] = await connection.query(
      `SELECT
         r.organization_id,
         r.id AS role_id,
         r.name AS role_name,
         COUNT(DISTINCT p.permission_key) AS membership_plan_permissions
       FROM roles r
       LEFT JOIN role_permissions rp
         ON rp.role_id = r.id
       LEFT JOIN permissions p
         ON p.id = rp.permission_id
        AND p.permission_key LIKE 'membership_plans.%'
       WHERE r.name = 'Gym Admin'
         AND r.is_system_role = 1
       GROUP BY r.organization_id, r.id, r.name
       ORDER BY r.organization_id`
    );

    console.log("\n===== MEMBERSHIP PLAN PERMISSIONS =====");
    console.table(permissionRows);

    console.log("\n===== GYM ADMIN VERIFICATION =====");
    console.table(roleRows);

    const permissionCount = permissionRows.length;
    const rolesValid = roleRows.every(
      (role) => Number(role.membership_plan_permissions) === 4
    );

    if (permissionCount !== 4 || !rolesValid) {
      throw new Error(
        "Verification failed. Expected 4 permissions for every system Gym Admin role."
      );
    }

    console.log("\n===== MIGRATION SUCCESSFUL =====");
    console.log(
      JSON.stringify(
        {
          success: true,
          table: "membership_plans",
          permissionsCreatedOrUpdated: permissionCount,
          organizationsProcessed: syncResult.organizationsProcessed,
          gymAdminRoles: roleRows.length,
          customRolesModified: false,
        },
        null,
        2
      )
    );

  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {}
    }

    console.error("\nMEMBERSHIP PLAN MIGRATION FAILED:");
    console.error(error.message);

    process.exitCode = 1;

  } finally {
    if (connection) {
      connection.release();
    }

    await db.end();
  }
}

main();