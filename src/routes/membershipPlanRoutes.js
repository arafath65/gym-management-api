const express = require("express");

const {
  authenticateDevice,
} = require("../middleware/deviceAuthMiddleware");

const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");

const {
  getMembershipPlans,
  getMembershipPlan,
  createMembershipPlan,
  updateMembershipPlan,
  deactivateMembershipPlan,
  reactivateMembershipPlan,
} = require("../controllers/membershipPlanController");

const router = express.Router();

// All membership-plan endpoints require a valid organization device
// and a valid Gym Staff session.
router.use(authenticateDevice, authenticateGymStaff);

router.get(
  "/",
  requireGymPermission("membership_plans.view"),
  getMembershipPlans
);

router.get(
  "/:planId",
  requireGymPermission("membership_plans.view"),
  getMembershipPlan
);

router.post(
  "/",
  requireGymPermission("membership_plans.create"),
  createMembershipPlan
);

router.patch(
  "/:planId",
  requireGymPermission("membership_plans.update"),
  updateMembershipPlan
);

router.post(
  "/:planId/deactivate",
  requireGymPermission("membership_plans.deactivate"),
  deactivateMembershipPlan
);

router.post(
  "/:planId/reactivate",
  requireGymPermission("membership_plans.update"),
  reactivateMembershipPlan
);

module.exports = router;