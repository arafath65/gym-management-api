"use strict";

const express = require("express");

const {
  authenticateDevice,
} = require("../middleware/deviceAuthMiddleware");

const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");

const {
  getDashboardSummary,
  setMembershipTarget,
} = require("../controllers/dashboardController");

const router = express.Router();

router.use(authenticateDevice, authenticateGymStaff);

// Dashboard summary access is authenticated, while each metric is
// independently permission-checked inside the controller.
router.get("/summary", getDashboardSummary);

router.put(
  "/membership-target",
  requireGymPermission("dashboard.membership_target.manage"),
  setMembershipTarget
);

module.exports = router;