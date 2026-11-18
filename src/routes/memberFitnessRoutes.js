'use strict';

const express = require('express');
const multer = require('multer');

const { requireGymPermission } = require('../middleware/gymStaffAuthMiddleware');
const {
  MAX_UPLOAD_BYTES,
} = require('../services/storage/memberProgressPhotoProcessor');

const {
  listAssessments,
  getAssessment,
  createAssessment,
  updateAssessment,
  deleteAssessment,
  listAssessmentPhotos,
  getAssessmentPhoto,
  uploadAssessmentPhoto,
  deleteAssessmentPhoto,
} = require('../controllers/memberFitnessController');

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 0,
    parts: 1,
  },
  fileFilter: (req, file, callback) => {
    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);

    if (!allowedMimeTypes.has(file.mimetype)) {
      const error = new Error('Only JPEG, PNG and WebP images are supported.');
      error.statusCode = 400;
      return callback(error);
    }

    return callback(null, true);
  },
});

const parseAssessmentPhoto = (req, res, next) => {
  photoUpload.single('photo')(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        success: false,
        code: error.code,
        message: tooLarge
          ? 'Assessment photo must not exceed 8 MB.'
          : 'Invalid assessment photo upload.',
      });
    }

    return res.status(error.statusCode || 400).json({
      success: false,
      code: 'INVALID_MEMBER_FITNESS_PHOTO_UPLOAD',
      message: error.message || 'Invalid assessment photo upload.',
    });
  });
};

// Parent memberRoutes mounts this router at /:memberId/fitness and already
// enforces device authentication plus Gym Staff authentication.
const router = express.Router({ mergeParams: true });

router.get(
  '/',
  requireGymPermission('member_fitness.view'),
  listAssessments
);

router.post(
  '/',
  requireGymPermission('member_fitness.create'),
  createAssessment
);

router.get(
  '/:progressId',
  requireGymPermission('member_fitness.view'),
  getAssessment
);

router.patch(
  '/:progressId',
  requireGymPermission('member_fitness.update'),
  updateAssessment
);

// Deleting an assessment also removes its three linked photo records/files.
router.delete(
  '/:progressId',
  requireGymPermission('member_fitness.delete'),
  deleteAssessment
);

router.get(
  '/:progressId/photos',
  requireGymPermission('member_fitness.photos.view'),
  listAssessmentPhotos
);

router.get(
  '/:progressId/photos/:photoType',
  requireGymPermission('member_fitness.photos.view'),
  getAssessmentPhoto
);

router.post(
  '/:progressId/photos/:photoType',
  requireGymPermission('member_fitness.photos.manage'),
  parseAssessmentPhoto,
  uploadAssessmentPhoto
);

router.delete(
  '/:progressId/photos/:photoType',
  requireGymPermission('member_fitness.photos.manage'),
  deleteAssessmentPhoto
);

module.exports = router;