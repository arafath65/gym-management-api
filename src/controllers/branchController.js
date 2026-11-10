const db = require("../config/db");

const getBranches = async (req, res) => {
  try {
    const organizationId = Number(req.params.organizationId);

    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID",
      });
    }

    const [branches] = await db.query(
      `SELECT id, organization_id, name, branch_code, phone, address, status, created_at
       FROM branches
       WHERE organization_id = ?
       ORDER BY created_at DESC`,
      [organizationId]
    );

    return res.json({
      success: true,
      branches,
    });
  } catch (error) {
    console.error("Get branches error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve branches",
    });
  }
};

const createBranch = async (req, res) => {
  try {
    const organizationId = Number(req.params.organizationId);
    const { name, branch_code, phone, address } = req.body || {};

    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID",
      });
    }

    if (!name?.trim() || !branch_code?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Branch name and branch code are required",
      });
    }

    const [organizations] = await db.query(
      "SELECT id FROM organizations WHERE id = ?",
      [organizationId]
    );

    if (organizations.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    const normalizedCode = branch_code.trim().toUpperCase();

    const [existing] = await db.query(
      `SELECT id FROM branches
       WHERE organization_id = ? AND branch_code = ?`,
      [organizationId, normalizedCode]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Branch code already exists for this organization",
      });
    }

    const [result] = await db.query(
      `INSERT INTO branches
       (organization_id, name, branch_code, phone, address)
       VALUES (?, ?, ?, ?, ?)`,
      [
        organizationId,
        name.trim(),
        normalizedCode,
        phone || null,
        address || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Branch created successfully",
      branch: {
        id: result.insertId,
        organization_id: organizationId,
        name: name.trim(),
        branch_code: normalizedCode,
        phone: phone || null,
        address: address || null,
        status: "active",
      },
    });
  } catch (error) {
    console.error("Create branch error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create branch",
    });
  }
};

module.exports = {
  getBranches,
  createBranch,
};