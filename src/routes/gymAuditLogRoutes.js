const express = require("express");
const { authenticateDevice } = require("../middleware/deviceAuthMiddleware");
const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");
const { getGymAuditLogs } = require("../controllers/gymAuditLogController");

const router = express.Router();

router.use(authenticateDevice, authenticateGymStaff);
router.get("/", requireGymPermission("audit_logs.view"), getGymAuditLogs);

module.exports = router;