const express = require("express");

const {
  getBranches,
  createBranch,
  updateBranch,
  setBranchStatus,
} = require("../controllers/branchController");

const {
  authenticatePlatformAdmin,
  requirePlatformPermission,
} = require("../middleware/platformAdminMiddleware");

const router = express.Router();

router.use(authenticatePlatformAdmin);

router.get(
  "/:organizationId",
  requirePlatformPermission("branches.view"),
  getBranches
);

router.post(
  "/:organizationId",
  requirePlatformPermission("branches.create"),
  createBranch
);

router.patch(
  "/:organizationId/:branchId",
  requirePlatformPermission("branches.update"),
  updateBranch
);

// Status changes are treated as branch updates.
// Physical deletion is deliberately not implemented.
router.patch(
  "/:organizationId/:branchId/status",
  requirePlatformPermission("branches.update"),
  setBranchStatus
);

module.exports = router;
