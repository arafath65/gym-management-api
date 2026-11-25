'use strict';

require('dotenv').config();
const db = require('../src/config/db');
const readline = require('node:readline/promises');

const ensureColumn = async (tableName, columnName, definition, afterColumn) => {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS column_count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );

  if (Number(rows[0]?.column_count || 0) > 0) {
    console.log(`Column already exists: ${tableName}.${columnName}`);
    return;
  }

  const after = afterColumn ? ` AFTER \`${afterColumn}\`` : '';
  await db.query(
    `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}${after}`
  );

  console.log(`Added column: ${tableName}.${columnName}`);
};

const ensureIndex = async (tableName, indexName, definition) => {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS index_count
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?`,
    [tableName, indexName]
  );

  if (Number(rows[0]?.index_count || 0) > 0) {
    console.log(`Index already exists: ${tableName}.${indexName}`);
    return;
  }

  await db.query(
    `ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` ${definition}`
  );

  console.log(`Added index: ${tableName}.${indexName}`);
};

const ensureMigrationStateTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS member_attendance_checkout_migration_state (
      id TINYINT UNSIGNED NOT NULL,
      cutover_at DATETIME NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

const run = async () => {
  try {
    const [databaseRows] = await db.query(
      'SELECT DATABASE() AS database_name'
    );

    const databaseName = databaseRows[0]?.database_name;

    if (!databaseName) {
      throw new Error(
        'No active database is selected. Check DB_NAME in the API .env file.'
      );
    }

    console.log(`\nAttendance checkout migration target: ${databaseName}`);

    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let confirmation;

    try {
      confirmation = await prompt.question(
        `Type the exact database name (${databaseName}) to continue: `
      );
    } finally {
      prompt.close();
    }

    if (confirmation.trim() !== databaseName) {
      throw new Error(
        'Database confirmation did not match. Migration cancelled.'
      );
    }

    await ensureColumn(
      'member_attendance',
      'checked_out_at',
      'DATETIME NULL',
      'checked_in_at'
    );

    await ensureColumn(
      'member_attendance',
      'checked_out_by_user_id',
      'BIGINT UNSIGNED NULL',
      'checked_out_at'
    );

    await ensureColumn(
      'member_attendance',
      'checked_out_branch_id',
      'BIGINT UNSIGNED NULL',
      'checked_out_by_user_id'
    );

    await ensureColumn(
      'member_attendance',
      'attendance_status',
      "ENUM('open', 'checked_out', 'missed_checkout', 'legacy_untracked') NOT NULL DEFAULT 'open'",
      'checked_out_branch_id'
    );

    await ensureIndex(
      'member_attendance',
      'ix_member_attendance_checkout_branch_day',
      '(organization_id, checked_out_branch_id, attendance_date, checked_out_at)'
    );

    await ensureMigrationStateTable();

    const [stateRows] = await db.query(
      `SELECT id
       FROM member_attendance_checkout_migration_state
       WHERE id = 1
       LIMIT 1`
    );

    if (!stateRows.length) {
      // Existing records predate checkout tracking.
      // Do not falsely label them as missed checkouts.
      await db.query(
        `UPDATE member_attendance
         SET attendance_status = 'legacy_untracked'
         WHERE attendance_status = 'open'
           AND checked_out_at IS NULL
           AND attendance_date < CURRENT_DATE()`
      );

      await db.query(
        `INSERT INTO member_attendance_checkout_migration_state
         (id, cutover_at)
         VALUES (1, CURRENT_TIMESTAMP)`
      );

      console.log(
        'Existing historical attendance records marked legacy_untracked.'
      );
    } else {
      console.log('Historical attendance cutover already completed.');
    }

    // Ensure rows with an actual checkout timestamp have the correct status.
    await db.query(
      `UPDATE member_attendance
       SET attendance_status = 'checked_out'
       WHERE checked_out_at IS NOT NULL
         AND attendance_status <> 'checked_out'`
    );

    const [statusRows] = await db.query(
      `SELECT attendance_status, COUNT(*) AS record_count
       FROM member_attendance
       GROUP BY attendance_status
       ORDER BY attendance_status`
    );

    console.log('\nAttendance status counts:');

    for (const row of statusRows) {
      console.log(`${row.attendance_status}: ${row.record_count}`);
    }

    console.log('\nAttendance checkout migration completed successfully.');
  } catch (error) {
    console.error('Attendance checkout migration failed:', error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
};

run();