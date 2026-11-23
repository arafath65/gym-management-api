'use strict';

require('dotenv').config();
const readline = require('node:readline/promises');
const db = require('../src/config/db');

const EXPECTED_DATABASE = 'gym_management_db';

const ensureTable = async () => {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS found
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'member_program_assignment_pauses'`
  );
  if (Number(rows[0]?.found || 0) > 0) {
    console.log('Pause history table already exists: member_program_assignment_pauses');
    return;
  }

  await db.query(`
    CREATE TABLE member_program_assignment_pauses (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      organization_id BIGINT UNSIGNED NOT NULL,
      assignment_id BIGINT UNSIGNED NOT NULL,
      paused_on DATE NOT NULL,
      paused_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      pause_reason VARCHAR(500) NULL,
      paused_by_user_id BIGINT UNSIGNED NOT NULL,
      resumed_on DATE NULL,
      resumed_at DATETIME NULL,
      resumed_by_user_id BIGINT UNSIGNED NULL,
      closed_on DATE NULL,
      closed_at DATETIME NULL,
      closed_by_user_id BIGINT UNSIGNED NULL,
      frozen_days INT UNSIGNED NULL,
      extension_decision ENUM(
        'extended',
        'not_extended',
        'completed_while_paused',
        'cancelled_while_paused'
      ) NULL,
      original_expected_end_date DATE NOT NULL,
      proposed_expected_end_date DATE NULL,
      final_expected_end_date DATE NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_mpap_org_id (organization_id, id),
      KEY ix_mpap_assignment_history (organization_id, assignment_id, id),
      KEY ix_mpap_assignment_open (organization_id, assignment_id, resumed_at, closed_at),
      CONSTRAINT fk_mpap_assignment
        FOREIGN KEY (organization_id, assignment_id)
        REFERENCES member_program_assignments (organization_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_mpap_paused_by
        FOREIGN KEY (organization_id, paused_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_mpap_resumed_by
        FOREIGN KEY (organization_id, resumed_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_mpap_closed_by
        FOREIGN KEY (organization_id, closed_by_user_id)
        REFERENCES users (organization_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('Created table: member_program_assignment_pauses');
};

const ensurePermission = async (permissionKey, description) => {
  const moduleName = 'Member Programs';
  const [existing] = await db.query(
    `SELECT id FROM permissions WHERE permission_key = ? LIMIT 1`,
    [permissionKey]
  );
  let permissionId;
  if (existing.length) {
    permissionId = Number(existing[0].id);
    await db.query(
      `UPDATE permissions
       SET module_name = ?, description = ?, permission_scope = 'gym', gym_admin_default = 1
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

  await db.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, ?
     FROM roles r
     LEFT JOIN role_permissions existing
       ON existing.role_id = r.id AND existing.permission_id = ?
     WHERE r.name = 'Gym Admin'
       AND r.is_system_role = 1
       AND existing.role_id IS NULL`,
    [permissionId, permissionId]
  );
  console.log(`Ensured permission: ${permissionKey}`);
};

const run = async () => {
  try {
    const [databaseRows] = await db.query('SELECT DATABASE() AS database_name');
    const databaseName = databaseRows[0]?.database_name;
    console.log(`\nProgram pause/resume migration target: ${databaseName || '(none)'}`);
    console.log('This creates the program pause history table and granular program lifecycle permissions.');
    console.log('Existing member program assignments and their expected end dates are not modified.');
    if (databaseName !== EXPECTED_DATABASE) {
      throw new Error(`Expected ${EXPECTED_DATABASE}, connected to ${databaseName || '(none)'}.`);
    }

    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    let confirmation;
    try {
      confirmation = await prompt.question(`Type the exact database name (${EXPECTED_DATABASE}) to continue: `);
    } finally {
      prompt.close();
    }
    if (confirmation.trim() !== EXPECTED_DATABASE) {
      throw new Error('Database confirmation did not match. Migration cancelled.');
    }

    const [tableRows] = await db.query(
      `SELECT COUNT(*) AS found
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'member_program_assignments'`
    );
    if (!Number(tableRows[0]?.found || 0)) {
      throw new Error('Required table member_program_assignments does not exist.');
    }

    await ensureTable();

    const permissions = [
      ['member_programs.pause', 'Pause an active member fitness program.'],
      ['member_programs.resume', 'Resume a paused member fitness program without extending its end date.'],
      ['member_programs.pause_extension.approve', 'Approve extending a program end date by its paused calendar days when resuming.'],
      ['member_programs.complete', 'Mark a member fitness program as completed.'],
      ['member_programs.cancel', 'Cancel a member fitness program.'],
      ['member_programs.pause_history.view', 'View pause and resume history for member fitness programs.'],
    ];
    for (const [key, description] of permissions) {
      await ensurePermission(key, description);
    }

    console.log('Program pause/resume migration completed successfully.');
  } catch (error) {
    console.error('Program pause/resume migration failed:', error.message || error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
};

run();
