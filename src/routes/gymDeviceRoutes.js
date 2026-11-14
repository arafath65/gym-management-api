const express = require("express");
const { authenticateDevice } = require("../middleware/deviceAuthMiddleware");
const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");
const {
  listGymDevices,
  getDeviceBranchTransferHistory,
  transferDeviceBranch,
} = require("../controllers/gymDeviceController");

const router = express.Router();

// Tenant-side device assignment. Platform Admin registration remains under /api/devices.
router.use(authenticateDevice, authenticateGymStaff);

router.get("/", requireGymPermission("devices.view"), listGymDevices);
router.get(
  "/:deviceId/history",
  requireGymPermission("devices.view"),
  getDeviceBranchTransferHistory
);
router.post(
  "/:deviceId/transfer",
  requireGymPermission("devices.transfer"),
  transferDeviceBranch
);

module.exports = router;