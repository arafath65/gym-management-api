const db = require("../config/db");
const {
  writePlatformAuditLog,
} = require("../services/platformAuditService");

const LICENSE_TYPES = ["trial", "monthly", "yearly", "lifetime"];
const LICENSE_STATUSES = ["active", "expired", "suspended"];

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const parsePositiveInteger = (value, fieldName) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw createHttpError(400, `${fieldName} must be a positive integer`);
  }
  return parsed;
};

const validateMaxDevices = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw createHttpError(400, "Maximum devices must be between 1 and 1000");
  }
  return parsed;
};

const validateLicenseType = (value) => {
  if (!LICENSE_TYPES.includes(value)) {
    throw createHttpError(400, "Invalid license type");
  }
  return value;
};

const validateNotes = (value) => {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw createHttpError(400, "Notes must be text");
  }
  const notes = value.trim();
  if (notes.length > 500) {
    throw createHttpError(400, "Notes cannot exceed 500 characters");
  }
  return notes || null;
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

const validateDuration = (licenseType, trialDays) => {
  if (licenseType === "trial") {
    const days = Number(trialDays ?? 14);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw createHttpError(400, "Trial duration must be between 1 and 365 days");
    }
    return days;
  }
  if (licenseType === "monthly") return 30;
  if (licenseType === "yearly") return 365;
  return null;
};

const getRequestMetadata = (req) => ({
  platformAdminId: req.platformAdmin?.id,
  ipAddress: req.ip || null,
  userAgent: req.get("user-agent") || null,
});

const sendControllerError = (res, error, fallbackMessage) => {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (statusCode === 500) {
    console.error(`${fallbackMessage}:`, error);
  }
  return res.status(statusCode).json({
    success: false,
    message: statusCode === 500 ? fallbackMessage : error.message,
  });
};

