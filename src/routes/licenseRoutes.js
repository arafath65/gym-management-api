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
} = require("../middleware/platformAdminMiddleware");

const router = express.Router();

// Every license-management endpoint is restricted to authenticated platform admins.
router.use(authenticatePlatformAdmin);

router.get("/", getLicenses);
router.get("/:licenseId", getLicenseById);
router.post("/", createLicense);
router.post("/:licenseId/renew", renewLicense);
router.patch("/:licenseId/status", updateLicenseStatus);

module.exports = router;
