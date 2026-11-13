const db = require("../src/config/db");

async function main() {
  const [tableRows] = await db.query(
    `SELECT COUNT(*) AS table_count
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'membership_plans'`
  );

  if (Number(tableRows[0].table_count) !== 1) {
    throw new Error("membership_plans table does not exist.");
  }

  const [columnRows] = await db.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'membership_plans'
       AND COLUMN_NAME = 'benefits'`
  );

  if (columnRows.length === 0) {
    console.log("Benefits column is already absent.");
  } else {
    const [countRows] = await db.query(
      "SELECT COUNT(*) AS total FROM membership_plans"
    );

    const total = Number(countRows[0].total);

    if (total > 0) {
      throw new Error(
        `Found ${total} membership plans. Stopping to protect existing data.`
      );
    }

    await db.query(
      "ALTER TABLE membership_plans DROP COLUMN benefits"
    );

    console.log("Benefits column removed successfully.");
  }

  const [columns] = await db.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'membership_plans'
     ORDER BY ORDINAL_POSITION`
  );

  console.log("\n===== VERIFIED MEMBERSHIP PLAN COLUMNS =====");
  console.table(columns);

  const [remaining] = await db.query(
    `SELECT COUNT(*) AS benefits_column_count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'membership_plans'
       AND COLUMN_NAME = 'benefits'`
  );

  if (Number(remaining[0].benefits_column_count) !== 0) {
    throw new Error("Benefits column still exists.");
  }

  console.log("\nMembership Plans schema verification passed.");
}

main()
  .catch(error => {
    console.error("\nMIGRATION FAILED:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });