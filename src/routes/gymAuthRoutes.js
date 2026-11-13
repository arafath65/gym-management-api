const express = require("express");

const {
  authenticateDevice,
} = require("../middleware/deviceAuthMiddleware");

const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");

const {
  loginGymStaff,
  selectGymStaffBranch,
  switchGymStaffBranch,
  getGymStaffMe,
} = require("../controllers/gymAuthController");

const router = express.Router();

router.post(
  "/login",
  authenticateDevice,
  loginGymStaff
);

router.post(
  "/select-branch",
  authenticateDevice,
  selectGymStaffBranch
);

router.post(
  "/switch-branch",
  authenticateDevice,
  authenticateGymStaff,
  requireGymPermission("branches.switch"),
  switchGymStaffBranch
);
router.get(
  "/me",
  authenticateDevice,
  authenticateGymStaff,
  getGymStaffMe
);

module.exports = router;