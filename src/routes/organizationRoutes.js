
const express = require("express");

const {
  getOrganizationGymOwner,
  resetOrganizationGymOwnerPassword,
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

router.get(
  "/:organizationId/gym-owner",
  requirePlatformPermission("organizations.view"),
  getOrganizationGymOwner
);

router.patch(
  "/:organizationId/gym-owner/reset-password",
  requirePlatformPermission("organizations.update"),
  resetOrganizationGymOwnerPassword
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
