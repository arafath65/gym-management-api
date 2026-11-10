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

const router = express.Router();

// Public login
router.post("/login", loginPlatformAdmin);

// Protected dashboard statistics
router.get(
  "/dashboard-stats",
  authenticatePlatformAdmin,
  getPlatformDashboardStats
);

module.exports = router;