const getLicenses = async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const requestedLimit = Number.parseInt(req.query.limit, 10) || 25;
    const limit = [25, 50, 100].includes(requestedLimit) ? requestedLimit : 25;
    const offset = (page - 1) * limit;

    const search = typeof req.query.search === "string"
      ? req.query.search.trim().slice(0, 100)
      : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const licenseType = typeof req.query.licenseType === "string"
      ? req.query.licenseType
      : "";
    const organizationId = req.query.organizationId
      ? parsePositiveInteger(req.query.organizationId, "Organization ID")
      : null;

    if (status && ![...LICENSE_STATUSES, "all"].includes(status)) {
      throw createHttpError(400, "Invalid license status filter");
    }
    if (licenseType && ![...LICENSE_TYPES, "all"].includes(licenseType)) {
      throw createHttpError(400, "Invalid license type filter");
    }

    const baseConditions = [];
    const baseParams = [];

    if (organizationId) {
      baseConditions.push("l.organization_id = ?");
      baseParams.push(organizationId);
    }
    if (licenseType && licenseType !== "all") {
      baseConditions.push("l.license_type = ?");
      baseParams.push(licenseType);
    }
    if (search) {
      baseConditions.push(`(
        o.name LIKE ? OR
        o.slug LIKE ? OR
        o.organization_code LIKE ? OR
        l.notes LIKE ? OR
        CAST(l.id AS CHAR) LIKE ?
      )`);
      const searchValue = `%${search}%`;
      baseParams.push(
        searchValue,
        searchValue,
        searchValue,
        searchValue,
        searchValue,
      );
    }

    const statusCondition = (selectedStatus) => {
      if (!selectedStatus || selectedStatus === "all") return null;
      if (selectedStatus === "expired") {
        return `(
          l.license_status = 'expired' OR
          (l.license_status = 'active' AND l.expires_at IS NOT NULL AND l.expires_at <= NOW())
        )`;
      }
      if (selectedStatus === "active") {
        return `(
          l.license_status = 'active' AND
          l.starts_at <= NOW() AND
          (l.expires_at IS NULL OR l.expires_at > NOW())
        )`;
      }
      return "l.license_status = 'suspended'";
    };

    const listConditions = [...baseConditions];
    const selectedStatusCondition = statusCondition(status);
    if (selectedStatusCondition) listConditions.push(selectedStatusCondition);
    const whereSql = listConditions.length
      ? `WHERE ${listConditions.join(" AND ")}`
      : "";
    const baseWhereSql = baseConditions.length
      ? `WHERE ${baseConditions.join(" AND ")}`
      : "";

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM licenses l
       INNER JOIN organizations o ON o.id = l.organization_id
       ${whereSql}`,
      baseParams,
    );

    const [statusRows] = await db.query(
      `SELECT
         COUNT(*) AS all_count,
         SUM(CASE WHEN l.license_status = 'active'
                    AND l.starts_at <= NOW()
                    AND (l.expires_at IS NULL OR l.expires_at > NOW())
                  THEN 1 ELSE 0 END) AS active_count,
         SUM(CASE WHEN l.license_status = 'suspended'
                  THEN 1 ELSE 0 END) AS suspended_count,
         SUM(CASE WHEN l.license_status = 'expired'
                    OR (l.license_status = 'active'
                        AND l.expires_at IS NOT NULL
                        AND l.expires_at <= NOW())
                  THEN 1 ELSE 0 END) AS expired_count
       FROM licenses l
       INNER JOIN organizations o ON o.id = l.organization_id
       ${baseWhereSql}`,
      baseParams,
    );

    const [licenses] = await db.query(
      `SELECT
         l.id,
         l.organization_id,
         l.license_type,
         l.license_status,
         CASE
           WHEN l.license_status = 'active'
             AND l.expires_at IS NOT NULL
             AND l.expires_at <= NOW() THEN 'expired'
           ELSE l.license_status
         END AS effective_status,
         l.max_devices,
         l.starts_at,
         l.expires_at,
         l.created_by_platform_admin_id,
         l.notes,
         l.created_at,
         l.updated_at,
         o.name AS organization_name,
         o.slug AS organization_slug,
         o.organization_code,
         o.status AS organization_status,
         NOT EXISTS (
           SELECT 1
           FROM licenses newer
           WHERE newer.organization_id = l.organization_id
             AND (
               newer.created_at > l.created_at OR
               (newer.created_at = l.created_at AND newer.id > l.id)
             )
         ) AS is_latest
       FROM licenses l
       INNER JOIN organizations o ON o.id = l.organization_id
       ${whereSql}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT ? OFFSET ?`,
      [...baseParams, limit, offset],
    );

    const total = Number(countRows[0]?.total || 0);
    const counts = statusRows[0] || {};

    return res.json({
      success: true,
      licenses,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasPreviousPage: page > 1,
        hasNextPage: offset + licenses.length < total,
      },
      statusCounts: {
        all: Number(counts.all_count || 0),
        active: Number(counts.active_count || 0),
        suspended: Number(counts.suspended_count || 0),
        expired: Number(counts.expired_count || 0),
      },
      filters: { search, status: status || "all", licenseType: licenseType || "all", organizationId },
    });
  } catch (error) {
    return sendControllerError(res, error, "Failed to load licenses");
  }
};

const getLicenseById = async (req, res) => {
  try {
    const licenseId = parsePositiveInteger(req.params.licenseId, "License ID");
    const [rows] = await db.query(
      `SELECT
         l.*,
         o.name AS organization_name,
         o.slug AS organization_slug,
         o.organization_code,
         o.email AS organization_email,
         o.phone AS organization_phone,
         o.status AS organization_status,
         CASE
           WHEN l.license_status = 'active'
             AND l.expires_at IS NOT NULL
             AND l.expires_at <= NOW() THEN 'expired'
           ELSE l.license_status
         END AS effective_status
       FROM licenses l
       INNER JOIN organizations o ON o.id = l.organization_id
       WHERE l.id = ?
       LIMIT 1`,
      [licenseId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "License not found" });
    }

    const license = rows[0];
    const [history] = await db.query(
      `SELECT
         id, license_type, license_status, max_devices,
         starts_at, expires_at, notes, created_at, updated_at
       FROM licenses
       WHERE organization_id = ?
       ORDER BY created_at DESC, id DESC`,
      [license.organization_id],
    );

    return res.json({ success: true, license, history });
  } catch (error) {
    return sendControllerError(res, error, "Failed to load license details");
  }
};

const createLicense = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const body = req.body || {};
    const organizationId = parsePositiveInteger(body.organizationId, "Organization ID");
    const licenseType = validateLicenseType(body.licenseType || "trial");
    const maxDevices = validateMaxDevices(body.maxDevices ?? 2);
    const trialDays = body.trialDays ?? 14;
    const durationDays = validateDuration(licenseType, trialDays);
    const notes = validateNotes(body.notes);
    const expiresAt = body.expiresAt == null ? "" : String(body.expiresAt).trim();

    if (licenseType === "lifetime" && expiresAt) {
      throw createHttpError(400, "Lifetime licenses cannot have an expiry date");
    }
    if (expiresAt && !validateExpiryDate(expiresAt)) {
      throw createHttpError(400, "Expiry date must be a valid date in YYYY-MM-DD format");
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
      [organizationId],
    );
    if (organizations.length === 0) {
      throw createHttpError(404, "Organization not found");
    }
    const organization = organizations[0];
    if (organization.status !== "active") {
      throw createHttpError(409, "Cannot issue a license to an organization that is not active");
    }

    if (expiresAt) {
      const [dateCheckRows] = await connection.query(
        "SELECT (CONCAT(?, ' 23:59:59') > NOW()) AS is_future",
        [expiresAt],
      );
      if (Number(dateCheckRows[0]?.is_future) !== 1) {
        throw createHttpError(400, "Expiry date must be later than the current date and time");
      }
    }

    const [latestRows] = await connection.query(
      `SELECT id, license_type, license_status, max_devices, starts_at, expires_at, notes
       FROM licenses
       WHERE organization_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [organizationId],
    );
    const previousLicense = latestRows[0] || null;

    if (previousLicense?.license_status === "active") {
      const [validRows] = await connection.query(
        `SELECT (
           starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())
         ) AS is_current
         FROM licenses WHERE id = ? LIMIT 1`,
        [previousLicense.id],
      );
      if (Number(validRows[0]?.is_current) === 1) {
        throw createHttpError(409, "This organization already has a current active license. Use the renew action instead.");
      }
      await connection.query(
        "UPDATE licenses SET license_status = 'expired' WHERE id = ? AND license_status = 'active'",
        [previousLicense.id],
      );
    }

    let expiryExpression = "NULL";
    const insertParams = [organizationId, licenseType, maxDevices];
    if (licenseType !== "lifetime") {
      if (expiresAt) {
        expiryExpression = "CONCAT(?, ' 23:59:59')";
        insertParams.push(expiresAt);
      } else {
        expiryExpression = "DATE_ADD(NOW(), INTERVAL ? DAY)";
        insertParams.push(durationDays);
      }
    }
    insertParams.push(req.platformAdmin?.id || null, notes);

    const [insertResult] = await connection.query(
      `INSERT INTO licenses (
         organization_id, license_type, license_status, max_devices,
         starts_at, expires_at, created_by_platform_admin_id, notes
       ) VALUES (?, ?, 'active', ?, NOW(), ${expiryExpression}, ?, ?)`,
      insertParams,
    );

    const [newRows] = await connection.query(
      "SELECT * FROM licenses WHERE id = ? LIMIT 1",
      [insertResult.insertId],
    );
    const newLicense = newRows[0];

    await writePlatformAuditLog(connection, {
      ...getRequestMetadata(req),
      organizationId,
      action: "LICENSE_CREATED",
      entityType: "license",
      entityId: newLicense.id,
      description: `Created ${licenseType} license for ${organization.name}`,
      oldValues: previousLicense,
      newValues: newLicense,
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "License created successfully",
      license: newLicense,
    });
  } catch (error) {
    if (connection && transactionStarted) await connection.rollback();
    return sendControllerError(res, error, "Failed to create license");
  } finally {
    if (connection) connection.release();
  }
};

