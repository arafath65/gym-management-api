const express = require("express");

const {
  loginPlatformAdmin,
} = require("../controllers/platformAdminController");

const {
  getPlatformDashboardStats,
} = require("../controllers/platformDashboardController");

const {
  authenticatePlatformAdmin,
} = require("../middleware/platformAdminMiddleware");

const { getPlatformAuditLogs } = require("../controllers/platformAuditController");

const router = express.Router();

// Public login
router.post("/login", loginPlatformAdmin);

// Protected dashboard statistics
router.get(
  "/dashboard-stats",
  authenticatePlatformAdmin,
  getPlatformDashboardStats
);

// Protected, read-only platform audit history.
router.get(
  "/audit-logs",
  authenticatePlatformAdmin,
  getPlatformAuditLogs
);
module.exports = router;
