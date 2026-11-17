const express = require("express");
const multer = require("multer");

const { MAX_UPLOAD_BYTES } = require(
  "../services/storage/trainerPhotoProcessor"
);

const { authenticateDevice } = require("../middleware/deviceAuthMiddleware");

const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");

const {
  getTrainers,
  getTrainer,
  getTrainerPhoto,
  uploadTrainerPhoto,
  removeTrainerPhoto,
  createTrainer,
  updateTrainer,
  deactivateTrainer,
  reactivateTrainer,
  getTrainerBranches,
  assignTrainerBranch,
  removeTrainerBranch,
} = require("../controllers/trainerController");

// Uploaded originals remain in memory until Sharp validates and converts them.
const trainerPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
  fileFilter: (req, file, callback) => {
    const allowedMimeTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    if (!allowedMimeTypes.has(file.mimetype)) {
      const error = new Error("Only JPEG, PNG and WebP images are supported.");
      error.statusCode = 400;
      return callback(error);
    }
    return callback(null, true);
  },
});

const parseTrainerPhoto = (req, res, next) => {
  trainerPhotoUpload.single("photo")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        success: false,
        code: error.code,
        message: tooLarge ? "Trainer photo must not exceed 2 MB." : "Invalid trainer photo upload.",
      });
    }
    return res.status(error.statusCode || 400).json({
      success: false,
      code: "INVALID_TRAINER_PHOTO_UPLOAD",
      message: error.message || "Invalid trainer photo upload.",
    });
  });
};

const router = express.Router();

// Every Trainer request requires an authenticated device
// and a valid Gym Staff session.
router.use(authenticateDevice, authenticateGymStaff);

// Trainer profile photos
router.get("/:trainerId/photo",
  requireGymPermission("trainers.view"),
  getTrainerPhoto
);

router.post("/:trainerId/photo",
  requireGymPermission("trainers.update"),
  parseTrainerPhoto,
  uploadTrainerPhoto
);

router.delete("/:trainerId/photo",
  requireGymPermission("trainers.update"),
  removeTrainerPhoto
);

// Trainer profiles
router.get(
  "/",
  requireGymPermission("trainers.view"),
  getTrainers
);

router.get(
  "/:trainerId",
  requireGymPermission("trainers.view"),
  getTrainer
);

router.post(
  "/",
  requireGymPermission("trainers.create"),
  createTrainer
);

router.patch(
  "/:trainerId",
  requireGymPermission("trainers.update"),
  updateTrainer
);

router.post(
  "/:trainerId/deactivate",
  requireGymPermission("trainers.deactivate"),
  deactivateTrainer
);

router.post(
  "/:trainerId/reactivate",
  requireGymPermission("trainers.update"),
  reactivateTrainer
);

// Trainer branch assignments
router.get(
  "/:trainerId/branches",
  requireGymPermission("trainers.view"),
  getTrainerBranches
);

router.post(
  "/:trainerId/branches",
  requireGymPermission("trainers.assign_branches"),
  assignTrainerBranch
);

router.post(
  "/:trainerId/branches/:branchId/remove",
  requireGymPermission("trainers.assign_branches"),
  removeTrainerBranch
);

module.exports = router;