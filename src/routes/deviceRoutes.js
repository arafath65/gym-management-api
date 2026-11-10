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
} = require("../middleware/platformAdminMiddleware");

const router = express.Router();

// Gym application device activation (existing endpoint).
router.post(
  "/activate",
  checkOrganizationLicense,
  activateDevice
);

// Protected Super Admin device management.
router.get(
  "/",
  authenticatePlatformAdmin,
  getDevices
);

router.post(
  "/register",
  authenticatePlatformAdmin,
  registerDevice
);

router.post(
  "/:deviceId/activation-code",
  authenticatePlatformAdmin,
  regenerateDeviceActivationCode
);

router.patch(
  "/:deviceId/revoke",
  authenticatePlatformAdmin,
  revokeDevice
);

module.exports = router;
