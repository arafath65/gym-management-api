'use strict';

const readline = require('readline');
const db = require('../src/config/db');

const EXPECTED_DATABASE = 'gym_management_db';

const countRows = async (connection, sql, params = []) => {
  const [rows] = await connection.query(sql, params);
  return Number(rows[0]?.total || 0);
};

const hasColumn = async (connection, columnName) => countRows(
  connection,
  `SELECT COUNT(*) AS total
   FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'member_program_assignments'
     AND COLUMN_NAME = ?`,
  [columnName]
) > 0;

const hasIndex = async (connection, indexName) => countRows(
  connection,
  `SELECT COUNT(*) AS total
   FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'member_program_assignments'
     AND INDEX_NAME = ?`,
  [indexName]
) > 0;

const hasConstraint = async (connection, constraintName) => countRows(
  connection,
  `SELECT COUNT(*) AS total
   FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'member_program_assignments'
     AND CONSTRAINT_NAME = ?`,
  [constraintName]
) > 0;

const run = async () => {
  let connection;
  try {
    connection = await db.getConnection();
    const [databaseRows] = await connection.query(
      'SELECT DATABASE() AS database_name'
    );
    const databaseName = databaseRows[0]?.database_name;

    console.log(`Member program catalog-reference migration target: ${databaseName || '(none)'}`);
    console.log('This adds membership_plan_id to member_program_assignments and backfills unified Program catalog references.');
    console.log('Legacy program_id, its foreign key, active-assignment uniqueness index and all assignment history remain intact.');

    if (databaseName !== EXPECTED_DATABASE) {
      throw new Error(`Expected ${EXPECTED_DATABASE}, connected to ${databaseName || '(none)'}.`);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(`Type the exact database name (${EXPECTED_DATABASE}) to continue: `, resolve);
    });
    rl.close();
    if (String(answer).trim() !== EXPECTED_DATABASE) {
      throw new Error('Database confirmation did not match. Migration cancelled.');
    }

    const requiredTables = ['member_program_assignments', 'membership_plans', 'fitness_programs'];
    for (const tableName of requiredTables) {
      const exists = await countRows(
        connection,
        `SELECT COUNT(*) AS total
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [tableName]
      );
      if (!exists) throw new Error(`Required table ${tableName} was not found.`);
    }

    if (!(await hasColumn(connection, 'membership_plan_id'))) {
      await connection.query(
        `ALTER TABLE member_program_assignments
         ADD COLUMN membership_plan_id BIGINT UNSIGNED NULL AFTER program_id`
      );
      console.log('Added column: member_program_assignments.membership_plan_id');
    } else {
      console.log('Column already exists: member_program_assignments.membership_plan_id');
    }

    const [backfill] = await connection.query(
      `UPDATE member_program_assignments mpa
       INNER JOIN membership_plans mp
         ON mp.organization_id = mpa.organization_id
        AND mp.legacy_program_id = mpa.program_id
        AND mp.plan_category = 'program'
       SET mpa.membership_plan_id = mp.id
       WHERE mpa.membership_plan_id IS NULL`
    );
    console.log(`Backfilled existing program assignments: ${backfill.affectedRows}`);

    if (!(await hasIndex(connection, 'idx_mpa_org_unified_plan_status'))) {
      await connection.query(
        `ALTER TABLE member_program_assignments
         ADD KEY idx_mpa_org_unified_plan_status
           (organization_id, membership_plan_id, status)`
      );
      console.log('Created index: idx_mpa_org_unified_plan_status');
    } else {
      console.log('Index already exists: idx_mpa_org_unified_plan_status');
    }

    if (!(await hasConstraint(connection, 'fk_mpa_membership_plan'))) {
      await connection.query(
        `ALTER TABLE member_program_assignments
         ADD CONSTRAINT fk_mpa_membership_plan
         FOREIGN KEY (organization_id, membership_plan_id)
         REFERENCES membership_plans (organization_id, id)
         ON DELETE RESTRICT`
      );
      console.log('Created foreign key: fk_mpa_membership_plan');
    } else {
      console.log('Foreign key already exists: fk_mpa_membership_plan');
    }

    const [counts] = await connection.query(
      `SELECT
         COUNT(*) AS total_assignments,
         SUM(membership_plan_id IS NOT NULL) AS linked_assignments,
         SUM(membership_plan_id IS NULL) AS legacy_only_assignments
       FROM member_program_assignments`
    );
    const row = counts[0] || {};
    console.log(`Assignment mapping: total=${row.total_assignments || 0}, linked=${row.linked_assignments || 0}, legacy-only=${row.legacy_only_assignments || 0}`);
    console.log('Migration completed. Existing program_id, legacy rows and assignment statuses were not changed.');
  } catch (error) {
    console.error('Member program catalog-reference migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await db.end();
  }
};

run();