const renewLicense = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const licenseId = parsePositiveInteger(req.params.licenseId, "License ID");
    const body = req.body || {};

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    // Read organization_id first, then lock in organization -> license order.
    // This matches createLicense and avoids inconsistent renew/create locking.
    const [referenceRows] = await connection.query(
      "SELECT organization_id FROM licenses WHERE id = ? LIMIT 1",
      [licenseId],
    );
    if (referenceRows.length === 0) {
      throw createHttpError(404, "License not found");
    }
    const organizationId = Number(referenceRows[0].organization_id);

    const [organizations] = await connection.query(
      "SELECT id, name FROM organizations WHERE id = ? LIMIT 1 FOR UPDATE",
      [organizationId],
    );
    if (organizations.length === 0) {
      throw createHttpError(404, "Organization not found");
    }

    const [licenseRows] = await connection.query(
      `SELECT * FROM licenses WHERE id = ? LIMIT 1 FOR UPDATE`,
      [licenseId],
    );
    const previousLicense = licenseRows[0];

    const [latestRows] = await connection.query(
      `SELECT id
       FROM licenses
       WHERE organization_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [organizationId],
    );
    if (Number(latestRows[0]?.id) !== licenseId) {
      throw createHttpError(409, "Only the latest license can be renewed");
    }

    const licenseType = validateLicenseType(body.licenseType || previousLicense.license_type);
    const maxDevices = validateMaxDevices(body.maxDevices ?? previousLicense.max_devices);
    const durationDays = validateDuration(licenseType, body.trialDays ?? 14);
    const notes = Object.prototype.hasOwnProperty.call(body, "notes")
      ? validateNotes(body.notes)
      : previousLicense.notes;
    const expiresAt = body.expiresAt == null ? "" : String(body.expiresAt).trim();

    if (licenseType === "lifetime" && expiresAt) {
      throw createHttpError(400, "Lifetime licenses cannot have an expiry date");
    }
    if (expiresAt && !validateExpiryDate(expiresAt)) {
      throw createHttpError(400, "Expiry date must be a valid date in YYYY-MM-DD format");
    }

    let expiryExpression = "NULL";
    const insertParams = [organizationId, licenseType, maxDevices];
    if (licenseType !== "lifetime") {
      if (expiresAt) {
        const [dateCheckRows] = await connection.query(
          `SELECT (CONCAT(?, ' 23:59:59') > GREATEST(NOW(), COALESCE(?, NOW()))) AS is_valid`,
          [expiresAt, previousLicense.expires_at],
        );
        if (Number(dateCheckRows[0]?.is_valid) !== 1) {
          throw createHttpError(400, "Expiry date must be later than today and any remaining license period");
        }
        expiryExpression = "CONCAT(?, ' 23:59:59')";
        insertParams.push(expiresAt);
      } else {
        // Start the renewed license immediately, but extend from the current
        // expiry when time remains. This keeps the existing activation
        // middleware working because the newest license is valid immediately.
        expiryExpression = "DATE_ADD(GREATEST(NOW(), COALESCE(?, NOW())), INTERVAL ? DAY)";
        insertParams.push(previousLicense.expires_at, durationDays);
      }
    }
    insertParams.push(req.platformAdmin?.id || null, notes);

    await connection.query(
      `UPDATE licenses
       SET license_status = 'expired'
       WHERE id = ?
         AND license_status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()`,
      [licenseId],
    );

    const [insertResult] = await connection.query(
      `INSERT INTO licenses (
         organization_id, license_type, license_status, max_devices,
         starts_at, expires_at, created_by_platform_admin_id, notes
       ) VALUES (?, ?, 'active', ?, NOW(), ${expiryExpression}, ?, ?)`,
      insertParams,
    );

    const [newRows] = await connection.query(
      "SELECT * FROM licenses WHERE id = ? LIMIT 1",
      [insertResult.insertId],
    );
    const newLicense = newRows[0];

    await writePlatformAuditLog(connection, {
      ...getRequestMetadata(req),
      organizationId,
      action: "LICENSE_RENEWED",
      entityType: "license",
      entityId: newLicense.id,
      description: `Renewed license for ${organizations[0].name}`,
      oldValues: previousLicense,
      newValues: {
        license: newLicense,
        supersedesLicenseId: licenseId,
      },
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "License renewed successfully",
      license: newLicense,
      previousLicenseId: licenseId,
    });
  } catch (error) {
    if (connection && transactionStarted) await connection.rollback();
    return sendControllerError(res, error, "Failed to renew license");
  } finally {
    if (connection) connection.release();
  }
};

const updateLicenseStatus = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const licenseId = parsePositiveInteger(req.params.licenseId, "License ID");
    const status = req.body?.status;
    if (!LICENSE_STATUSES.includes(status)) {
      throw createHttpError(400, "Status must be active, suspended or expired");
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [referenceRows] = await connection.query(
      "SELECT organization_id FROM licenses WHERE id = ? LIMIT 1",
      [licenseId],
    );
    if (referenceRows.length === 0) {
      throw createHttpError(404, "License not found");
    }
    const organizationId = Number(referenceRows[0].organization_id);

    await connection.query(
      "SELECT id FROM organizations WHERE id = ? LIMIT 1 FOR UPDATE",
      [organizationId],
    );
    const [licenseRows] = await connection.query(
      "SELECT * FROM licenses WHERE id = ? LIMIT 1 FOR UPDATE",
      [licenseId],
    );
    const oldLicense = licenseRows[0];

    const [latestRows] = await connection.query(
      `SELECT id FROM licenses
       WHERE organization_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1 FOR UPDATE`,
      [organizationId],
    );
    if (Number(latestRows[0]?.id) !== licenseId) {
      throw createHttpError(409, "Only the latest license status can be changed");
    }

    if (status === "active") {
      const [validRows] = await connection.query(
        `SELECT (
           starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())
         ) AS is_current
         FROM licenses WHERE id = ? LIMIT 1`,
        [licenseId],
      );
      if (Number(validRows[0]?.is_current) !== 1) {
        throw createHttpError(409, "This license has expired or has not started. Renew it instead of reactivating it.");
      }
    }

    if (oldLicense.license_status === status) {
      await connection.rollback();
      transactionStarted = false;
      return res.json({
        success: true,
        message: `License is already ${status}`,
        license: oldLicense,
      });
    }

    await connection.query(
      "UPDATE licenses SET license_status = ? WHERE id = ?",
      [status, licenseId],
    );
    const [updatedRows] = await connection.query(
      "SELECT * FROM licenses WHERE id = ? LIMIT 1",
      [licenseId],
    );
    const newLicense = updatedRows[0];

    const action = status === "suspended"
      ? "LICENSE_SUSPENDED"
      : status === "expired"
        ? "LICENSE_EXPIRED"
        : "LICENSE_REACTIVATED";

    await writePlatformAuditLog(connection, {
      ...getRequestMetadata(req),
      organizationId,
      action,
      entityType: "license",
      entityId: licenseId,
      description: `Changed license status from ${oldLicense.license_status} to ${status}`,
      oldValues: { license_status: oldLicense.license_status },
      newValues: { license_status: status },
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: `License ${status === "suspended" ? "suspended" : status === "expired" ? "marked as expired" : "reactivated"} successfully`,
      license: newLicense,
    });
  } catch (error) {
    if (connection && transactionStarted) await connection.rollback();
    return sendControllerError(res, error, "Failed to update license status");
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getLicenses,
  getLicenseById,
  createLicense,
  renewLicense,
  updateLicenseStatus,
};
