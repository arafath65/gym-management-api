const db = require("../src/config/db");

const backupTable = process.argv[2] || "";

if (!/^users_username_backup_\d{8}_\d{6}$/.test(backupTable)) {
  throw new Error("A valid verified users backup table name is required.");
}

async function getColumnMap() {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
            CHARACTER_SET_NAME, COLLATION_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'`
  );

  return new Map(rows.map((row) => [row.COLUMN_NAME, row]));
}

async function getIndexColumns(indexName) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND INDEX_NAME = ?
     ORDER BY SEQ_IN_INDEX`,
    [indexName]
  );

  return rows;
}

async function verifyBackup() {
  const [tables] = await db.query(
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [backupTable]
  );

  if (tables.length !== 1) {
    throw new Error(`Required backup table not found: ${backupTable}`);
  }

  const [liveRows] = await db.query(
    "SELECT COUNT(*) AS total FROM users"
  );

  const [backupRows] = await db.query(
    `SELECT COUNT(*) AS total FROM \`${backupTable}\``
  );

  const liveCount = Number(liveRows[0].total);
  const backupCount = Number(backupRows[0].total);

  console.log({
    backupTable,
    liveUsers: liveCount,
    backupUsers: backupCount,
  });

  if (liveCount !== backupCount) {
    throw new Error(
      "Live users count differs from backup. Migration stopped."
    );
  }
}

async function runMigration() {
  const [databaseRows] = await db.query(
    "SELECT DATABASE() AS database_name, VERSION() AS mysql_version"
  );

  console.log("Database:", databaseRows[0]);

  await verifyBackup();

  let columns = await getColumnMap();

  const emailColumn = columns.get("email");

  if (!emailColumn || emailColumn.COLUMN_TYPE !== "varchar(150)") {
    throw new Error("Unexpected users.email schema. Migration stopped.");
  }

  const usernameColumn = columns.get("username");

  if (
    usernameColumn &&
    (
      usernameColumn.COLUMN_TYPE !== "varchar(50)" ||
      usernameColumn.IS_NULLABLE !== "YES" ||
      usernameColumn.CHARACTER_SET_NAME !== "utf8mb4" ||
      usernameColumn.COLLATION_NAME !== "utf8mb4_unicode_ci"
    )
  ) {
    throw new Error("Existing users.username schema is unexpected.");
  }

  if (!usernameColumn) {
    console.log("Adding nullable username column...");

    await db.query(
      `ALTER TABLE users
       ADD COLUMN username VARCHAR(50)
         CHARACTER SET utf8mb4
         COLLATE utf8mb4_unicode_ci
         NULL
       AFTER full_name`
    );
  }

  columns = await getColumnMap();

  if (columns.get("email").IS_NULLABLE !== "YES") {
    console.log("Making users.email optional...");

    await db.query(
      `ALTER TABLE users
       MODIFY COLUMN email VARCHAR(150)
         CHARACTER SET utf8mb4
         COLLATE utf8mb4_unicode_ci
         NULL`
    );
  }

  const usernameIndexes = await getIndexColumns("uq_user_username");

  if (usernameIndexes.length === 0) {
    const [duplicates] = await db.query(
      `SELECT LOWER(username) AS normalized_username,
              COUNT(*) AS total
       FROM users
       WHERE username IS NOT NULL
       GROUP BY LOWER(username)
       HAVING COUNT(*) > 1
       LIMIT 1`
    );

    if (duplicates.length > 0) {
      throw new Error("Duplicate usernames exist. Unique index not created.");
    }

    console.log("Creating organization-scoped username unique index...");

    await db.query(
      `ALTER TABLE users
       ADD UNIQUE KEY uq_user_username (organization_id, username)`
    );
  } else {
    const correctIndex =
      usernameIndexes.length === 2 &&
      usernameIndexes[0].COLUMN_NAME === "organization_id" &&
      usernameIndexes[1].COLUMN_NAME === "username" &&
      Number(usernameIndexes[0].NON_UNIQUE) === 0 &&
      Number(usernameIndexes[1].NON_UNIQUE) === 0;

    if (!correctIndex) {
      throw new Error("Existing uq_user_username index has an unexpected definition.");
    }
  }

  columns = await getColumnMap();

  const finalUsername = columns.get("username");
  const finalEmail = columns.get("email");
  const finalIndex = await getIndexColumns("uq_user_username");

  if (
    !finalUsername ||
    finalUsername.COLUMN_TYPE !== "varchar(50)" ||
    finalUsername.IS_NULLABLE !== "YES" ||
    finalEmail.IS_NULLABLE !== "YES" ||
    finalIndex.length !== 2
  ) {
    throw new Error("Final schema verification failed.");
  }

  console.log("USERNAME MIGRATION VERIFIED");
  console.log({
    username: finalUsername,
    email: finalEmail,
    usernameUniqueIndex: finalIndex,
    backupTable,
  });
}

runMigration()
  .catch((error) => {
    console.error("USERNAME MIGRATION FAILED:", error.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
