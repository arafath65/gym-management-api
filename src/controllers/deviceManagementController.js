const crypto = require("crypto");
const db = require("../config/db");
const { writePlatformAuditLog } = require("../services/platformAuditService");

const hashValue = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const createActivationCode = () =>
  crypto.randomBytes(5).toString("hex").toUpperCase();

const lockOrganizationAndCheckLicense = async (
  connection,
  organizationId
) => {
  const [organizations] = await connection.query(
    `SELECT id, name, status
     FROM organizations
     WHERE id = ?
     LIMIT 1
     FOR UPDATE`,
    [organizationId]
  );

  if (organizations.length === 0) {
    return {
      error: {
        status: 404,
        message: "Organization not found",
      },
    };
  }

  const organization = organizations[0];

  if (organization.status !== "active") {
    return {
      error: {
        status: 403,
        message: "Inactive organizations cannot manage device activation",
      },
    };
  }

  const [licenses] = await connection.query(
    `SELECT id, license_type, license_status,
            max_devices, starts_at, expires_at
     FROM licenses
     WHERE organization_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [organizationId]
  );

  if (licenses.length === 0) {
    return {
      error: {
        status: 403,
        message: "This organization does not have a license",
      },
    };
  }

  const license = licenses[0];
  const now = Date.now();

  if (license.license_status !== "active") {
    return {
      error: {
        status: 403,
        message: "Organization license is not active",
      },
    };
  }

  if (new Date(license.starts_at).getTime() > now) {
    return {
      error: {
        status: 403,
        message: "Organization license has not started",
      },
    };
  }

  if (
    license.expires_at &&
    new Date(license.expires_at).getTime() < now
  ) {
    return {
      error: {
        status: 403,
        message: "Organization license has expired",
      },
    };
  }

  const [counts] = await connection.query(
    `SELECT COUNT(*) AS active_device_count
     FROM devices
     WHERE organization_id = ?
       AND status = 'active'`,
    [organizationId]
  );

  const activeCount = Number(counts[0].active_device_count);
  const maxDevices = Number(license.max_devices);

  if (activeCount >= maxDevices) {
    return {
      error: {
        status: 403,
        message: "Organization has reached its licensed device limit",
      },
    };
  }

  return {
    organization,
    license,
    activeCount,
  };
};

// ---------------------------------------------------------
// GET DEVICES
// GET /api/devices
// ---------------------------------------------------------

const getDevices = async (req, res) => {
  try {
    const { status, organizationId, search } = req.query;

    const allowedStatuses = ["pending", "active", "revoked"];

    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid device status filter",
      });
    }

    const conditions = [];
    const params = [];

    if (status) {
      conditions.push("d.status = ?");
      params.push(status);
    }

    if (organizationId !== undefined) {
      const orgId = Number(organizationId);

      if (!Number.isInteger(orgId) || orgId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid organization ID",
        });
      }

      conditions.push("d.organization_id = ?");
      params.push(orgId);
    }

    if (search && String(search).trim()) {
      conditions.push(
        `CONCAT_WS(' ',
          d.device_name,
          d.device_uuid,
          o.name,
          o.organization_code,
          b.name,
          b.branch_code
        ) LIKE ?`
      );
      params.push(`%${String(search).trim()}%`);
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    const [devices] = await db.query(
      `SELECT
         d.id,
         d.organization_id,
         d.registered_branch_id,
         d.device_uuid,
         d.device_name,
         d.device_type,
         d.status,
         d.activation_expires_at,
         d.last_seen_at,
         d.created_at,

         o.name AS organization_name,
         o.organization_code,
         o.status AS organization_status,

         b.name AS branch_name,
         b.branch_code,

         l.license_type,
         l.license_status,
         l.max_devices

       FROM devices d

       INNER JOIN organizations o
         ON o.id = d.organization_id

       LEFT JOIN branches b
         ON b.id = d.registered_branch_id
         AND b.organization_id = d.organization_id

       LEFT JOIN licenses l
         ON l.id = (
           SELECT l2.id
           FROM licenses l2
           WHERE l2.organization_id = d.organization_id
           ORDER BY l2.created_at DESC, l2.id DESC
           LIMIT 1
         )

       ${whereClause}

       ORDER BY d.created_at DESC, d.id DESC`,
      params
    );

    return res.json({
      success: true,
      count: devices.length,
      devices,
    });
  } catch (error) {
    console.error("Get devices error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve devices",
    });
  }
};

// ---------------------------------------------------------
// REGISTER DEVICE
// POST /api/devices/register
// ---------------------------------------------------------

const registerDevice = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const {
      organization_id,
      registered_branch_id,
      device_uuid,
      device_name,
      device_type = "other",
    } = req.body || {};

    const organizationId = Number(organization_id);
    const branchId =
      registered_branch_id == null ||
      registered_branch_id === ""
        ? null
        : Number(registered_branch_id);

    const allowedTypes = [
      "android_tablet",
      "android_mobile",
      "other",
    ];

    if (
      !Number.isInteger(organizationId) ||
      organizationId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid organization ID is required",
      });
    }

    if (
      branchId !== null &&
      (!Number.isInteger(branchId) || branchId <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch ID",
      });
    }

    if (
      typeof device_uuid !== "string" ||
      !device_uuid.trim() ||
      device_uuid.trim().length > 150
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid device UUID is required",
      });
    }

    if (
      typeof device_name !== "string" ||
      !device_name.trim() ||
      device_name.trim().length > 150
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid device name is required",
      });
    }

    if (!allowedTypes.includes(device_type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid device type",
      });
    }

    const normalizedUuid = device_uuid.trim();
    const normalizedName = device_name.trim();

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const organizationResult =
      await lockOrganizationAndCheckLicense(
        connection,
        organizationId
      );

    if (organizationResult.error) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(
        organizationResult.error.status
      ).json({
        success: false,
        message: organizationResult.error.message,
      });
    }

    if (branchId !== null) {
      const [branches] = await connection.query(
        `SELECT id
         FROM branches
         WHERE id = ?
           AND organization_id = ?
           AND status = 'active'
         LIMIT 1
         FOR UPDATE`,
        [branchId, organizationId]
      );

      if (branches.length === 0) {
        await connection.rollback();
        transactionStarted = false;

        return res.status(404).json({
          success: false,
          message: "Active branch not found in this organization",
        });
      }
    }

    const [existingDevices] = await connection.query(
      `SELECT id
       FROM devices
       WHERE device_uuid = ?
       LIMIT 1
       FOR UPDATE`,
      [normalizedUuid]
    );

    if (existingDevices.length > 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "This device UUID is already registered",
      });
    }

    const activationCode = createActivationCode();
    const activationHash = hashValue(activationCode);

    const [result] = await connection.query(
      `INSERT INTO devices (
         organization_id,
         registered_branch_id,
         device_uuid,
         device_name,
         device_type,
         status,
         activation_code_hash,
         activation_expires_at
       )
       VALUES (?, ?, ?, ?, ?, 'pending', ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
      [
        organizationId,
        branchId,
        normalizedUuid,
        normalizedName,
        device_type,
        activationHash,
      ]
    );

    const [createdDevices] = await connection.query(
      `SELECT id, organization_id, registered_branch_id,
              device_uuid, device_name, device_type,
              status, activation_expires_at, created_at
       FROM devices
       WHERE id = ?
       LIMIT 1`,
      [result.insertId]
    );

    const device = createdDevices[0];

    await writePlatformAuditLog(connection, {
      platformAdminId: req.platformAdmin?.id,
      organizationId,
      action: "DEVICE_REGISTERED",
      entityType: "device",
      entityId: device.id,
      description: `Registered device ${normalizedName}`,
      oldValues: null,
      newValues: {
        device_uuid: normalizedUuid,
        device_name: normalizedName,
        device_type,
        registered_branch_id: branchId,
        status: "pending",
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Device registered successfully",
      device,
      activation_code: activationCode,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "This device UUID is already registered",
      });
    }

    console.error("Register device error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to register device",
    });
  } finally {
    if (connection) connection.release();
  }
};

