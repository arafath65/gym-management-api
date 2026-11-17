'use strict';

const express = require('express');

const {
  authenticateDevice,
} = require('../middleware/deviceAuthMiddleware');

const {
  authenticateGymStaff,
  requireGymPermission,
} = require('../middleware/gymStaffAuthMiddleware');

const {
  searchMembers,
  createMember,
} = require('../controllers/memberController');

const router = express.Router();

router.use(authenticateDevice, authenticateGymStaff);

router.get(
  '/search',
  requireGymPermission('members.view'),
  searchMembers
);

router.post(
  '/',
  requireGymPermission('members.create'),
  createMember
);

module.exports = router;