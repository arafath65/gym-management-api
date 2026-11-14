const express = require("express");

const { authenticateDevice } = require("../middleware/deviceAuthMiddleware");
const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");

const {
  listGymPermissions,
  listGymRoles,
  getGymRole,
  createGymRole,
  updateGymRole,
  deleteGymRole,
} = require("../controllers/gymRoleController");

const router = express.Router();

router.use(authenticateDevice, authenticateGymStaff);

router.get(
  "/permissions",
  requireGymPermission("roles.view"),
  listGymPermissions
);

router.get(
  "/",
  requireGymPermission("roles.view"),
  listGymRoles
);

router.get(
  "/:roleId",
  requireGymPermission("roles.view"),
  getGymRole
);

router.post(
  "/",
  requireGymPermission("roles.create"),
  createGymRole
);

router.patch(
  "/:roleId",
  requireGymPermission("roles.update"),
  updateGymRole
);

router.delete(
  "/:roleId",
  requireGymPermission("roles.delete"),
  deleteGymRole
);

module.exports = router;
