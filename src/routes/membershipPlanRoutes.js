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

const requireAnyGymPermission = (...permissionKeys) => (req, res, next) => {
  const permissions = req.gymStaff?.permissions || [];
  const matched = permissionKeys.find((key) => permissions.includes(key));
  if (!matched) {
    return res.status(403).json({
      success: false,
      code: 'GYM_PERMISSION_DENIED',
      message: 'You do not have permission to manage plans or programs.',
      required_permissions: permissionKeys,
    });
  }
  req.matchedGymPermission = matched;
  return next();
};


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
  requireAnyGymPermission("membership_plans.view", "fitness_programs.view"),
  getMembershipPlans
);

router.get(
  "/:planId",
  requireAnyGymPermission("membership_plans.view", "fitness_programs.view"),
  getMembershipPlan
);

router.post(
  "/",
  requireAnyGymPermission("membership_plans.create", "fitness_programs.create"),
  createMembershipPlan
);

router.patch(
  "/:planId",
  requireAnyGymPermission("membership_plans.update", "fitness_programs.update"),
  updateMembershipPlan
);

router.post(
  "/:planId/deactivate",
  requireAnyGymPermission("membership_plans.deactivate", "fitness_programs.deactivate"),
  deactivateMembershipPlan
);

router.post(
  "/:planId/reactivate",
  requireAnyGymPermission("membership_plans.update", "fitness_programs.update"),
  reactivateMembershipPlan
);

module.exports = router;