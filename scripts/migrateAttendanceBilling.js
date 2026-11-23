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

const ensureTable = async (tableName, createSql) => {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS table_count
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  if (Number(rows[0]?.table_count || 0) > 0) {
    console.log(`Table already exists: ${tableName}`);
    return;
  }
  await db.query(createSql);
  console.log(`Created table: ${tableName}`);
};

const ensurePermission = async (permissionKey, moduleName, description) => {
  const [rows] = await db.query(
    `SELECT id FROM permissions WHERE permission_key = ? LIMIT 1`,
    [permissionKey]
  );
  let permissionId;
  if (rows.length) {
    permissionId = Number(rows[0].id);
    await db.query(
      `UPDATE permissions
       SET module_name = ?, description = ?, permission_scope = 'gym',
           gym_admin_default = 1
       WHERE id = ?`,
      [moduleName, description, permissionId]
    );
  } else {
    const [insert] = await db.query(
      `INSERT INTO permissions
       (permission_key, module_name, description, permission_scope, gym_admin_default)
       VALUES (?, ?, ?, 'gym', 1)`,
      [permissionKey, moduleName, description]
    );
    permissionId = Number(insert.insertId);
  }

  // Add only missing assignments. This avoids relying on a particular
  // UNIQUE/PRIMARY KEY definition on role_permissions.
  await db.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT role.id, ?
     FROM roles role
     LEFT JOIN role_permissions existing
       ON existing.role_id = role.id
      AND existing.permission_id = ?
     WHERE role.name = 'Gym Admin'
       AND role.is_system_role = 1
       AND existing.role_id IS NULL`,
    [permissionId, permissionId]
  );
  console.log(`Ensured permission: ${permissionKey}`);
};

const run = async () => {
  try {
    const [databaseRows] = await db.query('SELECT DATABASE() AS database_name');
    const databaseName = databaseRows[0]?.database_name;
    if (!databaseName) {
      throw new Error('No active database is selected. Check DB_NAME in the API .env file.');
    }
    console.log(`\nAttendance billing migration target: ${databaseName}`);
    console.log('This migration adds billing columns, attendance tables and permissions.');

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
      throw new Error('Database confirmation did not match. No migration changes were applied.');
    }

    await ensureColumn(
      'membership_plans',
      'billing_mode',
      "VARCHAR(20) NOT NULL DEFAULT 'standard'",
      'validity_type'
    );
    await ensureColumn(
      'member_memberships',
      'billing_mode_snapshot',
      "VARCHAR(20) NOT NULL DEFAULT 'standard'",
      'validity_type_snapshot'
    );

    await ensureTable('member_attendance', `
      CREATE TABLE member_attendance (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id BIGINT UNSIGNED NOT NULL,
        member_id BIGINT UNSIGNED NOT NULL,
        membership_id BIGINT UNSIGNED NOT NULL,
        branch_id BIGINT UNSIGNED NOT NULL,
        attendance_date DATE NOT NULL,
        checked_in_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        invoice_id BIGINT UNSIGNED NULL,
        created_by_user_id BIGINT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_member_attendance_per_day
          (organization_id, member_id, attendance_date),
        KEY ix_member_attendance_branch_day
          (organization_id, branch_id, attendance_date, checked_in_at),
        KEY ix_member_attendance_membership_day
          (organization_id, membership_id, attendance_date),
        KEY ix_member_attendance_invoice
          (organization_id, invoice_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await ensureTable('member_membership_attendance_charges', `
      CREATE TABLE member_membership_attendance_charges (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id BIGINT UNSIGNED NOT NULL,
        membership_id BIGINT UNSIGNED NOT NULL,
        service_date DATE NOT NULL,
        attendance_id BIGINT UNSIGNED NOT NULL,
        invoice_id BIGINT UNSIGNED NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        currency_code CHAR(3) NOT NULL DEFAULT 'LKR',
        created_by_user_id BIGINT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_membership_daily_attendance_charge
          (organization_id, membership_id, service_date),
        UNIQUE KEY uq_attendance_charge_invoice
          (organization_id, invoice_id),
        KEY ix_attendance_charge_membership_date
          (organization_id, membership_id, service_date),
        KEY ix_attendance_charge_attendance
          (organization_id, attendance_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await ensurePermission(
      'attendance.view',
      'Attendance',
      'View attendance records for the active branch.'
    );
    await ensurePermission(
      'attendance.check_in',
      'Attendance',
      'Search daily-plan members and record attendance check-ins.'
    );

    console.log('Attendance billing migration completed successfully.');
  } catch (error) {
    console.error('Attendance billing migration failed:', error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
};

run();
