'use strict';

const express = require('express');

const {
  requireGymPermission,
} = require('../middleware/gymStaffAuthMiddleware');

const {
  listAvailableUnifiedPrograms,
  listMemberProgramAssignments,
  assignFitnessProgramToMember,
  pauseMemberProgramAssignment,
  getMemberProgramResumePreview,
  resumeMemberProgramAssignment,
  completeMemberProgramAssignment,
  cancelMemberProgramAssignment,
  listMemberProgramPauseHistory,
} = require('../controllers/memberProgramController');

// Parent memberRoutes already enforces device authentication
// and Gym Staff authentication.
const router = express.Router({ mergeParams: true });

router.get(
  '/catalog',
  requireGymPermission('fitness_programs.view'),
  listAvailableUnifiedPrograms
);

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

router.post(
  '/:assignmentId/pause',
  requireGymPermission('member_programs.pause'),
  pauseMemberProgramAssignment
);

router.get(
  '/:assignmentId/resume-preview',
  requireGymPermission('member_programs.resume'),
  getMemberProgramResumePreview
);

router.post(
  '/:assignmentId/resume',
  requireGymPermission('member_programs.resume'),
  resumeMemberProgramAssignment
);

router.post(
  '/:assignmentId/complete',
  requireGymPermission('member_programs.complete'),
  completeMemberProgramAssignment
);

router.post(
  '/:assignmentId/cancel',
  requireGymPermission('member_programs.cancel'),
  cancelMemberProgramAssignment
);

router.get(
  '/:assignmentId/pause-history',
  requireGymPermission('member_programs.pause_history.view'),
  listMemberProgramPauseHistory
);

module.exports = router;