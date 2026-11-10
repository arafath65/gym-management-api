const crypto = require("crypto");
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

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Organization and license created successfully",
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
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    console.error("Create organization error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create organization and license",
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

module.exports = {
  createOrganization,
  getOrganizations,
  updateOrganization,
  setOrganizationStatus,
};
