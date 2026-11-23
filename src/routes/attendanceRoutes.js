'use strict';

const express = require('express');
const { authenticateDevice } = require('../middleware/deviceAuthMiddleware');
const { authenticateGymStaff, requireGymPermission } = require('../middleware/gymStaffAuthMiddleware');
const {
  searchAttendanceMembers,
  listTodayAttendance,
  checkInMember,
} = require('../controllers/memberAttendanceController');

const router = express.Router();
router.use(authenticateDevice, authenticateGymStaff);

router.get('/members', requireGymPermission('attendance.check_in'), searchAttendanceMembers);
router.get('/today', requireGymPermission('attendance.view'), listTodayAttendance);
router.post('/check-in', requireGymPermission('attendance.check_in'), checkInMember);

module.exports = router;
