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

const {
  getMembershipPlanCollections,
} = require("../controllers/memberBillingCollectionsController");

const router = express.Router();

router.use(authenticateDevice, authenticateGymStaff);

// Static route must be before /:planId.
router.get(
  "/collections",
  requireGymPermission("membership_plans.view"),
  requireGymPermission("member_billing.dashboard.view"),
  requireGymPermission("member_billing.reports.view"),
  getMembershipPlanCollections
);

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