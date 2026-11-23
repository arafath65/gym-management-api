'use strict';

const express = require('express');

const {
  requireGymPermission,
} = require('../middleware/gymStaffAuthMiddleware');

const {
  getMemberBillingDashboard,
  getMemberBillingMonthlyCalendar,
  getMemberBillingYearlyDues,
} = require('../controllers/memberBillingDashboardController');

const {
  getCollectionsSummary,
  getProgramAssignmentReport,
} = require('../controllers/memberBillingCollectionsController');

const {
  searchBillingMembers,
} = require('../controllers/memberBillingMemberSearchController');

const requireBillingMemberSearchPermission = (req, res, next) => {
  const permissions = Array.isArray(req.gymStaff?.permissions)
    ? req.gymStaff.permissions
    : [];

  if (
    permissions.includes('member_billing.members.search') ||
    permissions.includes('member_billing.payments.receive')
  ) {
    return next();
  }

  return res.status(403).json({
    success: false,
    code: 'GYM_PERMISSION_DENIED',
    message: 'You do not have permission to search billing members.',
    required_permissions: [
      'member_billing.members.search',
      'member_billing.payments.receive',
    ],
  });
};

const router = express.Router();

router.get(
  '/program-assignments',
  requireGymPermission('member_billing.reports.view'),
  requireGymPermission('member_programs.view'),
  requireGymPermission('member_program_billing.invoices.view'),
  requireGymPermission('member_program_billing.payments.view'),
  getProgramAssignmentReport
);

router.get(
  '/member-search',
  requireBillingMemberSearchPermission,
  searchBillingMembers
);

router.get(
  '/collections-summary',
  requireGymPermission('member_billing.dashboard.view'),
  getCollectionsSummary
);

router.get(
  '/dashboard',
  requireGymPermission('member_billing.dashboard.view'),
  getMemberBillingDashboard
);

router.get(
  '/calendar/monthly',
  requireGymPermission('member_billing.monthly_calendar.view'),
  getMemberBillingMonthlyCalendar
);

router.get(
  '/dues/yearly',
  requireGymPermission('member_billing.yearly_dues.view'),
  getMemberBillingYearlyDues
);

module.exports = router;