// ---------------------------------------------------------
// REGENERATE ACTIVATION CODE / REACTIVATE REVOKED DEVICE
// POST /api/devices/:deviceId/activation-code
// ---------------------------------------------------------

const regenerateDeviceActivationCode = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const deviceId = Number(req.params.deviceId);

    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid device ID",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [initialDevices] = await connection.query(
      `SELECT id, organization_id
       FROM devices
       WHERE id = ?
       LIMIT 1`,
      [deviceId]
    );

    if (initialDevices.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Device not found",
      });
    }

    const organizationId = initialDevices[0].organization_id;

    const organizationResult =
      await lockOrganizationAndCheckLicense(
        connection,
        organizationId
      );

    if (organizationResult.error) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(
        organizationResult.error.status
      ).json({
        success: false,
        message: organizationResult.error.message,
      });
    }

    const [devices] = await connection.query(
      `SELECT id, organization_id, device_uuid,
              device_name, device_type, status,
              registered_branch_id
       FROM devices
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [deviceId]
    );

    if (devices.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Device not found",
      });
    }

    const oldDevice = devices[0];

    if (oldDevice.status === "active") {
      await connection.rollback();
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "Revoke the active device before generating a new activation code",
      });
    }

    const activationCode = createActivationCode();
    const activationHash = hashValue(activationCode);

    await connection.query(
      `UPDATE devices
       SET status = 'pending',
           activation_code_hash = ?,
           device_token_hash = NULL,
           activation_expires_at = DATE_ADD(NOW(), INTERVAL 24 HOUR)
       WHERE id = ?`,
      [activationHash, deviceId]
    );

    const [updatedDevices] = await connection.query(
      `SELECT id, organization_id, registered_branch_id,
              device_uuid, device_name, device_type,
              status, activation_expires_at, created_at
       FROM devices
       WHERE id = ?
       LIMIT 1`,
      [deviceId]
    );

    const updatedDevice = updatedDevices[0];

    const action =
      oldDevice.status === "revoked"
        ? "DEVICE_REACTIVATED"
        : "DEVICE_ACTIVATION_CODE_REGENERATED";

    await writePlatformAuditLog(connection, {
      platformAdminId: req.platformAdmin?.id,
      organizationId,
      action,
      entityType: "device",
      entityId: deviceId,
      description:
        oldDevice.status === "revoked"
          ? `Reactivated device ${oldDevice.device_name}`
          : `Regenerated activation code for ${oldDevice.device_name}`,
      oldValues: {
        status: oldDevice.status,
      },
      newValues: {
        status: "pending",
        activation_expires_at: updatedDevice.activation_expires_at,
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Activation code generated successfully",
      device: updatedDevice,
      activation_code: activationCode,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    console.error("Regenerate device code error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to generate activation code",
    });
  } finally {
    if (connection) connection.release();
  }
};

// ---------------------------------------------------------
// REVOKE DEVICE
// PATCH /api/devices/:deviceId/revoke
// ---------------------------------------------------------

const revokeDevice = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const deviceId = Number(req.params.deviceId);

    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid device ID",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [initialDevices] = await connection.query(
      `SELECT id, organization_id
       FROM devices
       WHERE id = ?
       LIMIT 1`,
      [deviceId]
    );

    if (initialDevices.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Device not found",
      });
    }

    const organizationId = initialDevices[0].organization_id;

    await connection.query(
      `SELECT id
       FROM organizations
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId]
    );

    const [devices] = await connection.query(
      `SELECT id, organization_id, device_uuid,
              device_name, device_type, status
       FROM devices
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [deviceId]
    );

    if (devices.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Device not found",
      });
    }

    const oldDevice = devices[0];

    if (oldDevice.status === "revoked") {
      await connection.rollback();
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "Device is already revoked",
      });
    }

    await connection.query(
      `UPDATE devices
       SET status = 'revoked',
           activation_code_hash = NULL,
           activation_expires_at = NULL,
           device_token_hash = NULL
       WHERE id = ?`,
      [deviceId]
    );

    await writePlatformAuditLog(connection, {
      platformAdminId: req.platformAdmin?.id,
      organizationId,
      action: "DEVICE_REVOKED",
      entityType: "device",
      entityId: deviceId,
      description: `Revoked device ${oldDevice.device_name}`,
      oldValues: {
        status: oldDevice.status,
      },
      newValues: {
        status: "revoked",
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Device revoked successfully",
      device_id: deviceId,
      status: "revoked",
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    console.error("Revoke device error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to revoke device",
    });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getDevices,
  registerDevice,
  regenerateDeviceActivationCode,
  revokeDevice,
};
