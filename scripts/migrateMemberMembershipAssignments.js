'use strict';

const db = require('../src/config/db');

const requiredColumns = {
  organizations: ['id'],
  branches: ['id', 'organization_id'],
  users: ['id', 'organization_id'],
  members: [
    'id', 'organization_id', 'member_code',
    'full_name', 'status', 'registration_branch_id'
  ],
  membership_plans: [
    'id', 'organization_id', 'plan_code', 'name',
    'package_type', 'validity_type', 'duration_value',
    'duration_unit', 'billing_interval_value',
    'billing_interval_unit', 'price', 'currency_code',
    'included_members', 'paying_members', 'status'
  ],
};

async function verifyExistingSchema(connection) {
  for (const [table, required] of Object.entries(requiredColumns)) {
    const [rows] = await connection.query(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?`,
      [table]
    );

    const existing = new Set(rows.map(row => row.COLUMN_NAME));
    const missing = required.filter(column => !existing.has(column));

    if (missing.length) {
      throw new Error(
        `Existing table ${table} is missing columns: ${missing.join(', ')}`
      );
    }
  }

  console.log('Existing membership and organization schema verified.');
}

async function migrate() {
  let connection;

  try {
    connection = await db.getConnection();
    await verifyExistingSchema(connection);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS member_memberships (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id BIGINT UNSIGNED NOT NULL,
        membership_plan_id BIGINT UNSIGNED NOT NULL,
        branch_id BIGINT UNSIGNED NOT NULL,
        primary_member_id BIGINT UNSIGNED NOT NULL,

        renewed_from_membership_id BIGINT UNSIGNED NULL,

        plan_code_snapshot VARCHAR(30) NOT NULL,
        plan_name_snapshot VARCHAR(150) NOT NULL,
        package_type_snapshot ENUM('individual','couple') NOT NULL,
        validity_type_snapshot ENUM('fixed','ongoing') NOT NULL,

        duration_value_snapshot SMALLINT UNSIGNED NULL,
        duration_unit_snapshot ENUM('day','week','month','year') NULL,

        billing_interval_value_snapshot SMALLINT UNSIGNED NULL,
        billing_interval_unit_snapshot ENUM('day','week','month','year') NULL,

        price_snapshot DECIMAL(12,2) NOT NULL,
        currency_code_snapshot CHAR(3) NOT NULL,

        included_members_snapshot TINYINT UNSIGNED NOT NULL,
        paying_members_snapshot TINYINT UNSIGNED NOT NULL,

        start_date DATE NOT NULL,
        end_date DATE NULL,
        next_billing_date DATE NULL,

        status ENUM('active','expired','cancelled')
          NOT NULL DEFAULT 'active',

        cancelled_on DATE NULL,
        cancellation_reason VARCHAR(500) NULL,
        notes VARCHAR(1000) NULL,

        created_by_user_id BIGINT UNSIGNED NOT NULL,
        updated_by_user_id BIGINT UNSIGNED NOT NULL,

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),

        UNIQUE KEY uq_member_memberships_org_id
          (organization_id, id),

        KEY idx_member_memberships_member_status
          (organization_id, primary_member_id, status, start_date),

        KEY idx_member_memberships_branch_date
          (organization_id, branch_id, start_date),

        KEY idx_member_memberships_plan
          (organization_id, membership_plan_id),

        KEY idx_member_memberships_renewal
          (organization_id, renewed_from_membership_id),

        CONSTRAINT fk_member_memberships_org
          FOREIGN KEY (organization_id)
          REFERENCES organizations (id),

        CONSTRAINT fk_member_memberships_plan
          FOREIGN KEY (organization_id, membership_plan_id)
          REFERENCES membership_plans (organization_id, id),

        CONSTRAINT fk_member_memberships_branch
          FOREIGN KEY (organization_id, branch_id)
          REFERENCES branches (organization_id, id),

        CONSTRAINT fk_member_memberships_primary_member
          FOREIGN KEY (organization_id, primary_member_id)
          REFERENCES members (organization_id, id),

        CONSTRAINT fk_member_memberships_created_by
          FOREIGN KEY (organization_id, created_by_user_id)
          REFERENCES users (organization_id, id),

        CONSTRAINT fk_member_memberships_updated_by
          FOREIGN KEY (organization_id, updated_by_user_id)
          REFERENCES users (organization_id, id),

        CONSTRAINT fk_member_memberships_renewal
          FOREIGN KEY (organization_id, renewed_from_membership_id)
          REFERENCES member_memberships (organization_id, id),

        CONSTRAINT chk_member_memberships_price
          CHECK (price_snapshot >= 0),

        CONSTRAINT chk_member_memberships_members
          CHECK (
            (package_type_snapshot = 'individual'
              AND included_members_snapshot = 1
              AND paying_members_snapshot = 1)
            OR
            (package_type_snapshot = 'couple'
              AND included_members_snapshot = 2
              AND paying_members_snapshot = 1)
          ),

        CONSTRAINT chk_member_memberships_validity
          CHECK (
            (
              validity_type_snapshot = 'fixed'
              AND duration_value_snapshot > 0
              AND duration_unit_snapshot IS NOT NULL
              AND end_date IS NOT NULL
              AND billing_interval_value_snapshot IS NULL
              AND billing_interval_unit_snapshot IS NULL
              AND next_billing_date IS NULL
            )
            OR
            (
              validity_type_snapshot = 'ongoing'
              AND billing_interval_value_snapshot > 0
              AND billing_interval_unit_snapshot IS NOT NULL
              AND end_date IS NULL
              AND duration_value_snapshot IS NULL
              AND duration_unit_snapshot IS NULL
              AND next_billing_date IS NOT NULL
            )
          ),

        CONSTRAINT chk_member_memberships_cancelled
          CHECK (
            (status = 'cancelled' AND cancelled_on IS NOT NULL)
            OR
            (status <> 'cancelled' AND cancelled_on IS NULL)
          )

      ) ENGINE=InnoDB
        DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_unicode_ci
    `);

    console.log('member_memberships table created or already exists.');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS member_membership_members (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id BIGINT UNSIGNED NOT NULL,
        membership_id BIGINT UNSIGNED NOT NULL,
        member_id BIGINT UNSIGNED NOT NULL,

        member_role ENUM('primary','included')
          NOT NULL DEFAULT 'primary',

        status ENUM('active','ended')
          NOT NULL DEFAULT 'active',

        joined_on DATE NOT NULL,
        ended_on DATE NULL,

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),

        UNIQUE KEY uq_member_membership_members_org_id
          (organization_id, id),

        UNIQUE KEY uq_member_membership_members_member
          (organization_id, membership_id, member_id),

        KEY idx_member_membership_members_member
          (organization_id, member_id, status),

        KEY idx_member_membership_members_membership
          (organization_id, membership_id, status),

        CONSTRAINT fk_mmm_org
          FOREIGN KEY (organization_id)
          REFERENCES organizations (id),

        CONSTRAINT fk_mmm_membership
          FOREIGN KEY (organization_id, membership_id)
          REFERENCES member_memberships (organization_id, id),

        CONSTRAINT fk_mmm_member
          FOREIGN KEY (organization_id, member_id)
          REFERENCES members (organization_id, id),

        CONSTRAINT chk_mmm_dates
          CHECK (
            (status = 'active' AND ended_on IS NULL)
            OR
            (status = 'ended' AND ended_on IS NOT NULL)
          )

      ) ENGINE=InnoDB
        DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_unicode_ci
    `);

    console.log('member_membership_members table created or already exists.');

    const required = {
      member_memberships: [
        'organization_id', 'membership_plan_id', 'branch_id',
        'primary_member_id', 'plan_code_snapshot',
        'plan_name_snapshot', 'package_type_snapshot',
        'validity_type_snapshot', 'start_date', 'end_date',
        'next_billing_date', 'status', 'created_by_user_id'
      ],
      member_membership_members: [
        'organization_id', 'membership_id', 'member_id',
        'member_role', 'status', 'joined_on', 'ended_on'
      ]
    };

    for (const [table, columns] of Object.entries(required)) {
      const [rows] = await connection.query(
        `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?`,
        [table]
      );

      const existing = new Set(rows.map(row => row.COLUMN_NAME));
      const missing = columns.filter(column => !existing.has(column));

      if (missing.length) {
        throw new Error(
          `${table} verification failed. Missing: ${missing.join(', ')}`
        );
      }
    }

    console.log('\n===== MEMBER MEMBERSHIP MIGRATION SUCCESSFUL =====');
    console.log('Verified table: member_memberships');
    console.log('Verified table: member_membership_members');
    console.log('Organization-scoped foreign keys and checks are installed.');
    console.log('Assignment history is preserved.');
  } catch (error) {
    console.error('\nMEMBERSHIP MIGRATION FAILED');
    console.error(error.code || error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();

    if (typeof db.end === 'function') {
      await db.end();
    }
  }
}

migrate();
