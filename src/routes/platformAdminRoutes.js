
const express = require("express");

const {
  loginPlatformAdmin,
} = require("../controllers/platformAdminController");

const {
  getPlatformDashboardStats,
} = require("../controllers/platformDashboardController");

const {
  authenticatePlatformAdmin,
  requirePlatformPermission,
} = require("../middleware/platformAdminMiddleware");

const {
  getPlatformAuditLogs,
} = require("../controllers/platformAuditController");

const router = express.Router();

// Public login.
router.post("/login", loginPlatformAdmin);

// All routes below require Platform Admin authentication.
router.use(authenticatePlatformAdmin);

router.get(
  "/dashboard-stats",
  requirePlatformPermission("dashboard.view"),
  getPlatformDashboardStats
);

router.get(
  "/audit-logs",
  requirePlatformPermission("audit_logs.view"),
  getPlatformAuditLogs
);

module.exports = router;
