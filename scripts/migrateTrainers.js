const db = require("../src/config/db");

const {
  syncAllGymAdminRolePermissions,
} = require("../src/services/gymAdminPermissionService");

// --------------------------------------------------
// 1. TRAINERS TABLE
// One trainer profile belongs to one organization.
// --------------------------------------------------

const CREATE_TRAINERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS trainers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,

  trainer_code VARCHAR(30) NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  email VARCHAR(150) DEFAULT NULL,
  address TEXT DEFAULT NULL,

  specialization VARCHAR(255) DEFAULT NULL,
  qualifications TEXT DEFAULT NULL,
  experience_years SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  bio TEXT DEFAULT NULL,
  profile_photo_path VARCHAR(500) DEFAULT NULL,

  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',

  created_by_user_id BIGINT UNSIGNED NOT NULL,
  updated_by_user_id BIGINT UNSIGNED DEFAULT NULL,

  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  UNIQUE KEY uq_trainers_org_code
    (organization_id, trainer_code),

  UNIQUE KEY uq_trainers_org_id
    (organization_id, id),

  KEY idx_trainers_org_status
    (organization_id, status),

  KEY idx_trainers_org_name
    (organization_id, full_name),

  KEY idx_trainers_org_created
    (organization_id, created_at),

  CONSTRAINT fk_trainers_organization
    FOREIGN KEY (organization_id)
    REFERENCES organizations (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_trainers_created_by
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_trainers_updated_by
    FOREIGN KEY (organization_id, updated_by_user_id)
    REFERENCES users (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT chk_trainers_experience
    CHECK (experience_years >= 0)

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
`;

// --------------------------------------------------
// 2. TRAINER BRANCH ACCESS TABLE
// One trainer may work at multiple branches.
// --------------------------------------------------

const CREATE_TRAINER_BRANCH_ACCESS_SQL = `
CREATE TABLE IF NOT EXISTS trainer_branch_access (
  organization_id BIGINT UNSIGNED NOT NULL,
  trainer_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,

  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',

  assigned_by_user_id BIGINT UNSIGNED NOT NULL,
  updated_by_user_id BIGINT UNSIGNED DEFAULT NULL,

  assigned_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (trainer_id, branch_id),

  KEY idx_trainer_branch_org_branch_status
    (organization_id, branch_id, status),

  KEY idx_trainer_branch_org_trainer_status
    (organization_id, trainer_id, status),

  KEY idx_trainer_branch_assigned_by
    (organization_id, assigned_by_user_id),

  KEY idx_trainer_branch_updated_by
    (organization_id, updated_by_user_id),

  CONSTRAINT fk_trainer_branch_trainer
    FOREIGN KEY (organization_id, trainer_id)
    REFERENCES trainers (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_trainer_branch_branch
    FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_trainer_branch_assigned_by
    FOREIGN KEY (organization_id, assigned_by_user_id)
    REFERENCES users (organization_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_trainer_branch_updated_by
    FOREIGN KEY (organization_id, updated_by_user_id)
    REFERENCES users (organization_id, id)
    ON DELETE RESTRICT

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
`;

// --------------------------------------------------
// 3. DYNAMIC GYM PERMISSIONS
// --------------------------------------------------

const PERMISSIONS = [
  {
    key: "trainers.view",
    description: "View trainers and trainer details",
  },
  {
    key: "trainers.create",
    description: "Create trainer profiles",
  },
  {
    key: "trainers.update",
    description: "Update trainer profiles and reactivate trainers",
  },
  {
    key: "trainers.deactivate",
    description: "Deactivate trainer profiles",
  },
  {
    key: "trainers.assign_branches",
    description: "Assign trainers to organization branches",
  },
];

// --------------------------------------------------
// 4. RUN MIGRATION
// --------------------------------------------------

const main = async () => {
  let connection;

  try {
    console.log("Creating trainers table...");
    await db.query(CREATE_TRAINERS_TABLE_SQL);

    console.log("Creating trainer_branch_access table...");
    await db.query(CREATE_TRAINER_BRANCH_ACCESS_SQL);

    connection = await db.getConnection();
    await connection.beginTransaction();

    console.log("Registering Trainer permissions...");

    for (const permission of PERMISSIONS) {
      await connection.query(
        `INSERT INTO permissions
          (
            permission_key,
            module_name,
            permission_scope,
            description,
            gym_admin_default
          )
         VALUES (?, 'Trainers', 'gym', ?, 1)
         ON DUPLICATE KEY UPDATE
           module_name = VALUES(module_name),
           permission_scope = 'gym',
           description = VALUES(description),
           gym_admin_default = 1`,
        [permission.key, permission.description]
      );
    }

    console.log("Synchronizing system Gym Admin roles...");

    const syncResult =
      await syncAllGymAdminRolePermissions(connection);

    // Verify the five permissions.
    const [permissionRows] = await connection.query(
      `SELECT
         id,
         permission_key,
         module_name,
         permission_scope,
         gym_admin_default
       FROM permissions
       WHERE permission_key LIKE 'trainers.%'
       ORDER BY permission_key`
    );

    // Verify every existing system Gym Admin role.
    const [roleRows] = await connection.query(
      `SELECT
         r.organization_id,
         r.id AS role_id,
         r.name AS role_name,
         COUNT(DISTINCT p.permission_key) AS trainer_permissions
       FROM roles r
       LEFT JOIN role_permissions rp
         ON rp.role_id = r.id
       LEFT JOIN permissions p
         ON p.id = rp.permission_id
        AND p.permission_key LIKE 'trainers.%'
       WHERE r.name = 'Gym Admin'
         AND r.is_system_role = 1
       GROUP BY r.organization_id, r.id, r.name
       ORDER BY r.organization_id`
    );

    const rolesValid =
      roleRows.length > 0 &&
      roleRows.every(
        role => Number(role.trainer_permissions) === PERMISSIONS.length
      );

    if (permissionRows.length !== PERMISSIONS.length || !rolesValid) {
      throw new Error(
        "Verification failed: expected five Trainer permissions on every system Gym Admin role."
      );
    }

    // Verify both tables exist.
    const [tableRows] = await connection.query(
      `SELECT TABLE_NAME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN ('trainers', 'trainer_branch_access')`
    );

    if (tableRows.length !== 2) {
      throw new Error("Trainer table verification failed.");
    }

    await connection.commit();

    console.log("\n========== TRAINER PERMISSIONS ==========");
    console.table(permissionRows);

    console.log("\n========== GYM ADMIN VERIFICATION ==========");
    console.table(roleRows);

    console.log("\n========== MIGRATION RESULT ==========");
    console.log(
      JSON.stringify(
        {
          success: true,
          tablesCreated: [
            "trainers",
            "trainer_branch_access",
          ],
          permissions: permissionRows.length,
          organizationsProcessed: syncResult.organizationsProcessed,
          gymAdminRoles: roleRows.length,
          customRolesModified: false,
          auditLogging: "Will use existing audit_logs table",
        },
        null,
        2
      )
    );

  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError.message);
      }
    }

    console.error("\nTRAINER MIGRATION FAILED:");
    console.error(error.code || "", error.message);

    process.exitCode = 1;

  } finally {
    if (connection) {
      connection.release();
    }

    await db.end();
  }
};

main();