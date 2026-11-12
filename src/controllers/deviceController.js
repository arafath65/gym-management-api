
const crypto = require("crypto");
const db = require("../config/db");

const hashValue = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const activateDevice = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const { device_uuid, activation_code } = req.body || {};

    if (
      typeof device_uuid !== "string" ||
      typeof activation_code !== "string" ||
      !device_uuid.trim() ||
      !activation_code.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Device UUID and activation code are required",
      });
    }

    const deviceUuid = device_uuid.trim();
    const activationCode = activation_code.trim();

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const activationHash = hashValue(activationCode);

    const [matchedDevices] = await connection.query(
      `SELECT id, organization_id
       FROM devices
       WHERE device_uuid = ?
         AND activation_code_hash = ?
         AND status = 'pending'
       LIMIT 1`,
      [deviceUuid, activationHash]
    );

    if (matchedDevices.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(401).json({
        success: false,
        message: "Invalid activation code or device",
      });
    }

    const orgId = matchedDevices[0].organization_id;

    // Lock and verify the organization before checking its license.
    // This serializes activation against organization deactivation.
    const [organizations] = await connection.query(
      `SELECT id, name, status
       FROM organizations
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [orgId]
    );

    if (organizations.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        code: "ORGANIZATION_NOT_FOUND",
        message: "Organization not found",
      });
    }

    if (organizations[0].status !== "active") {
      await connection.rollback();
      transactionStarted = false;

      return res.status(403).json({
        success: false,
        code: "ORGANIZATION_INACTIVE",
        message: "This organization is inactive and cannot activate devices",
      });
    }

    // Lock the organization's license to prevent simultaneous
    // activations from exceeding the device limit.
    const [licenses] = await connection.query(
      `SELECT id, organization_id, license_status,
              starts_at, expires_at, max_devices
       FROM licenses
       WHERE organization_id = ?
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [orgId]
    );

    if (licenses.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(403).json({
        success: false,
        code: "LICENSE_NOT_FOUND",
        message: "No license found for this organization",
      });
    }

    const license = licenses[0];
    const now = new Date();

    if (license.license_status !== "active") {
      await connection.rollback();
      transactionStarted = false;

      return res.status(403).json({
        success: false,
        code: "LICENSE_INACTIVE",
        message: "Organization license is not active",
      });
    }

    if (new Date(license.starts_at) > now) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(403).json({
        success: false,
        code: "LICENSE_NOT_STARTED",
        message: "Organization license has not started yet",
      });
    }

    if (license.expires_at && new Date(license.expires_at) < now) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(403).json({
        success: false,
        code: "LICENSE_EXPIRED",
        message: "Organization license has expired",
      });
    }

    // Count only currently active devices.
    const [deviceCounts] = await connection.query(
      `SELECT COUNT(*) AS active_device_count
       FROM devices
       WHERE organization_id = ?
         AND status = 'active'`,
      [orgId]
    );

    const activeDeviceCount = Number(deviceCounts[0].active_device_count);
    const maxDevices = Number(license.max_devices);

    if (activeDeviceCount >= maxDevices) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(403).json({
        success: false,
        code: "DEVICE_LIMIT_REACHED",
        message: "Organization has reached its licensed device limit",
        device_limit: maxDevices,
        active_devices: activeDeviceCount,
      });
    }

    const [devices] = await connection.query(
      `SELECT id, organization_id, device_uuid, status,
              activation_expires_at
       FROM devices
       WHERE organization_id = ?
         AND device_uuid = ?
         AND activation_code_hash = ?
       FOR UPDATE`,
      [orgId, deviceUuid, activationHash]
    );

    if (devices.length === 0) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(401).json({
        success: false,
        message: "Invalid activation code or device",
      });
    }

    const device = devices[0];

    if (device.status !== "pending") {
      await connection.rollback();
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "This device is not pending activation",
      });
    }

    if (
      !device.activation_expires_at ||
      new Date(device.activation_expires_at).getTime() <= Date.now()
    ) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(401).json({
        success: false,
        message: "Activation code has expired",
      });
    }

    const deviceToken = crypto.randomBytes(32).toString("hex");
    const deviceTokenHash = hashValue(deviceToken);

    const [result] = await connection.query(
      `UPDATE devices
       SET status = 'active',
           device_token_hash = ?,
           activation_code_hash = NULL,
           activation_expires_at = NULL,
           last_seen_at = NOW()
       WHERE id = ?
         AND organization_id = ?
         AND status = 'pending'`,
      [deviceTokenHash, device.id, orgId]
    );

    if (result.affectedRows !== 1) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "Device activation could not be completed",
      });
    }

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Device activated successfully",
      organization: {
        id: organizations[0].id,
        name: organizations[0].name,
      },
      device: {
        id: device.id,
        organization_id: device.organization_id,
        device_uuid: device.device_uuid,
        status: "active",
      },
      device_token: deviceToken,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    console.error("Activate device error:", error);

    return res.status(500).json({
      success: false,
      message: "Device activation failed",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

module.exports = {
  activateDevice,
};
