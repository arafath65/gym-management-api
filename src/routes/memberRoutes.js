'use strict';

const express = require('express');

const memberFitnessRoutes = require('./memberFitnessRoutes');
const memberProgramRoutes = require('./memberProgramRoutes');
const memberMembershipRoutes = require('./memberMembershipRoutes');
const memberBillingRoutes = require('./memberBillingRoutes');
const memberBillingAccountRoutes = require('./memberBillingAccountRoutes');

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

const { listMembers } = require('../controllers/memberListController');
const {
  getMember,
  updateMember,
  deactivateMember,
  reactivateMember,
  getMemberPhoto,
  uploadMemberPhoto,
} = require('../controllers/memberProfileController');

const multer = require('multer');
const { MAX_UPLOAD_BYTES } = require('../services/storage/memberPhotoProcessor');

const memberPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
  fileFilter: (req, file, callback) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(file.mimetype)) {
      const error = new Error('Only JPEG, PNG and WebP images are supported.');
      error.statusCode = 400;
      return callback(error);
    }
    return callback(null, true);
  },
});

const parseMemberPhoto = (req, res, next) => {
  memberPhotoUpload.single('photo')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        success: false,
        code: error.code,
        message: tooLarge ? 'Member photo must not exceed 2 MB.' : 'Invalid member photo upload.',
      });
    }
    return res.status(error.statusCode || 400).json({
      success: false,
      code: 'INVALID_MEMBER_PHOTO_UPLOAD',
      message: error.message || 'Invalid member photo upload.',
    });
  });
};

const router = express.Router();

router.use(authenticateDevice, authenticateGymStaff);
router.use('/billing', memberBillingRoutes);
router.get(
  '/',
  requireGymPermission('members.view'),
  listMembers
);

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

// Member profile access is organization-wide; registration branch is retained for reporting.
router.get(
  '/:memberId/photo',
  requireGymPermission('members.view'),
  getMemberPhoto
);

router.post(
  '/:memberId/photo',
  requireGymPermission('members.update'),
  parseMemberPhoto,
  uploadMemberPhoto
);

router.get(
  '/:memberId',
  requireGymPermission('members.view'),
  getMember
);

router.patch(
  '/:memberId',
  requireGymPermission('members.update'),
  updateMember
);

router.post(
  '/:memberId/deactivate',
  requireGymPermission('members.deactivate'),
  deactivateMember
);

router.post(
  '/:memberId/reactivate',
  requireGymPermission('members.deactivate'),
  reactivateMember
);

router.use('/:memberId/fitness', memberFitnessRoutes);
router.use('/:memberId/programs', memberProgramRoutes);
router.use('/:memberId/memberships', memberMembershipRoutes);
router.use('/:memberId/billing', memberBillingAccountRoutes);

module.exports = router;
