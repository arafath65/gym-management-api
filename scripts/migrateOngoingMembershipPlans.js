const fs = require("fs");
const path = require("path");
const db = require("../src/config/db");

const UNIT_ENUM = "ENUM('day', 'week', 'month', 'year')";

async function columnMap() {
  const [rows] = await db.query("SHOW COLUMNS FROM membership_plans");
  return new Map(rows.map((row) => [row.Field, row]));
}

async function hasCheckConstraint(name) {
  const [rows] = await db.query(
    `SELECT CONSTRAINT_NAME
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'membership_plans'
       AND CONSTRAINT_TYPE = 'CHECK'
       AND CONSTRAINT_NAME = ?
     LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

async function main() {
  const [tables] = await db.query("SHOW TABLES LIKE 'membership_plans'");
  if (tables.length === 0) {
    throw new Error("membership_plans table does not exist. Run its original migration first.");
  }

  const [schemaRows] = await db.query("SHOW CREATE TABLE membership_plans");
  const [existingPlans] = await db.query(
    "SELECT * FROM membership_plans ORDER BY id"
  );

  const backupDir = path.join(process.cwd(), "Temp");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const backupPath = path.join(
    backupDir,
    `membership_plans_before_ongoing_${stamp}.json`
  );
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        table: "membership_plans",
        create_table_sql: schemaRows[0]["Create Table"],
        rows: existingPlans,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Membership plan data/schema backup: ${backupPath}`);

  let columns = await columnMap();

  if (!columns.has("validity_type")) {
    console.log("Adding validity_type (existing plans default to fixed)...");
    await db.query(
      `ALTER TABLE membership_plans
       ADD COLUMN validity_type ENUM('fixed', 'ongoing')
       NOT NULL DEFAULT 'fixed' AFTER tier`
    );
  }

  columns = await columnMap();
  if (columns.get("duration_value")?.Null === "NO") {
    console.log("Allowing duration_value to be NULL for ongoing plans...");
    await db.query(
      "ALTER TABLE membership_plans MODIFY COLUMN duration_value SMALLINT UNSIGNED NULL"
    );
  }

  columns = await columnMap();
  if (columns.get("duration_unit")?.Null === "NO") {
    console.log("Allowing duration_unit to be NULL for ongoing plans...");
    await db.query(
      `ALTER TABLE membership_plans MODIFY COLUMN duration_unit ${UNIT_ENUM} NULL`
    );
  }

  columns = await columnMap();
  if (!columns.has("billing_interval_value")) {
    console.log("Adding billing_interval_value...");
    await db.query(
      `ALTER TABLE membership_plans
       ADD COLUMN billing_interval_value SMALLINT UNSIGNED NULL
       AFTER duration_value`
    );
  }

  columns = await columnMap();
  if (!columns.has("billing_interval_unit")) {
    console.log("Adding billing_interval_unit...");
    await db.query(
      `ALTER TABLE membership_plans
       ADD COLUMN billing_interval_unit ${UNIT_ENUM} NULL
       AFTER duration_unit`
    );
  }

  if (!(await hasCheckConstraint("chk_membership_plans_validity_config"))) {
    console.log("Adding validity configuration check constraint...");
    await db.query(
      `ALTER TABLE membership_plans
       ADD CONSTRAINT chk_membership_plans_validity_config
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
       )`
    );
  }

  const [invalidRows] = await db.query(
    `SELECT id, plan_code, validity_type,
            duration_value, duration_unit,
            billing_interval_value, billing_interval_unit
     FROM membership_plans
     WHERE NOT (
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
     )`
  );

  if (invalidRows.length > 0) {
    console.table(invalidRows);
    throw new Error("Verification failed: one or more membership plans have invalid validity settings.");
  }

  const [plans] = await db.query(
    `SELECT id, plan_code, name, validity_type,
            duration_value, duration_unit,
            billing_interval_value, billing_interval_unit, status
     FROM membership_plans
     ORDER BY id`
  );

  console.log("\n===== ONGOING MEMBERSHIP MIGRATION SUCCESSFUL =====");
  console.table(plans);
  console.log(
    JSON.stringify(
      {
        success: true,
        existingPlansPreserved: existingPlans.length,
        verifiedPlans: plans.length,
        fixedPlans: plans.filter((plan) => plan.validity_type === "fixed").length,
        ongoingPlans: plans.filter((plan) => plan.validity_type === "ongoing").length,
        backup: backupPath,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error("ONGOING MEMBERSHIP MIGRATION FAILED:", error.code || "", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });