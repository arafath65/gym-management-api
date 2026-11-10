const express = require("express");

const {
  createOrganization,
  getOrganizations,
  updateOrganization,
  setOrganizationStatus,
} = require("../controllers/organizationController");

const {
  authenticatePlatformAdmin,
} = require("../middleware/platformAdminMiddleware");

const router = express.Router();

router.use(authenticatePlatformAdmin);

router.get("/", getOrganizations);
router.post("/", createOrganization);

router.put("/:organizationId", updateOrganization);

router.patch(
  "/:organizationId/status",
  setOrganizationStatus
);

module.exports = router;
