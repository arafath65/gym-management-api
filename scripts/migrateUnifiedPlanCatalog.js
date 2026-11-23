'use strict';

const readline = require('readline');
const db = require('../src/config/db');

const EXPECTED_DATABASE = 'gym_management_db';

const hasColumn = async (connection, tableName, columnName) => {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.total || 0) > 0;
};

const hasIndex = async (connection, tableName, indexName) => {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?`,
    [tableName, indexName]
  );
  return Number(rows[0]?.total || 0) > 0;
};

const hasConstraint = async (connection, tableName, constraintName) => {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS total
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?`,
    [tableName, constraintName]
  );
  return Number(rows[0]?.total || 0) > 0;
};

const ensureColumn = async (connection, columnName, ddl) => {
  if (await hasColumn(connection, 'membership_plans', columnName)) {
    console.log(`Column already exists: membership_plans.${columnName}`);
    return;
  }
  await connection.query(ddl);
  console.log(`Added column: membership_plans.${columnName}`);
};

const run = async () => {
  let connection;
  try {
    connection = await db.getConnection();
    const [databaseRows] = await connection.query('SELECT DATABASE() AS database_name');
    const databaseName = databaseRows[0]?.database_name;

    console.log(`Unified plan catalog migration target: ${databaseName || '(no database selected)'}`);
    console.log('This migration adds catalog metadata and copies existing fitness programs into membership_plans.');
    console.log('The fitness_programs table and member_program_assignments history are retained.');

    if (databaseName !== EXPECTED_DATABASE) {
      throw new Error(
        `Expected database ${EXPECTED_DATABASE}, but the API is connected to ${databaseName || '(none)'}.`
      );
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(`Type the exact database name (${EXPECTED_DATABASE}) to continue: `, resolve);
    });
    rl.close();

    if (String(answer).trim() !== EXPECTED_DATABASE) {
      throw new Error('Database confirmation did not match. Migration cancelled.');
    }

    const [programTableRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'fitness_programs'`
    );
    if (Number(programTableRows[0]?.total || 0) !== 1) {
      throw new Error('fitness_programs table was not found. No catalog migration was performed.');
    }

    await ensureColumn(
      connection,
      'plan_category',
      `ALTER TABLE membership_plans
       ADD COLUMN plan_category ENUM('membership','program') NOT NULL DEFAULT 'membership'
       AFTER plan_code`
    );
    await ensureColumn(
      connection,
      'program_category',
      `ALTER TABLE membership_plans
       ADD COLUMN program_category VARCHAR(80) NULL
       AFTER plan_category`
    );
    await ensureColumn(
      connection,
      'instructions',
      `ALTER TABLE membership_plans
       ADD COLUMN instructions TEXT NULL
       AFTER program_category`
    );
    await ensureColumn(
      connection,
      'legacy_program_id',
      `ALTER TABLE membership_plans
       ADD COLUMN legacy_program_id BIGINT UNSIGNED NULL
       AFTER instructions`
    );
    await ensureColumn(
      connection,
      'price_configured',
      `ALTER TABLE membership_plans
       ADD COLUMN price_configured TINYINT(1) NOT NULL DEFAULT 1
       AFTER legacy_program_id`
    );

    // Detect code collisions before copying; never overwrite an existing catalog row.
    const [collisions] = await connection.query(
      `SELECT fp.id, fp.program_code, fp.name
       FROM fitness_programs fp
       INNER JOIN membership_plans mp
         ON mp.organization_id = fp.organization_id
        AND mp.plan_code = fp.program_code
       WHERE mp.legacy_program_id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM membership_plans mapped
           WHERE mapped.organization_id = fp.organization_id
             AND mapped.legacy_program_id = fp.id
         )
       LIMIT 20`
    );
    if (collisions.length) {
      const list = collisions.map((row) => `${row.program_code} (${row.name})`).join(', ');
      throw new Error(`Program-code collision in membership_plans: ${list}. Resolve these codes before retrying.`);
    }

    const [insertResult] = await connection.query(
      `INSERT INTO membership_plans
        (
          organization_id,
          plan_code,
          plan_category,
          program_category,
          instructions,
          legacy_program_id,
          price_configured,
          name,
          description,
          package_type,
          tier,
          validity_type,
          billing_mode,
          duration_value,
          duration_unit,
          billing_interval_value,
          billing_interval_unit,
          price,
          currency_code,
          included_members,
          paying_members,
          status,
          created_by_user_id,
          updated_by_user_id
        )
       SELECT
          fp.organization_id,
          fp.program_code,
          'program',
          fp.category,
          fp.instructions,
          fp.id,
          0,
          fp.name,
          fp.description,
          'individual',
          NULL,
          'fixed',
          'standard',
          fp.duration_value,
          fp.duration_unit,
          NULL,
          NULL,
          0.00,
          'LKR',
          1,
          1,
          fp.status,
          fp.created_by_user_id,
          fp.updated_by_user_id
       FROM fitness_programs fp
       WHERE NOT EXISTS (
         SELECT 1
         FROM membership_plans existing
         WHERE existing.organization_id = fp.organization_id
           AND existing.legacy_program_id = fp.id
       )`
    );

    console.log(`Migrated existing programs into unified catalog: ${insertResult.affectedRows}`);

    if (!(await hasIndex(connection, 'membership_plans', 'uq_membership_plans_org_legacy_program'))) {
      await connection.query(
        `ALTER TABLE membership_plans
         ADD UNIQUE KEY uq_membership_plans_org_legacy_program (organization_id, legacy_program_id)`
      );
      console.log('Created unique mapping index: membership_plans(organization_id, legacy_program_id)');
    }

    if (!(await hasConstraint(connection, 'membership_plans', 'fk_membership_plans_legacy_program'))) {
      await connection.query(
        `ALTER TABLE membership_plans
         ADD CONSTRAINT fk_membership_plans_legacy_program
         FOREIGN KEY (organization_id, legacy_program_id)
         REFERENCES fitness_programs (organization_id, id)
         ON DELETE RESTRICT`
      );
      console.log('Created legacy program compatibility foreign key.');
    }

    const [orgRows] = await connection.query(
      `SELECT organization_id,
              SUM(plan_category = 'membership') AS membership_count,
              SUM(plan_category = 'program') AS program_count,
              SUM(plan_category = 'program' AND price_configured = 0) AS programs_without_price
       FROM membership_plans
       GROUP BY organization_id
       ORDER BY organization_id`
    );

    console.log('Unified catalog counts by organization:');
    for (const row of orgRows) {
      console.log(
        `  Org ${row.organization_id}: memberships=${row.membership_count}, programs=${row.program_count}, programs without configured price=${row.programs_without_price}`
      );
    }
    console.log('Migration completed successfully.');
    console.log('Legacy fitness_programs and member_program_assignments were retained unchanged.');
  } catch (error) {
    console.error('Unified plan catalog migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await db.end();
  }
};

run();
