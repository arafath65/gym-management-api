const express = require("express");

const {
  getBranches,
  createBranch,
} = require("../controllers/branchController");

const router = express.Router();

router.get("/:organizationId", getBranches);
router.post("/:organizationId", createBranch);

module.exports = router;