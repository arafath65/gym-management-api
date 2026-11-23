"use strict";

const db = require("../src/config/db");

const TABLE_NAME = "dashboard_membership_targets";
const TARGET_PERMISSION = "dashboard.membership_target.manage";

const REQUIRED_COLUMNS = [
  "id",
  "organization_id",
  "branch_id",
  "target_month",
  "target_count",
  "notes",
  "created_by_user_id",
  "updated_by_user_id",
  "created_at",
  "updated_at",
];

async function verifyDatabase(connection) {
  const [rows] = await connection.query(
    "SELECT DATABASE() AS database_name, VERSION() AS mysql_version"
  );

  const info = rows[0] || {};
  console.log("Connected database:", info);

  if (info.database_name !== "gym_management_db") {
    throw new Error(
      `Unexpected database "${info.database_name}". Expected gym_management_db. Migration stopped.`
    );
  }

  const version = String(info.mysql_version || "").match(/^(\d+)\.(\d+)/);

  if (!version || Number(version[1]) < 8) {
    throw new Error("MySQL 8.0 or newer is required.");
  }
}

async function createTargetTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS dashboard_membership_targets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      organization_id BIGINT UNSIGNED NOT NULL,
      branch_id BIGINT UNSIGNED NOT NULL,
      target_month DATE NOT NULL,
      target_count INT UNSIGNED NOT NULL DEFAULT 0,
      notes VARCHAR(500) NULL,
      created_by_user_id BIGINT UNSIGNED NOT NULL,
      updated_by_user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL
        DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

      PRIMARY KEY (id),

      UNIQUE KEY uq_dashboard_membership_target_org_branch_month
        (organization_id, branch_id, target_month),

      KEY ix_dashboard_membership_target_org_month
        (organization_id, target_month),

      CONSTRAINT fk_dashboard_membership_targets_org
        FOREIGN KEY (organization_id)
        REFERENCES organizations (id),

      CONSTRAINT fk_dashboard_membership_targets_branch
        FOREIGN KEY (organization_id, branch_id)
        REFERENCES branches (organization_id, id),

      CONSTRAINT fk_dashboard_membership_targets_created_by
        FOREIGN KEY (created_by_user_id)
        REFERENCES users (id),

      CONSTRAINT fk_dashboard_membership_targets_updated_by
        FOREIGN KEY (updated_by_user_id)
        REFERENCES users (id)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  const [columns] = await connection.query(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [TABLE_NAME]
  );

  const actualColumns = new Set(columns.map((row) => row.COLUMN_NAME));
  const missing = REQUIRED_COLUMNS.filter((column) => !actualColumns.has(column));

  if (missing.length > 0) {
    throw new Error(
      `Target table schema is incomplete. Missing columns: ${missing.join(", ")}`
    );
  }

  const [indexRows] = await connection.query(
    `SELECT COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = 'uq_dashboard_membership_target_org_branch_month'
     ORDER BY SEQ_IN_INDEX`,
    [TABLE_NAME]
  );

  const expectedIndex = ["organization_id", "branch_id", "target_month"];
  const actualIndex = indexRows.map((row) => row.COLUMN_NAME);

  if (
    actualIndex.length !== expectedIndex.length ||
    actualIndex.some((column, index) => column !== expectedIndex[index]) ||
    indexRows.some((row) => Number(row.NON_UNIQUE) !== 0)
  ) {
    throw new Error(
      "Target table unique index does not match the expected organization/branch/month definition."
    );
  }

  console.log("Target table schema verified.");
}

async function addTargetPermission(connection) {
  const [permissionColumns] = await connection.query(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'permissions'`
  );

  const permissionColumnNames = new Set(
    permissionColumns.map((row) => row.COLUMN_NAME)
  );

  const expectedPermissionColumns = [
    "permission_key",
    "module_name",
    "permission_scope",
    "description",
    "gym_admin_default",
  ];

  const missing = expectedPermissionColumns.filter(
    (column) => !permissionColumnNames.has(column)
  );

  if (missing.length > 0) {
    throw new Error(
      `Unexpected permissions table schema. Missing: ${missing.join(", ")}`
    );
  }

  await connection.query(
    `INSERT INTO permissions
      (
        permission_key,
        module_name,
        permission_scope,
        description,
        gym_admin_default
      )
     VALUES (?, 'Dashboard', 'gym', ?, 1)
     ON DUPLICATE KEY UPDATE
       module_name = 'Dashboard',
       permission_scope = 'gym',
       description = ?,
       gym_admin_default = 1`,
    [
      TARGET_PERMISSION,
      "Manage monthly membership targets for authorized branches.",
      "Manage monthly membership targets for authorized branches.",
    ]
  );

  const [permissionRows] = await connection.query(
    `SELECT id, permission_key, permission_scope, gym_admin_default
     FROM permissions
     WHERE permission_key = ?
     LIMIT 1`,
    [TARGET_PERMISSION]
  );

  if (
    permissionRows.length !== 1 ||
    permissionRows[0].permission_scope !== "gym" ||
    Number(permissionRows[0].gym_admin_default) !== 1
  ) {
    throw new Error("Dashboard target permission verification failed.");
  }

  const permissionId = Number(permissionRows[0].id);

  const [assignmentResult] = await connection.query(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT r.id, ?
     FROM roles r
     WHERE r.name = 'Gym Admin'
       AND r.is_system_role = 1`,
    [permissionId]
  );

  console.log("Target permission verified:", permissionRows[0]);
  console.log(
    "Existing system Gym Admin roles given the new permission:",
    assignmentResult.affectedRows
  );
}

async function runMigration() {
  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    await verifyDatabase(connection);

    await createTargetTable(connection);

    await connection.beginTransaction();
    transactionStarted = true;

    await addTargetPermission(connection);

    await connection.commit();
    transactionStarted = false;

    const [tableRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?`,
      [TABLE_NAME]
    );

    const [targetPermissionRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM permissions
       WHERE permission_key = ?
         AND permission_scope = 'gym'`,
      [TARGET_PERMISSION]
    );

    if (
      Number(tableRows[0]?.total) !== 1 ||
      Number(targetPermissionRows[0]?.total) !== 1
    ) {
      throw new Error("Final migration verification failed.");
    }

    console.log("");
    console.log("===== DASHBOARD TARGET MIGRATION SUCCESSFUL =====");
    console.log("Target table:", TABLE_NAME);
    console.log("Permission:", TARGET_PERMISSION);
    console.log("Membership, attendance and billing tables were not modified.");
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Migration rollback failed:", rollbackError.message);
      }
    }

    throw error;
  } finally {
    connection.release();
  }
}

runMigration()
  .catch((error) => {
    console.error("DASHBOARD TARGET MIGRATION FAILED:");
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });