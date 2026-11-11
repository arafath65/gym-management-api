const crypto = require("crypto");
const bcrypt = require("bcrypt");
const db = require("../config/db");

const {
  writePlatformAuditLog,
} = require("../services/platformAuditService");

const generateOrganizationCode = () => {
  const randomCode = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `GYM-${randomCode}`;
};

const validateExpiryDate = (value) => {
  if (typeof value !== "string") return false;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const isFutureExpiryDate = (value) => {
  const expiry = new Date(`${value}T23:59:59.999`);
  return expiry.getTime() > Date.now();
};

const getLatestLicense = async (connection, organizationId) => {
  const [licenses] = await connection.query(
    `SELECT
        id,
        organization_id,
        license_type,
        license_status,
        max_devices,
        starts_at,
        expires_at,
        notes,
        created_at
     FROM licenses
     WHERE organization_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [organizationId]
  );

  return licenses[0] || null;
};

const createOrganization = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const {
      name,
      slug,
      email,
      phone,
      address,
      licenseType = "trial",
      trialDays = 14,
      maxDevices = 2,
      expiresAt,
      adminName,
      adminUsername,
      adminPassword,
      notes,
    } = req.body || {};

    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof slug !== "string" ||
      !slug.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Organization name and slug are required",
      });
    }

    if (
      typeof adminName !== "string" ||
      !adminName.trim() ||
      adminName.trim().length > 150
    ) {
      return res.status(400).json({
        success: false,
        message: "Gym Admin name is required and must not exceed 150 characters",
      });
    }

    if (
      typeof adminUsername !== "string" ||
      !adminUsername.trim() ||
      adminUsername.trim().length > 150
    ) {
      return res.status(400).json({
        success: false,
        message: "Gym Admin username/email is required",
      });
    }

    const normalizedAdminUsername = adminUsername.trim().toLowerCase();

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedAdminUsername)) {
      return res.status(400).json({
        success: false,
        message: "Gym Admin username must be a valid email address",
      });
    }

    if (
      typeof adminPassword !== "string" ||
      adminPassword.length < 8 ||
      Buffer.byteLength(adminPassword, "utf8") > 72
    ) {
      return res.status(400).json({
        success: false,
        message: "Gym Admin password must be at least 8 characters and no more than 72 UTF-8 bytes",
      });
    }

    const normalizedAdminName = adminName.trim();
    const normalizedName = name.trim();
    const normalizedSlug = slug.trim().toLowerCase();

    if (!/^[a-z0-9-]+$/.test(normalizedSlug)) {
      return res.status(400).json({
        success: false,
        message: "Slug may contain lowercase letters, numbers and hyphens only",
      });
    }

    const allowedLicenseTypes = [
      "trial",
      "monthly",
      "yearly",
      "lifetime",
    ];

    if (!allowedLicenseTypes.includes(licenseType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid license type",
      });
    }

    const parsedMaxDevices = Number(maxDevices);

    if (
      !Number.isInteger(parsedMaxDevices) ||
      parsedMaxDevices < 1 ||
      parsedMaxDevices > 1000
    ) {
      return res.status(400).json({
        success: false,
        message: "Maximum devices must be between 1 and 1000",
      });
    }

    let durationDays = null;
    const expiryInput =
      expiresAt == null ? "" : String(expiresAt).trim();

    if (licenseType === "lifetime") {
      if (expiryInput) {
        return res.status(400).json({
          success: false,
          message: "Lifetime licenses cannot have an expiry date",
        });
      }
    } else if (expiryInput) {
      if (!validateExpiryDate(expiryInput)) {
        return res.status(400).json({
          success: false,
          message: "Invalid expiry date. Use YYYY-MM-DD",
        });
      }

      if (!isFutureExpiryDate(expiryInput)) {
        return res.status(400).json({
          success: false,
          message: "Expiry date must be in the future",
        });
      }
    } else if (licenseType === "trial") {
      durationDays = Number(trialDays);

      if (
        !Number.isInteger(durationDays) ||
        durationDays < 1 ||
        durationDays > 365
      ) {
        return res.status(400).json({
          success: false,
          message: "Trial duration must be between 1 and 365 days",
        });
      }
    } else {
      durationDays = licenseType === "monthly" ? 30 : 365;
    }

    const [existing] = await db.query(
      "SELECT id FROM organizations WHERE slug = ?",
      [normalizedSlug]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Organization slug already exists",
      });
    }

    const adminPasswordHash = await bcrypt.hash(adminPassword, 12);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const adminId = req.platformAdmin?.id;
    const organizationCode = generateOrganizationCode();

    const [organizationResult] = await connection.query(
      `INSERT INTO organizations
       (name, slug, organization_code, email, phone, address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        normalizedName,
        normalizedSlug,
        organizationCode,
        email?.trim() || null,
        phone?.trim() || null,
        address?.trim() || null,
      ]
    );

    const organizationId = organizationResult.insertId;

    let licenseResult;

    if (licenseType === "lifetime") {
      [licenseResult] = await connection.query(
        `INSERT INTO licenses
         (organization_id, license_type, license_status,
          max_devices, starts_at, expires_at,
          created_by_platform_admin_id, notes)
         VALUES (?, ?, 'active', ?, NOW(), NULL, ?, ?)`,
        [
          organizationId,
          licenseType,
          parsedMaxDevices,
          adminId,
          notes?.trim() || null,
        ]
      );
    } else if (expiryInput) {
      [licenseResult] = await connection.query(
        `INSERT INTO licenses
         (organization_id, license_type, license_status,
          max_devices, starts_at, expires_at,
          created_by_platform_admin_id, notes)
         VALUES (?, ?, 'active', ?, NOW(),
                 CONCAT(?, ' 23:59:59'), ?, ?)`,
        [
          organizationId,
          licenseType,
          parsedMaxDevices,
          expiryInput,
          adminId,
          notes?.trim() || null,
        ]
      );
    } else {
      [licenseResult] = await connection.query(
        `INSERT INTO licenses
         (organization_id, license_type, license_status,
          max_devices, starts_at, expires_at,
          created_by_platform_admin_id, notes)
         VALUES (?, ?, 'active', ?, NOW(),
                 DATE_ADD(NOW(), INTERVAL ? DAY), ?, ?)`,
        [
          organizationId,
          licenseType,
          parsedMaxDevices,
          durationDays,
          adminId,
          notes?.trim() || null,
        ]
      );
    }

    const [createdLicenses] = await connection.query(
      `SELECT id, license_type, license_status,
              max_devices, starts_at, expires_at, notes
       FROM licenses
       WHERE id = ?
       LIMIT 1`,
      [licenseResult.insertId]
    );

    const createdLicense = createdLicenses[0];
    // ------------------------------------------------
    // CREATE INITIAL GYM ADMIN USER
    // ------------------------------------------------
    const [gymAdminUserResult] = await connection.query(
      `INSERT INTO users
       (organization_id, full_name, email, phone, password_hash, status)
       VALUES (?, ?, ?, NULL, ?, 'active')`,
      [
        organizationId,
        normalizedAdminName,
        normalizedAdminUsername,
        adminPasswordHash,
      ]
    );

    const gymAdminUserId = gymAdminUserResult.insertId;

    // ------------------------------------------------
    // CREATE ORGANIZATION-SCOPED SYSTEM GYM ADMIN ROLE
    // ------------------------------------------------
    const [gymAdminRoleResult] = await connection.query(
      `INSERT INTO roles
       (organization_id, name, description, is_system_role)
       VALUES (?, 'Gym Admin', ?, 1)`,
      [
        organizationId,
        "Initial organization administrator with gym management permissions",
      ]
    );

    const gymAdminRoleId = gymAdminRoleResult.insertId;

    // These are tenant-level Gym Staff permissions only.
    // Platform organization and license administration permissions are excluded.
    // Branch deletion is excluded; branch deactivation is handled separately.
    const gymAdminPermissionKeys = [
      "branches.view",
      "branches.create",
      "branches.update",
      "users.view",
      "users.create",
      "users.update",
      "users.deactivate",
      "roles.view",
      "roles.create",
      "roles.update",
      "roles.assign",
      "audit_logs.view",
      "licenses.view",
    ];

    const permissionPlaceholders = gymAdminPermissionKeys
      .map(() => "?")
      .join(", ");

    const [gymAdminPermissions] = await connection.query(
      `SELECT id, permission_key
       FROM permissions
       WHERE permission_key IN (${permissionPlaceholders})`,
      gymAdminPermissionKeys
    );

    const permissionMap = new Map(
      gymAdminPermissions.map((permission) => [
        permission.permission_key,
        permission.id,
      ])
    );

    const missingPermissions = gymAdminPermissionKeys.filter(
      (permissionKey) => !permissionMap.has(permissionKey)
    );

    if (missingPermissions.length > 0) {
      throw new Error(
        `Missing Gym Admin permissions: ${missingPermissions.join(", ")}`
      );
    }

    for (const permissionKey of gymAdminPermissionKeys) {
      await connection.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES (?, ?)`,
        [gymAdminRoleId, permissionMap.get(permissionKey)]
      );
    }

    await connection.query(
      `INSERT INTO user_roles (organization_id, user_id, role_id)
       VALUES (?, ?, ?)`,
      [organizationId, gymAdminUserId, gymAdminRoleId]
    );

    await writePlatformAuditLog(connection, {
      platformAdminId: adminId,
      organizationId,
      action: "ORGANIZATION_CREATED",
      entityType: "organization",
      entityId: organizationId,
      description:
        `Created organization ${normalizedName} (${organizationCode})`,
      newValues: {
        organization: {
          id: organizationId,
          name: normalizedName,
          slug: normalizedSlug,
          organization_code: organizationCode,
          email: email?.trim() || null,
          phone: phone?.trim() || null,
          address: address?.trim() || null,
          status: "active",
        },
        license: createdLicense,
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });
    await writePlatformAuditLog(connection, {
      platformAdminId: adminId,
      organizationId,
      action: "GYM_ADMIN_CREATED",
      entityType: "user",
      entityId: gymAdminUserId,
      description: `Created initial Gym Admin account ${normalizedAdminUsername}`,
      newValues: {
        user_id: gymAdminUserId,
        full_name: normalizedAdminName,
        email: normalizedAdminUsername,
        role: "Gym Admin",
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    await writePlatformAuditLog(connection, {
      platformAdminId: adminId,
      organizationId,
      action: "GYM_ADMIN_ROLE_ASSIGNED",
      entityType: "role",
      entityId: gymAdminRoleId,
      description: `Assigned initial Gym Admin role to ${normalizedAdminUsername}`,
      newValues: {
        role_id: gymAdminRoleId,
        role_name: "Gym Admin",
        user_id: gymAdminUserId,
        permission_keys: gymAdminPermissionKeys,
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });
    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Organization, license and initial Gym Admin created successfully",
      organization: {
        id: organizationId,
        name: normalizedName,
        slug: normalizedSlug,
        organization_code: organizationCode,
        email: email?.trim() || null,
        phone: phone?.trim() || null,
        address: address?.trim() || null,
        status: "active",
      },
      license: createdLicense,
      gymAdmin: {
        id: gymAdminUserId,
        full_name: normalizedAdminName,
        email: normalizedAdminUsername,
        role: "Gym Admin",
        status: "active",
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    console.error("Create organization error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create organization, license and initial Gym Admin",
    });
  } finally {
    if (connection) connection.release();
  }
};

const getOrganizations = async (req, res) => {
  try {
    const [organizations] = await db.query(
      `SELECT
          o.id,
          o.name,
          o.slug,
          o.organization_code,
          o.email,
          o.phone,
          o.address,
          o.status,
          o.created_at,
          l.id AS license_id,
          l.license_type,
          l.license_status,
          l.max_devices,
          l.starts_at,
          l.expires_at,
          l.notes AS license_notes
       FROM organizations o
       LEFT JOIN licenses l
          ON l.id = (
            SELECT l2.id
            FROM licenses l2
            WHERE l2.organization_id = o.id
            ORDER BY l2.created_at DESC, l2.id DESC
            LIMIT 1
          )
       ORDER BY o.created_at DESC`
    );

    return res.json({
      success: true,
      organizations,
    });
  } catch (error) {
    console.error("Get organizations error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve organizations",
    });
  }
};

const updateOrganization = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(req.params.organizationId);
    const body = req.body || {};

    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID",
      });
    }

    const {
      name,
      slug,
      email,
      phone,
      address,
      licenseType,
      maxDevices,
      expiresAt,
      notes,
      trialDays = 14,
    } = body;

    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof slug !== "string" ||
      !slug.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Organization name and slug are required",
      });
    }

    const normalizedName = name.trim();
    const normalizedSlug = slug.trim().toLowerCase();

    if (!/^[a-z0-9-]+$/.test(normalizedSlug)) {
      return res.status(400).json({
        success: false,
        message: "Slug may contain lowercase letters, numbers and hyphens only",
      });
    }

    const gymOwnerFieldsProvided =
      Object.prototype.hasOwnProperty.call(body, "gymOwnerName") ||
      Object.prototype.hasOwnProperty.call(body, "gymOwnerUsername");
    const normalizedGymOwnerName =
      typeof body.gymOwnerName === "string" ? body.gymOwnerName.trim() : "";
    const normalizedGymOwnerUsername =
      typeof body.gymOwnerUsername === "string"
        ? body.gymOwnerUsername.trim().toLowerCase()
        : "";

    if (gymOwnerFieldsProvided) {
      if (
        !normalizedGymOwnerName ||
        normalizedGymOwnerName.length > 150 ||
        !normalizedGymOwnerUsername ||
        normalizedGymOwnerUsername.length > 150 ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedGymOwnerUsername)
      ) {
        return res.status(400).json({
          success: false,
          message: "Gym Owner name and a valid login email are required",
        });
      }
    }
    // License changes are optional. An organization can exist without a license.
    const licenseFieldsProvided = [
      "licenseType",
      "maxDevices",
      "expiresAt",
      "notes",
      "trialDays",
    ].some((field) => Object.prototype.hasOwnProperty.call(body, field));

    let parsedMaxDevices = null;
    let expiryInput = "";
    let durationDays = null;

    if (licenseFieldsProvided) {
      const allowedLicenseTypes = [
        "trial",
        "monthly",
        "yearly",
        "lifetime",
      ];

      if (!allowedLicenseTypes.includes(licenseType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid license type",
        });
      }

      parsedMaxDevices = Number(maxDevices);

      if (
        !Number.isInteger(parsedMaxDevices) ||
        parsedMaxDevices < 1 ||
        parsedMaxDevices > 1000
      ) {
        return res.status(400).json({
          success: false,
          message: "Maximum devices must be between 1 and 1000",
        });
      }

      expiryInput =
        expiresAt == null ? "" : String(expiresAt).trim();

      if (licenseType === "lifetime") {
        if (expiryInput) {
          return res.status(400).json({
            success: false,
            message: "Lifetime licenses cannot have an expiry date",
          });
        }
      } else if (expiryInput) {
        if (!validateExpiryDate(expiryInput)) {
          return res.status(400).json({
            success: false,
            message: "Invalid expiry date. Use YYYY-MM-DD",
          });
        }

        if (!isFutureExpiryDate(expiryInput)) {
          return res.status(400).json({
            success: false,
            message: "Expiry date must be in the future",
          });
        }
      } else if (licenseType === "trial") {
        durationDays = Number(trialDays);

        if (
          !Number.isInteger(durationDays) ||
          durationDays < 1 ||
          durationDays > 365
        ) {
          return res.status(400).json({
            success: false,
            message: "Trial duration must be between 1 and 365 days",
          });
        }
      } else {
        durationDays = licenseType === "monthly" ? 30 : 365;
      }
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [organizations] = await connection.query(
      `SELECT id, name, slug, email, phone, address, status,
              organization_code
       FROM organizations
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId]
    );

    if (organizations.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    const oldOrganization = organizations[0];

    const [duplicateSlugs] = await connection.query(
      `SELECT id
       FROM organizations
       WHERE slug = ? AND id <> ?
       LIMIT 1`,
      [normalizedSlug, organizationId]
    );

    if (duplicateSlugs.length > 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "Organization slug already exists",
      });
    }

    const oldLicense = await getLatestLicense(
      connection,
      organizationId
    );

    await connection.query(
      `UPDATE organizations
       SET name = ?, slug = ?, email = ?, phone = ?, address = ?
       WHERE id = ?`,
      [
        normalizedName,
        normalizedSlug,
        email?.trim() || null,
        phone?.trim() || null,
        address?.trim() || null,
        organizationId,
      ]
    );

    let updatedLicense = oldLicense;

    // Only modify or create a license when license fields were submitted.
    if (licenseFieldsProvided) {
      if (oldLicense) {
        if (licenseType === "lifetime") {
          await connection.query(
            `UPDATE licenses
             SET license_type = ?,
                 max_devices = ?,
                 expires_at = NULL,
                 notes = ?
             WHERE id = ?`,
            [
              licenseType,
              parsedMaxDevices,
              notes?.trim() || null,
              oldLicense.id,
            ]
          );
        } else if (expiryInput) {
          await connection.query(
            `UPDATE licenses
             SET license_type = ?,
                 max_devices = ?,
                 expires_at = CONCAT(?, ' 23:59:59'),
                 notes = ?
             WHERE id = ?`,
            [
              licenseType,
              parsedMaxDevices,
              expiryInput,
              notes?.trim() || null,
              oldLicense.id,
            ]
          );
        } else {
          await connection.query(
            `UPDATE licenses
             SET license_type = ?,
                 max_devices = ?,
                 expires_at = DATE_ADD(NOW(), INTERVAL ? DAY),
                 notes = ?
             WHERE id = ?`,
            [
              licenseType,
              parsedMaxDevices,
              durationDays,
              notes?.trim() || null,
              oldLicense.id,
            ]
          );
        }

        const [updatedLicenses] = await connection.query(
          `SELECT id, license_type, license_status,
                  max_devices, starts_at, expires_at, notes
           FROM licenses
           WHERE id = ?
           LIMIT 1`,
          [oldLicense.id]
        );

        updatedLicense = updatedLicenses[0] || null;
      } else {
        // No previous license: create one only because license fields
        // were explicitly submitted by the admin.
        let insertResult;

        if (licenseType === "lifetime") {
          [insertResult] = await connection.query(
            `INSERT INTO licenses
               (organization_id, license_type, license_status,
                max_devices, starts_at, expires_at,
                created_by_platform_admin_id, notes)
             VALUES (?, ?, 'active', ?, NOW(), NULL, ?, ?)`,
            [
              organizationId,
              licenseType,
              parsedMaxDevices,
              req.platformAdmin?.id,
              notes?.trim() || null,
            ]
          );
        } else if (expiryInput) {
          [insertResult] = await connection.query(
            `INSERT INTO licenses
               (organization_id, license_type, license_status,
                max_devices, starts_at, expires_at,
                created_by_platform_admin_id, notes)
             VALUES (?, ?, 'active', ?, NOW(),
                     CONCAT(?, ' 23:59:59'), ?, ?)`,
            [
              organizationId,
              licenseType,
              parsedMaxDevices,
              expiryInput,
              req.platformAdmin?.id,
              notes?.trim() || null,
            ]
          );
        } else {
          [insertResult] = await connection.query(
            `INSERT INTO licenses
               (organization_id, license_type, license_status,
                max_devices, starts_at, expires_at,
                created_by_platform_admin_id, notes)
             VALUES (?, ?, 'active', ?, NOW(),
                     DATE_ADD(NOW(), INTERVAL ? DAY), ?, ?)`,
            [
              organizationId,
              licenseType,
              parsedMaxDevices,
              durationDays,
              req.platformAdmin?.id,
              notes?.trim() || null,
            ]
          );
        }

        const [createdLicenses] = await connection.query(
          `SELECT id, license_type, license_status,
                  max_devices, starts_at, expires_at, notes
           FROM licenses
           WHERE id = ?
           LIMIT 1`,
          [insertResult.insertId]
        );

        updatedLicense = createdLicenses[0] || null;
      }
    }

    let updatedGymOwner = null;

    if (gymOwnerFieldsProvided) {
      const [gymOwners] = await connection.query(
        `SELECT u.id, u.full_name, u.email
         FROM users u
         INNER JOIN user_roles ur
           ON ur.organization_id = u.organization_id
          AND ur.user_id = u.id
         INNER JOIN roles r
           ON r.organization_id = ur.organization_id
          AND r.id = ur.role_id
         WHERE u.organization_id = ?
           AND r.name = 'Gym Admin'
           AND r.is_system_role = 1
         ORDER BY u.id ASC
         LIMIT 1
         FOR UPDATE`,
        [organizationId]
      );

      if (gymOwners.length === 0) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(404).json({
          success: false,
          message: "Gym Owner account not found for this organization",
        });
      }

      const oldGymOwner = gymOwners[0];
      const [duplicateUsernames] = await connection.query(
        `SELECT id
         FROM users
         WHERE organization_id = ?
           AND email = ?
           AND id <> ?
         LIMIT 1`,
        [organizationId, normalizedGymOwnerUsername, oldGymOwner.id]
      );

      if (duplicateUsernames.length > 0) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(409).json({
          success: false,
          message: "This login username is already used by another user in this organization",
        });
      }

      await connection.query(
        `UPDATE users
         SET full_name = ?, email = ?, updated_at = NOW()
         WHERE id = ? AND organization_id = ?`,
        [
          normalizedGymOwnerName,
          normalizedGymOwnerUsername,
          oldGymOwner.id,
          organizationId,
        ]
      );

      updatedGymOwner = {
        id: oldGymOwner.id,
        full_name: normalizedGymOwnerName,
        email: normalizedGymOwnerUsername,
      };

      await writePlatformAuditLog(connection, {
        platformAdminId: req.platformAdmin?.id,
        organizationId,
        action: "GYM_ADMIN_ACCOUNT_UPDATED",
        entityType: "user",
        entityId: oldGymOwner.id,
        description: `Updated Gym Owner account ${normalizedGymOwnerUsername}`,
        oldValues: {
          full_name: oldGymOwner.full_name,
          email: oldGymOwner.email,
        },
        newValues: {
          full_name: normalizedGymOwnerName,
          email: normalizedGymOwnerUsername,
        },
        ipAddress: req.ip || null,
        userAgent: req.get("user-agent") || null,
      });
    }
    await writePlatformAuditLog(connection, {
      platformAdminId: req.platformAdmin?.id,
      organizationId,
      action: "ORGANIZATION_UPDATED",
      entityType: "organization",
      entityId: organizationId,
      description: `Updated organization ${normalizedName}`,
      oldValues: {
        organization: oldOrganization,
        license: oldLicense,
      },
      newValues: {
        organization: {
          ...oldOrganization,
          name: normalizedName,
          slug: normalizedSlug,
          email: email?.trim() || null,
          phone: phone?.trim() || null,
          address: address?.trim() || null,
        },
        license: updatedLicense,
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Organization updated successfully",
      organization: {
        ...oldOrganization,
        name: normalizedName,
        slug: normalizedSlug,
        email: email?.trim() || null,
        phone: phone?.trim() || null,
        address: address?.trim() || null,
      },
      license: updatedLicense,
      gymOwner: updatedGymOwner,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    console.error("Update organization error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update organization",
    });
  } finally {
    if (connection) connection.release();
  }
};
const setOrganizationStatus = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(req.params.organizationId);
    const { status } = req.body || {};

    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID",
      });
    }

    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be active or inactive",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [organizations] = await connection.query(
      `SELECT id, name, status
       FROM organizations
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId]
    );

    if (organizations.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    const organization = organizations[0];
    const previousStatus = organization.status;

    if (previousStatus === status) {
      await connection.rollback();
      transactionStarted = false;

      return res.json({
        success: true,
        message: `Organization is already ${status}`,
        organization: {
          id: organizationId,
          status,
        },
      });
    }

    await connection.query(
      `UPDATE organizations
       SET status = ?
       WHERE id = ?`,
      [status, organizationId]
    );

    const action =
      status === "inactive"
        ? "ORGANIZATION_DEACTIVATED"
        : "ORGANIZATION_REACTIVATED";

    await writePlatformAuditLog(connection, {
      platformAdminId: req.platformAdmin?.id,
      organizationId,
      action,
      entityType: "organization",
      entityId: organizationId,
      description:
        `${status === "inactive" ? "Deactivated" : "Reactivated"} organization ${organization.name}`,
      oldValues: {
        status: previousStatus,
      },
      newValues: {
        status,
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: `Organization ${status === "inactive" ? "deactivated" : "reactivated"} successfully`,
      organization: {
        id: organizationId,
        status,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    console.error("Set organization status error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update organization status",
    });
  } finally {
    if (connection) connection.release();
  }
};

const getOrganizationGymOwner = async (req, res) => {
  try {
    const organizationId = Number(req.params.organizationId);
    if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID",
      });
    }

    const [owners] = await db.query(
      `SELECT u.id, u.full_name, u.email
       FROM users u
       INNER JOIN user_roles ur
         ON ur.organization_id = u.organization_id AND ur.user_id = u.id
       INNER JOIN roles r
         ON r.organization_id = ur.organization_id AND r.id = ur.role_id
       WHERE u.organization_id = ?
         AND r.name = 'Gym Admin'
         AND r.is_system_role = 1
       ORDER BY u.id ASC
       LIMIT 1`,
      [organizationId]
    );

    return res.json({
      success: true,
      gymOwner: owners[0] || null,
    });
  } catch (error) {
    console.error("Get organization Gym Owner error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve Gym Owner account",
    });
  }
};

const resetOrganizationGymOwnerPassword = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(req.params.organizationId);
    const { newPassword } = req.body || {};

    if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID",
      });
    }

    if (
      typeof newPassword !== "string" ||
      newPassword.length < 8 ||
      Buffer.byteLength(newPassword, "utf8") > 72
    ) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters and no more than 72 UTF-8 bytes",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [owners] = await connection.query(
      `SELECT u.id, u.email
       FROM users u
       INNER JOIN user_roles ur
         ON ur.organization_id = u.organization_id AND ur.user_id = u.id
       INNER JOIN roles r
         ON r.organization_id = ur.organization_id AND r.id = ur.role_id
       WHERE u.organization_id = ?
         AND r.name = 'Gym Admin'
         AND r.is_system_role = 1
       ORDER BY u.id ASC
       LIMIT 1
       FOR UPDATE`,
      [organizationId]
    );

    if (owners.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({
        success: false,
        message: "Gym Owner account not found for this organization",
      });
    }

    const owner = owners[0];
    const passwordHash = await bcrypt.hash(newPassword, 12);

    await connection.query(
      `UPDATE users
       SET password_hash = ?, updated_at = NOW()
       WHERE id = ? AND organization_id = ?`,
      [passwordHash, owner.id, organizationId]
    );

    await writePlatformAuditLog(connection, {
      platformAdminId: req.platformAdmin?.id,
      organizationId,
      action: "GYM_ADMIN_PASSWORD_RESET",
      entityType: "user",
      entityId: owner.id,
      description: `Reset password for Gym Owner account ${owner.email}`,
      oldValues: null,
      newValues: {
        user_id: owner.id,
        email: owner.email,
        reset_by_platform_admin_id: req.platformAdmin?.id || null,
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Gym Owner password reset successfully",
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Gym Owner password reset rollback error:", rollbackError);
      }
    }

    console.error("Reset organization Gym Owner password error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to reset Gym Owner password",
    });
  } finally {
    if (connection) connection.release();
  }
};
module.exports = {
  getOrganizationGymOwner,
  resetOrganizationGymOwnerPassword,
  createOrganization,
  getOrganizations,
  updateOrganization,
  setOrganizationStatus,
};
