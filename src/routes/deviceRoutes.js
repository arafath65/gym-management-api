
const express = require("express");
const db = require("../config/db");
const {
  readGymProfileLogo,
} = require("../services/storage/gymProfileLogoStorage");

const {
  activateDevice,
} = require("../controllers/deviceController");

const {
  authenticateDevice,
} = require("../middleware/deviceAuthMiddleware");

const {
  getDevices,
  registerDevice,
  regenerateDeviceActivationCode,
  revokeDevice,
} = require("../controllers/deviceManagementController");


const {
  authenticatePlatformAdmin,
  requirePlatformPermission,
} = require("../middleware/platformAdminMiddleware");

const router = express.Router();

// Gym App device activation.
// This is not a Platform Admin operation.
router.post(
  "/activate",
  activateDevice
);

// Validate an already activated Gym App device at app startup.
// This route uses the device token, not Platform Admin authentication.
router.get("/validate", authenticateDevice, (req, res) => {
  return res.json({
    success: true,
    message: "Device is valid",
    organization: {
      id: req.device.organizationId,
      name: req.device.organizationName,
    },
    device: {
      id: req.device.id,
      organization_id: req.device.organizationId,
      device_uuid: req.device.deviceUuid,
      device_name: req.device.deviceName,
      status: req.device.status,
    },
  });
});


// Get organization branding using the activated device token.
router.get("/branding", authenticateDevice, async (req, res) => {
  try {
    const organizationId = Number(req.device.organizationId);

    const [rows] = await db.query(
      `SELECT id, name, logo_storage_key
       FROM organizations
       WHERE id = ?
       LIMIT 1`,
      [organizationId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Gym organization was not found.",
      });
    }

    const organization = rows[0];

    res.set("Cache-Control", "private, no-store");

    return res.json({
      success: true,
      organization: {
        id: Number(organization.id),
        name: organization.name || req.device.organizationName || "",
        hasLogo: Boolean(organization.logo_storage_key),
      },
    });
  } catch (error) {
    console.error("Get device branding error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load organization branding.",
    });
  }
});

// Retrieve the organization's private logo using the device token.
router.get("/branding/logo", authenticateDevice, async (req, res) => {
  try {
    const organizationId = Number(req.device.organizationId);

    const [rows] = await db.query(
      `SELECT logo_storage_key
       FROM organizations
       WHERE id = ?
       LIMIT 1`,
      [organizationId]
    );

    if (!rows.length || !rows[0].logo_storage_key) {
      return res.status(404).json({
        success: false,
        message: "Gym logo has not been uploaded.",
      });
    }

    const imageBuffer = await readGymProfileLogo(
      organizationId,
      rows[0].logo_storage_key
    );

    res.set("Content-Type", "image/webp");
    res.set("Content-Length", String(imageBuffer.length));
    res.set("Content-Disposition", "inline");
    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");

    return res.send(imageBuffer);
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({
        success: false,
        message: "Gym logo file was not found.",
      });
    }

    console.error("Get device branding logo error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve organization logo.",
    });
  }
});
// All device management operations below require Platform Admin.
router.use(authenticatePlatformAdmin);

router.get(
  "/",
  requirePlatformPermission("devices.view"),
  getDevices
);

router.post(
  "/register",
  requirePlatformPermission("devices.register"),
  registerDevice
);

router.post(
  "/:deviceId/activation-code",
  requirePlatformPermission("devices.activation_code.regenerate"),
  regenerateDeviceActivationCode
);

router.patch(
  "/:deviceId/revoke",
  requirePlatformPermission("devices.revoke"),
  revokeDevice
);

module.exports = router;
