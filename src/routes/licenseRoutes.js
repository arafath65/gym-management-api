
const express = require("express");

const {
  getLicenses,
  getLicenseById,
  createLicense,
  renewLicense,
  updateLicenseStatus,
} = require("../controllers/licenseManagementController");

const {
  authenticatePlatformAdmin,
  requirePlatformPermission,
} = require("../middleware/platformAdminMiddleware");

const router = express.Router();

router.use(authenticatePlatformAdmin);

router.get(
  "/",
  requirePlatformPermission("licenses.view"),
  getLicenses
);

router.get(
  "/:licenseId",
  requirePlatformPermission("licenses.view"),
  getLicenseById
);

router.post(
  "/",
  requirePlatformPermission("licenses.create"),
  createLicense
);

router.post(
  "/:licenseId/renew",
  requirePlatformPermission("licenses.renew"),
  renewLicense
);

// Select permission according to requested status.
router.patch(
  "/:licenseId/status",
  requirePlatformPermission((req) =>
    req.body?.status === "active"
      ? "licenses.activate"
      : "licenses.suspend"
  ),
  updateLicenseStatus
);

module.exports = router;
