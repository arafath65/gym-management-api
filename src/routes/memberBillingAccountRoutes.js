'use strict';

const express = require('express');

const {
  requireGymPermission,
} = require('../middleware/gymStaffAuthMiddleware');

const {
  getMemberBillingAccount,
} = require('../controllers/memberBillingAccountController');

const router = express.Router({ mergeParams: true });

router.get(
  '/account',
  requireGymPermission('member_billing.member_account.view'),
  getMemberBillingAccount
);

module.exports = router;