const crypto = require("crypto");
const db = require("../config/db");

const hashValue = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const authenticateDevice = async (req, res, next) => {
  // Device token has its own header so Gym Staff JWT can use Authorization.
  const deviceTokenHeader = req.headers["x-device-token"];
  const authorization = req.headers.authorization;

  let token = null;

  if (deviceTokenHeader !== undefined) {
    if (
      typeof deviceTokenHeader !== "string" ||
      !deviceTokenHeader.trim()
    ) {
      return res.status(401).json({
        success: false,
        code: "DEVICE_TOKEN_REQUIRED",
        message: "A valid device authentication token is required",
      });
    }

    token = deviceTokenHeader.trim();

  } else if (
    typeof authorization === "string" &&
    authorization.startsWith("Bearer ")
  ) {
    // Backward compatibility for device activation/validation clients.
    token = authorization.slice(7).trim();
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      code: "DEVICE_TOKEN_REQUIRED",
      message: "Device authentication token is required",
    });
  }

  // Device tokens are generated as 32 random bytes encoded as hex.
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(401).json({
      success: false,
      code: "INVALID_DEVICE_TOKEN",
      message: "Invalid device authentication token",
    });
  }

  try {
    const tokenHash = hashValue(token);

    const [rows] = await db.query(
      `SELECT
         d.id AS device_id,
         d.organization_id,
         d.device_uuid,
         d.device_name,
         d.registered_branch_id,
         d.status AS device_status,

         o.name AS organization_name,
         o.status AS organization_status,

         l.id AS license_id,
         l.license_status,

         CASE
           WHEN l.starts_at IS NULL OR l.starts_at <= NOW()
           THEN 1 ELSE 0
         END AS license_started,

         CASE
           WHEN l.expires_at IS NULL OR l.expires_at > NOW()
           THEN 1 ELSE 0
         END AS license_not_expired

       FROM devices d

       INNER JOIN organizations o
         ON o.id = d.organization_id

       LEFT JOIN licenses l
         ON l.id = (
           SELECT l2.id
           FROM licenses l2
           WHERE l2.organization_id = d.organization_id
           ORDER BY l2.created_at DESC, l2.id DESC
           LIMIT 1
         )

       WHERE d.device_token_hash = ?
       LIMIT 1`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        code: "DEVICE_NOT_FOUND",
        message: "This device is no longer registered or its token is invalid",
      });
    }

    const row = rows[0];

    if (row.device_status !== "active") {
      return res.status(403).json({
        success: false,
        code: "DEVICE_NOT_ACTIVE",
        message: "This device is not active. Contact Innovex support.",
      });
    }

    if (row.organization_status !== "active") {
      return res.status(403).json({
        success: false,
        code: "ORGANIZATION_INACTIVE",
        message: "This gym organization is inactive",
      });
    }

    if (!row.license_id) {
      return res.status(403).json({
        success: false,
        code: "LICENSE_NOT_FOUND",
        message: "No license found for this organization",
      });
    }

    if (row.license_status !== "active") {
      return res.status(403).json({
        success: false,
        code: "LICENSE_INACTIVE",
        message: "This organization's license is not active",
      });
    }

    if (Number(row.license_started) !== 1) {
      return res.status(403).json({
        success: false,
        code: "LICENSE_NOT_STARTED",
        message: "This organization's license has not started yet",
      });
    }

    if (Number(row.license_not_expired) !== 1) {
      return res.status(403).json({
        success: false,
        code: "LICENSE_EXPIRED",
        message: "This organization's license has expired",
      });
    }

    req.device = {
      id: row.device_id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      deviceUuid: row.device_uuid,
      deviceName: row.device_name,
      registeredBranchId:
        row.registered_branch_id == null
          ? null
          : Number(row.registered_branch_id),
      status: row.device_status,
    };

    return next();
  } catch (error) {
    console.error("Device authentication error:", error.message);

    return res.status(500).json({
      success: false,
      code: "DEVICE_VALIDATION_FAILED",
      message: "Unable to validate this device",
    });
  }
};

module.exports = {
  authenticateDevice,
};