'use strict';

const crypto = require('node:crypto');
const db = require('../src/config/db');

const {
  syncAllGymAdminRolePermissions,
} = require('../src/services/gymAdminPermissionService');

// ======================================================
// 1. MEMBERS
// ======================================================

const CREATE_MEMBERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  member_code VARCHAR(30) DEFAULT NULL,

  nic_type ENUM('old', 'new') DEFAULT NULL,
  nic_ciphertext VARBINARY(255) DEFAULT NULL,
  nic_iv BINARY(12) DEFAULT NULL,
  nic_auth_tag BINARY(16) DEFAULT NULL,
  nic_lookup_hash BINARY(32) DEFAULT NULL,
  nic_last4 CHAR(4) DEFAULT NULL,

  full_name VARCHAR(150) NOT NULL,
  date_of_birth DATE DEFAULT NULL,
  date_of_birth_source ENUM('nic_decoded', 'manual') DEFAULT NULL,
  date_of_birth_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  gender ENUM('male', 'female', 'other', 'not_specified') DEFAULT NULL,

  phone_primary VARCHAR(30) DEFAULT NULL,
  phone_primary_normalized VARCHAR(20) DEFAULT NULL,
  phone_secondary VARCHAR(30) DEFAULT NULL,
  phone_secondary_normalized VARCHAR(20) DEFAULT NULL,
  email VARCHAR(150) DEFAULT NULL,
  address TEXT DEFAULT NULL,
  city VARCHAR(100) DEFAULT NULL,

  emergency_contact_name VARCHAR(150) DEFAULT NULL,
  emergency_contact_relationship VARCHAR(80) DEFAULT NULL,
  emergency_contact_phone VARCHAR(30) DEFAULT NULL,
  emergency_contact_phone_normalized VARCHAR(20) DEFAULT NULL,

  profile_photo_path VARCHAR(500) DEFAULT NULL,
  registration_branch_id BIGINT UNSIGNED NOT NULL,
  preferred_branch_id BIGINT UNSIGNED DEFAULT NULL,

  registration_source ENUM(
    'walk_in', 'referral', 'facebook', 'website', 'other'
  ) NOT NULL DEFAULT 'walk_in',

  referred_by VARCHAR(150) DEFAULT NULL,

  status ENUM('active', 'inactive', 'blocked')
    NOT NULL DEFAULT 'active',

  admission_fee_status ENUM(
    'not_charged', 'pending', 'paid', 'waived'
  ) NOT NULL DEFAULT 'not_charged',

  admission_fee_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  admission_fee_currency CHAR(3) NOT NULL DEFAULT 'LKR',
  admission_fee_recorded_at DATETIME DEFAULT NULL,

  created_by_user_id BIGINT UNSIGNED NOT NULL,
  updated_by_user_id BIGINT UNSIGNED DEFAULT NULL,

  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  UNIQUE KEY uq_members_org_code
    (organization_id, member_code),

  UNIQUE KEY uq_members_org_id
    (organization_id, id),

  UNIQUE KEY uq_members_org_nic_hash
    (organization_id, nic_lookup_hash),

  KEY idx_members_org_name
    (organization_id, full_name),

  KEY idx_members_org_phone_primary
    (organization_id, phone_primary_normalized),

  KEY idx_members_org_phone_secondary
    (organization_id, phone_secondary_normalized),

  KEY idx_members_org_nic_last4
    (organization_id, nic_last4),

  KEY idx_members_org_status_created
    (organization_id, status, created_at),

  CONSTRAINT fk_members_organization
    FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT,

  CONSTRAINT fk_members_registration_branch
    FOREIGN KEY (organization_id, registration_branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,

  CONSTRAINT fk_members_preferred_branch
    FOREIGN KEY (organization_id, preferred_branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,

  CONSTRAINT fk_members_created_by
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id) ON DELETE RESTRICT,

  CONSTRAINT fk_members_updated_by
    FOREIGN KEY (organization_id, updated_by_user_id)
    REFERENCES users (organization_id, id) ON DELETE RESTRICT,

  CONSTRAINT chk_members_admission_fee_amount
    CHECK (admission_fee_amount >= 0),

  CONSTRAINT chk_members_nic_encryption_fields
    CHECK (
      (
        nic_ciphertext IS NULL
        AND nic_iv IS NULL
        AND nic_auth_tag IS NULL
        AND nic_lookup_hash IS NULL
        AND nic_last4 IS NULL
      )
      OR
      (
        nic_ciphertext IS NOT NULL
        AND nic_iv IS NOT NULL
        AND nic_auth_tag IS NOT NULL
        AND nic_lookup_hash IS NOT NULL
        AND nic_last4 IS NOT NULL
      )
    )

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
`;

// ======================================================
// 2. MEMBER FITNESS PROGRESS
// ======================================================

const CREATE_MEMBER_FITNESS_PROGRESS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS member_fitness_progress (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,

  measurement_date DATE NOT NULL,

  height_cm DECIMAL(5,2) DEFAULT NULL,
  weight_kg DECIMAL(6,2) DEFAULT NULL,
  bmi DECIMAL(5,2) DEFAULT NULL,

  arms_cm DECIMAL(5,2) DEFAULT NULL,
  waist_cm DECIMAL(5,2) DEFAULT NULL,
  thigh_cm DECIMAL(5,2) DEFAULT NULL,
  chest_cm DECIMAL(5,2) DEFAULT NULL,
  hips_cm DECIMAL(5,2) DEFAULT NULL,
  calves_cm DECIMAL(5,2) DEFAULT NULL,

  notes TEXT DEFAULT NULL,

  created_by_user_id BIGINT UNSIGNED NOT NULL,
  updated_by_user_id BIGINT UNSIGNED DEFAULT NULL,

  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  UNIQUE KEY uq_member_fitness_org_id
    (organization_id, id),

  UNIQUE KEY uq_member_fitness_org_member_id
    (organization_id, member_id, id),

  KEY idx_member_fitness_org_member_date
    (organization_id, member_id, measurement_date, id),

  KEY idx_member_fitness_org_branch_date
    (organization_id, branch_id, measurement_date),

  CONSTRAINT fk_member_fitness_member
    FOREIGN KEY (organization_id, member_id)
    REFERENCES members (organization_id, id) ON DELETE RESTRICT,

  CONSTRAINT fk_member_fitness_branch
    FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,

  CONSTRAINT fk_member_fitness_created_by
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id) ON DELETE RESTRICT,

  CONSTRAINT fk_member_fitness_updated_by
    FOREIGN KEY (organization_id, updated_by_user_id)
    REFERENCES users (organization_id, id) ON DELETE RESTRICT,

  CONSTRAINT chk_member_fitness_height
    CHECK (height_cm IS NULL OR height_cm > 0),

  CONSTRAINT chk_member_fitness_weight
    CHECK (weight_kg IS NULL OR weight_kg > 0),

  CONSTRAINT chk_member_fitness_bmi
    CHECK (bmi IS NULL OR bmi > 0),

  CONSTRAINT chk_member_fitness_arms
    CHECK (arms_cm IS NULL OR arms_cm > 0),

  CONSTRAINT chk_member_fitness_waist
    CHECK (waist_cm IS NULL OR waist_cm > 0),

  CONSTRAINT chk_member_fitness_thigh
    CHECK (thigh_cm IS NULL OR thigh_cm > 0),

  CONSTRAINT chk_member_fitness_chest
    CHECK (chest_cm IS NULL OR chest_cm > 0),

  CONSTRAINT chk_member_fitness_hips
    CHECK (hips_cm IS NULL OR hips_cm > 0),

  CONSTRAINT chk_member_fitness_calves
    CHECK (calves_cm IS NULL OR calves_cm > 0)

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
`;

// ======================================================
// 3. MEMBER PROGRESS PHOTOS
// Exactly one front, side and back photo per record.
// ======================================================

const CREATE_MEMBER_PROGRESS_PHOTOS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS member_progress_photos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  progress_id BIGINT UNSIGNED NOT NULL,

  photo_type ENUM('front', 'side', 'back') NOT NULL,
  storage_path VARCHAR(500) NOT NULL,

  created_by_user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  UNIQUE KEY uq_member_progress_photo_type
    (organization_id, progress_id, photo_type),

  KEY idx_member_progress_photos_member
    (organization_id, member_id, progress_id),

  CONSTRAINT fk_member_progress_photo_member
    FOREIGN KEY (organization_id, member_id)
    REFERENCES members (organization_id, id) ON DELETE RESTRICT,

  CONSTRAINT fk_member_progress_photo_progress
    FOREIGN KEY (organization_id, member_id, progress_id)
    REFERENCES member_fitness_progress
      (organization_id, member_id, id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_member_progress_photo_created_by
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES users (organization_id, id) ON DELETE RESTRICT

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
`;

// ======================================================
// 4. DYNAMIC GYM PERMISSIONS
// ======================================================

const PERMISSIONS = [
  {
    key: 'members.view',
    description: 'View member records and profiles',
  },
  {
    key: 'members.create',
    description: 'Register new members',
  },
  {
    key: 'members.update',
    description: 'Update member profile information',
  },
  {
    key: 'members.deactivate',
    description: 'Deactivate or reactivate member records',
  },
  {
    key: 'member_fitness.view',
    description: 'View member fitness progress records',
  },
  {
    key: 'member_fitness.create',
    description: 'Create member fitness progress records',
  },
  {
    key: 'member_fitness.update',
    description: 'Update member fitness progress records',
  },
  {
    key: 'member_fitness.delete',
    description: 'Remove member fitness progress records',
  },
  {
    key: 'member_fitness.photos.view',
    description: 'View member fitness progress photos',
  },
  {
    key: 'member_fitness.photos.manage',
    description: 'Upload, replace or remove member fitness progress photos',
  },
];

// ======================================================
// 5. VERIFY TABLES
// ======================================================

async function verifyTables(connection) {
  const expectedTables = [
    'members',
    'member_fitness_progress',
    'member_progress_photos',
  ];

  const [rows] = await connection.query(
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (?, ?, ?)
     ORDER BY TABLE_NAME`,
    expectedTables
  );

  const found = new Set(rows.map((row) => row.TABLE_NAME));
  const missing = expectedTables.filter((name) => !found.has(name));

  if (missing.length > 0) {
    throw new Error(
      `Table verification failed. Missing: ${missing.join(', ')}`
    );
  }

  return expectedTables;
}

