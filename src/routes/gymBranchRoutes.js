const express = require("express");
const { authenticateDevice } = require("../middleware/deviceAuthMiddleware");
const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");
const {
  listBranches,
  createBranch,
  updateBranch,
  setBranchStatus,
} = require("../controllers/gymBranchController");

const router = express.Router();

// Tenant-side branch management. This router is separate from Platform Admin /api/branches.
router.use(authenticateDevice, authenticateGymStaff);

router.get("/", requireGymPermission("branches.view"), listBranches);
router.post("/", requireGymPermission("branches.create"), createBranch);
router.patch("/:branchId", requireGymPermission("branches.update"), updateBranch);
router.patch(
  "/:branchId/status",
  requireGymPermission("branches.update"),
  setBranchStatus
);

module.exports = router;