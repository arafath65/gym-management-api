'use strict';

const express = require('express');
const multer = require('multer');

const {
  authenticateDevice,
} = require('../middleware/deviceAuthMiddleware');

const {
  authenticateGymStaff,
  requireGymPermission,
} = require('../middleware/gymStaffAuthMiddleware');

const {
  getGymProfile,
  updateGymProfile,
  getGymProfileLogo,
  uploadGymProfileLogo,
  removeGymProfileLogo,
} = require('../controllers/gymProfileController');

const {
  MAX_UPLOAD_BYTES,
} = require('../services/storage/gymProfileLogoProcessor');

const router = express.Router();

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
  fileFilter: (req, file, callback) => {
    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);

    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(
        new Error('Only JPEG, PNG and WebP logo images are supported.')
      );
    }

    return callback(null, true);
  },
});

const parseLogoUpload = (req, res, next) => {
  logoUpload.single('logo')(req, res, (error) => {
    if (!error) return next();

    if (
      error instanceof multer.MulterError &&
      error.code === 'LIMIT_FILE_SIZE'
    ) {
      return res.status(413).json({
        success: false,
        message: 'Gym logo must not exceed 3 MB.',
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message || 'Invalid logo upload.',
    });
  });
};

// All endpoints require an authenticated organization device and Gym Staff session.
router.use(authenticateDevice, authenticateGymStaff);

router.get(
  '/',
  requireGymPermission('gym_profile.view'),
  getGymProfile
);

router.put(
  '/',
  requireGymPermission('gym_profile.update'),
  updateGymProfile
);

router.get(
  '/logo',
  requireGymPermission('gym_profile.view'),
  getGymProfileLogo
);

router.post(
  '/logo',
  requireGymPermission('gym_profile.update'),
  parseLogoUpload,
  uploadGymProfileLogo
);

router.delete(
  '/logo',
  requireGymPermission('gym_profile.update'),
  removeGymProfileLogo
);

module.exports = router;
