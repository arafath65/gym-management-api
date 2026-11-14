require("dotenv").config();

const db = require("../src/config/db");
const {
  syncAllGymAdminRolePermissions,
} = require("../src/services/gymAdminPermissionService");

const createHistoryTable = `
CREATE TABLE IF NOT EXISTS device_branch_transfer_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  from_branch_id BIGINT UNSIGNED DEFAULT NULL,
  from_branch_name VARCHAR(150) DEFAULT NULL,
  from_branch_code VARCHAR(50) DEFAULT NULL,
  to_branch_id BIGINT UNSIGNED NOT NULL,
  to_branch_name VARCHAR(150) NOT NULL,
  to_branch_code VARCHAR(50) NOT NULL,
  transferred_by_user_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) DEFAULT NULL,
  transferred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_device_transfer_history_device (organization_id, device_id, transferred_at, id),
  KEY idx_device_transfer_history_actor (organization_id, transferred_by_user_id, transferred_at),
  CONSTRAINT fk_device_transfer_history_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_device_transfer_history_device
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_device_transfer_history_from_branch
    FOREIGN KEY (organization_id, from_branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_device_transfer_history_to_branch
    FOREIGN KEY (organization_id, to_branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_device_transfer_history_actor
    FOREIGN KEY (organization_id, transferred_by_user_id)
    REFERENCES users (organization_id, id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

async function run() {
  // MySQL DDL commits implicitly, so create the append-only history table first.
  await db.query(createHistoryTable);

  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;

    await connection.query(
      `INSERT INTO permissions
         (permission_key, module_name, description, gym_admin_default)
       VALUES
         ('devices.view', 'Devices', 'View registered devices and branch assignments', 1),
         ('devices.transfer', 'Devices', 'Assign or transfer devices between organization branches', 1)
       ON DUPLICATE KEY UPDATE
         module_name = VALUES(module_name),
         description = VALUES(description),
         gym_admin_default = VALUES(gym_admin_default)`
    );

    const syncResult = await syncAllGymAdminRolePermissions(connection);
    await connection.commit();
    transactionStarted = false;

    console.log("Gym device branch-transfer migration completed.");
    console.log("History table: device_branch_transfer_history");
    console.log("Permissions: devices.view, devices.transfer");
    console.log(JSON.stringify(syncResult, null, 2));
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

run().catch((error) => {
  console.error("Gym device branch-transfer migration failed:", error);
  process.exitCode = 1;
});