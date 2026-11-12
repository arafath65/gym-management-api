
const express = require("express");

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
