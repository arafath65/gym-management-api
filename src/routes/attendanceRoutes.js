'use strict';

const express = require('express');
const { authenticateDevice } = require('../middleware/deviceAuthMiddleware');
const { authenticateGymStaff, requireGymPermission } = require('../middleware/gymStaffAuthMiddleware');
const {
  searchAttendanceMembers,
  listTodayAttendance,
  checkInMember,
  checkOutMember,
  getMemberAttendanceSummary,
} = require('../controllers/memberAttendanceController');

const router = express.Router();
router.use(authenticateDevice, authenticateGymStaff);

router.get('/member-summary', requireGymPermission('members.view'), getMemberAttendanceSummary);
router.get('/members', requireGymPermission('attendance.check_in'), searchAttendanceMembers);
router.get('/today', requireGymPermission('attendance.view'), listTodayAttendance);
router.post('/check-in', requireGymPermission('attendance.check_in'), checkInMember);
router.post('/check-out', requireGymPermission('attendance.check_in'), checkOutMember);

module.exports = router;
