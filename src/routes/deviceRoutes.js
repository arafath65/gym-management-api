
const express = require("express");

const {
  activateDevice,
} = require("../controllers/deviceController");

const {
  getDevices,
  registerDevice,
  regenerateDeviceActivationCode,
  revokeDevice,
} = require("../controllers/deviceManagementController");

const {
  checkOrganizationLicense,
} = require("../middleware/licenseMiddleware");

const {
  authenticatePlatformAdmin,
  requirePlatformPermission,
} = require("../middleware/platformAdminMiddleware");

const router = express.Router();

// Gym App device activation.
// This is not a Platform Admin operation.
router.post(
  "/activate",
  checkOrganizationLicense,
  activateDevice
);

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
