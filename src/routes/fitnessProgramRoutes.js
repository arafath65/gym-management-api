const express = require("express");
const { authenticateDevice } = require("../middleware/deviceAuthMiddleware");
const {
  authenticateGymStaff,
  requireGymPermission,
} = require("../middleware/gymStaffAuthMiddleware");
const {
  getFitnessPrograms,
  getFitnessProgram,
  createFitnessProgram,
  updateFitnessProgram,
  deactivateFitnessProgram,
  reactivateFitnessProgram,
} = require("../controllers/fitnessProgramController");

const router = express.Router();

// Every Program request is scoped to an authenticated organization device and Gym Staff session.
router.use(authenticateDevice, authenticateGymStaff);

router.get("/", requireGymPermission("fitness_programs.view"), getFitnessPrograms);
router.get("/:programId", requireGymPermission("fitness_programs.view"), getFitnessProgram);
router.post("/", requireGymPermission("fitness_programs.create"), createFitnessProgram);
router.patch("/:programId", requireGymPermission("fitness_programs.update"), updateFitnessProgram);
router.post("/:programId/deactivate", requireGymPermission("fitness_programs.deactivate"), deactivateFitnessProgram);
router.post("/:programId/reactivate", requireGymPermission("fitness_programs.update"), reactivateFitnessProgram);

module.exports = router;