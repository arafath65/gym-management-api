const express = require("express");

const { authenticateDevice } = require("../middleware/deviceAuthMiddleware");
const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");

const {
  listGymStaff,
  getGymStaff,
  createGymStaff,
  updateGymStaff,
  updateGymStaffAssignments,
  setGymStaffStatus,
} = require("../controllers/gymStaffController");

const router = express.Router();

router.use(authenticateDevice, authenticateGymStaff);

router.get(
  "/",
  requireGymPermission("users.view"),
  listGymStaff
);

router.get(
  "/:staffId",
  requireGymPermission("users.view"),
  getGymStaff
);

router.post(
  "/",
  requireGymPermission("users.create"),
  requireGymPermission("roles.assign"),
  createGymStaff
);

router.patch(
  "/:staffId",
  requireGymPermission("users.update"),
  updateGymStaff
);

router.put(
  "/:staffId/assignments",
  requireGymPermission("users.update"),
  requireGymPermission("roles.assign"),
  updateGymStaffAssignments
);

router.patch(
  "/:staffId/status",
  requireGymPermission("users.deactivate"),
  setGymStaffStatus
);

module.exports = router;