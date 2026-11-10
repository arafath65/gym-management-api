
const express = require("express");

const {
  createOrganization,
  getOrganizations,
  updateOrganization,
  setOrganizationStatus,
} = require("../controllers/organizationController");

const {
  authenticatePlatformAdmin,
  requirePlatformPermission,
} = require("../middleware/platformAdminMiddleware");

const router = express.Router();

router.use(authenticatePlatformAdmin);

router.get(
  "/",
  requirePlatformPermission("organizations.view"),
  getOrganizations
);

router.post(
  "/",
  requirePlatformPermission("organizations.create"),
  createOrganization
);

router.put(
  "/:organizationId",
  requirePlatformPermission("organizations.update"),
  updateOrganization
);

router.patch(
  "/:organizationId/status",
  requirePlatformPermission("organizations.suspend"),
  setOrganizationStatus
);

module.exports = router;
