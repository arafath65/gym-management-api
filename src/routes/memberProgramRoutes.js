'use strict';

const express = require('express');

const {
  requireGymPermission,
} = require('../middleware/gymStaffAuthMiddleware');

const {
  listMemberProgramAssignments,
  assignFitnessProgramToMember,
  updateMemberProgramAssignmentStatus,
} = require('../controllers/memberProgramController');

// Parent memberRoutes already enforces device authentication
// and Gym Staff authentication.
const router = express.Router({ mergeParams: true });

router.get(
  '/',
  requireGymPermission('member_programs.view'),
  listMemberProgramAssignments
);

router.post(
  '/',
  requireGymPermission('member_programs.assign'),
  assignFitnessProgramToMember
);

router.patch(
  '/:assignmentId/status',
  requireGymPermission('member_programs.update'),
  updateMemberProgramAssignmentStatus
);

module.exports = router;