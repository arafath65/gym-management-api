'use strict';

const express = require('express');

const {
  requireGymPermission,
} = require('../middleware/gymStaffAuthMiddleware');

const {
  listMemberMemberships,
  assignMemberMembership,
  updateMemberMembership,
  cancelMemberMembership,
  renewMemberMembership,
} = require('../controllers/memberMembershipController');

const router = express.Router({ mergeParams: true });

router.get(
  '/',
  requireGymPermission('member_memberships.view'),
  listMemberMemberships
);

router.post(
  '/',
  requireGymPermission('member_memberships.assign'),
  assignMemberMembership
);

router.patch(
  '/:membershipId',
  requireGymPermission('member_memberships.update'),
  updateMemberMembership
);

router.post(
  '/:membershipId/cancel',
  requireGymPermission('member_memberships.cancel'),
  cancelMemberMembership
);

router.post(
  '/:membershipId/renew',
  requireGymPermission('member_memberships.assign'),
  renewMemberMembership
);

module.exports = router;