// ======================================================
// 6. MIGRATION
// ======================================================

async function main() {
  let connection;

  try {
    console.log('Creating members table...');
    await db.query(CREATE_MEMBERS_TABLE_SQL);

    console.log('Creating member fitness progress table...');
    await db.query(CREATE_MEMBER_FITNESS_PROGRESS_TABLE_SQL);

    console.log('Creating member progress photos table...');
    await db.query(CREATE_MEMBER_PROGRESS_PHOTOS_TABLE_SQL);

    // Backup existing permission catalogue and assignments.
    // This happens before Gym Admin permission synchronization.

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, '')
      .slice(0, 14);

    const suffix = `${timestamp}_${process.pid}_${crypto.randomBytes(2).toString('hex')}`;

    const permissionBackupTable =
      `permissions_backup_members_${suffix}`;

    const rolePermissionBackupTable =
      `role_permissions_backup_members_${suffix}`;

    await db.query(
      `CREATE TABLE \`${permissionBackupTable}\` LIKE permissions`
    );

    await db.query(
      `INSERT INTO \`${permissionBackupTable}\` SELECT * FROM permissions`
    );

    await db.query(
      `CREATE TABLE \`${rolePermissionBackupTable}\` LIKE role_permissions`
    );

    await db.query(
      `INSERT INTO \`${rolePermissionBackupTable}\` SELECT * FROM role_permissions`
    );

    console.log('Permission backups created:');
    console.log(permissionBackupTable);
    console.log(rolePermissionBackupTable);

    connection = await db.getConnection();
    await connection.beginTransaction();

    console.log('Registering Member permissions...');

    for (const permission of PERMISSIONS) {
      await connection.query(
        `INSERT INTO permissions
          (
            permission_key,
            module_name,
            permission_scope,
            description,
            gym_admin_default
          )
         VALUES (?, ?, 'gym', ?, 1)
         ON DUPLICATE KEY UPDATE
           module_name = VALUES(module_name),
           permission_scope = 'gym',
           description = VALUES(description),
           gym_admin_default = 1`,
        [
          permission.key,
          permission.key.startsWith('member_fitness.')
            ? 'Member Fitness'
            : 'Members',
          permission.description,
        ]
      );
    }

    console.log('Synchronizing Gym Admin permissions...');

    const syncResult =
      await syncAllGymAdminRolePermissions(connection);

    const permissionKeys = PERMISSIONS.map((item) => item.key);
    const placeholders = permissionKeys.map(() => '?').join(', ');

    const [permissionRows] = await connection.query(
      `SELECT
         id,
         permission_key,
         module_name,
         permission_scope,
         gym_admin_default
       FROM permissions
       WHERE permission_key IN (${placeholders})
       ORDER BY permission_key`,
      permissionKeys
    );

    const [roleRows] = await connection.query(
      `SELECT
         r.organization_id,
         r.id AS role_id,
         r.name AS role_name,
         COUNT(DISTINCT p.permission_key) AS member_permissions
       FROM roles r
       LEFT JOIN role_permissions rp
         ON rp.role_id = r.id
       LEFT JOIN permissions p
         ON p.id = rp.permission_id
        AND p.permission_key IN (${placeholders})
       WHERE r.name = 'Gym Admin'
         AND r.is_system_role = 1
       GROUP BY r.organization_id, r.id, r.name
       ORDER BY r.organization_id`,
      permissionKeys
    );

    if (permissionRows.length !== PERMISSIONS.length) {
      throw new Error(
        `Expected ${PERMISSIONS.length} permissions, found ${permissionRows.length}.`
      );
    }

    if (roleRows.length === 0) {
      throw new Error('No system Gym Admin roles found for permission verification.');
    }

    const rolesValid = roleRows.every(
      (role) => Number(role.member_permissions) === PERMISSIONS.length
    );

    if (!rolesValid) {
      throw new Error(
        'Some system Gym Admin roles are missing Member permissions.'
      );
    }

    const tables = await verifyTables(connection);

    await connection.commit();

    console.log('\n========== MEMBER MIGRATION RESULT ==========');

    console.log(
      JSON.stringify(
        {
          success: true,
          tablesCreatedOrVerified: tables,
          permissionsCreatedOrUpdated: permissionRows.length,
          gymAdminRolesVerified: roleRows.length,
          organizationsProcessed: syncResult.organizationsProcessed,
          customRolesModified: false,
          permissionBackups: [
            permissionBackupTable,
            rolePermissionBackupTable,
          ],
          memberSearchLimit: 5,
          nicStorage:
            'Encrypted ciphertext, IV, authentication tag and keyed lookup hash; no plaintext NIC column',
          admissionFee:
            'One-time member-level state; checkout backend must prevent duplicate admission charges',
          progressPhotos:
            'One front, one side and one back photo per progress record',
        },
        null,
        2
      )
    );

    console.table(permissionRows);
    console.table(roleRows);

    console.log('\nMEMBER MIGRATION SUCCESSFUL');
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError.message);
      }
    }

    console.error('\nMEMBER MIGRATION FAILED:');
    console.error(error.code || '', error.message);

    process.exitCode = 1;
  } finally {
    if (connection) {
      connection.release();
    }

    if (typeof db.end === 'function') {
      await db.end();
    }
  }
}

main();