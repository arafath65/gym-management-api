const db = require("../config/db");
const {
  writePlatformAuditLog,
} = require("../services/platformAuditService");

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const getBranches = async (req, res) => {
  try {
    const organizationId = parsePositiveId(req.params.organizationId);

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID",
      });
    }

    const [organizations] = await db.query(
      "SELECT id FROM organizations WHERE id = ? LIMIT 1",
      [organizationId]
    );

    if (organizations.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    const [branches] = await db.query(
      `SELECT id, organization_id, name, branch_code,
              phone, address, status, created_at, updated_at
       FROM branches
       WHERE organization_id = ?
       ORDER BY created_at DESC, id DESC`,
      [organizationId]
    );

    return res.json({ success: true, branches });
  } catch (error) {
    console.error("Get branches error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve branches",
    });
  }
};

const createBranch = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = parsePositiveId(req.params.organizationId);
    const { name, branch_code, phone = null, address = null } =
      req.body || {};

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID",
      });
    }

    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 150
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid branch name is required (maximum 150 characters)",
      });
    }

    if (
      typeof branch_code !== "string" ||
      !branch_code.trim() ||
      branch_code.trim().length > 50
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid branch code is required (maximum 50 characters)",
      });
    }

    if (
      phone !== null &&
      phone !== "" &&
      (typeof phone !== "string" || phone.trim().length > 30)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch phone number",
      });
    }

    if (
      address !== null &&
      address !== "" &&
      typeof address !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch address",
      });
    }

    const normalizedName = name.trim();
    const normalizedCode = branch_code.trim().toUpperCase();
    const normalizedPhone = phone ? phone.trim() : null;
    const normalizedAddress = address ? address.trim() : null;

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [organizations] = await connection.query(
      `SELECT id, name, status
       FROM organizations
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId]
    );

    if (organizations.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    const organization = organizations[0];

    if (organization.status !== "active") {
      await connection.rollback();
      transactionStarted = false;
      return res.status(403).json({
        success: false,
        message: "Cannot create a branch for an inactive organization",
      });
    }

    const [existing] = await connection.query(
      `SELECT id FROM branches
       WHERE organization_id = ? AND branch_code = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId, normalizedCode]
    );

    if (existing.length > 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({
        success: false,
        message: "Branch code already exists for this organization",
      });
    }

    const [result] = await connection.query(
      `INSERT INTO branches
       (organization_id, name, branch_code, phone, address, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [
        organizationId,
        normalizedName,
        normalizedCode,
        normalizedPhone,
        normalizedAddress,
      ]
    );

    const branchId = result.insertId;

    // Automatically grant the initial organization-scoped Gym Admin role
    // access to this branch. This is part of the same transaction as branch
    // creation, so the branch cannot be created without its access grant when
    // an eligible Gym Admin exists.
    const [gymAdminUsers] = await connection.query(
      `SELECT DISTINCT u.id
       FROM users u
       INNER JOIN user_roles ur
         ON ur.organization_id = u.organization_id
        AND ur.user_id = u.id
       INNER JOIN roles r
         ON r.organization_id = ur.organization_id
        AND r.id = ur.role_id
       WHERE u.organization_id = ?
         AND u.status = 'active'
         AND r.name = 'Gym Admin'
         AND r.is_system_role = 1
       ORDER BY u.id`,
      [organizationId]
    );

    for (const gymAdmin of gymAdminUsers) {
      await connection.query(
        `INSERT INTO user_branch_access
         (organization_id, user_id, branch_id)
         VALUES (?, ?, ?)`,
        [organizationId, gymAdmin.id, branchId]
      );
    }

    const [created] = await connection.query(
      `SELECT id, organization_id, name, branch_code,
              phone, address, status, created_at
       FROM branches
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
      [branchId, organizationId]
    );

    const branch = created[0];

    await writePlatformAuditLog(connection, {
      platformAdminId: req.platformAdmin.id,
      organizationId,
      action: "BRANCH_CREATED",
      entityType: "branch",
      entityId: branchId,
      description: `Created branch ${normalizedName} for ${organization.name}`,
      oldValues: null,
      newValues: {
        name: normalizedName,
        branch_code: normalizedCode,
        phone: normalizedPhone,
        address: normalizedAddress,
        status: "active",
      },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    if (gymAdminUsers.length > 0) {
      await writePlatformAuditLog(connection, {
        platformAdminId: req.platformAdmin.id,
        organizationId,
        action: "GYM_ADMIN_BRANCH_ACCESS_GRANTED",
        entityType: "branch",
        entityId: branchId,
        description: `Automatically granted the new branch to ${gymAdminUsers.length} active Gym Admin account(s)`,
        oldValues: null,
        newValues: {
          branch_id: branchId,
          user_ids: gymAdminUsers.map((user) => user.id),
          access_source: "system_gym_admin_role",
        },
        ipAddress: req.ip || null,
        userAgent: req.get("user-agent") || null,
      });
    }
    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Branch created successfully",
      branch,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "Branch code already exists for this organization",
      });
    }

    console.error("Create branch error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create branch",
    });
  } finally {
    if (connection) connection.release();
  }
};

const updateBranch = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = parsePositiveId(req.params.organizationId);
    const branchId = parsePositiveId(req.params.branchId);
    const body = req.body || {};

    if (!organizationId || !branchId) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization or branch ID",
      });
    }

    const allowedFields = ["name", "branch_code", "phone", "address"];
    const suppliedFields = allowedFields.filter((key) =>
      Object.prototype.hasOwnProperty.call(body, key)
    );

    if (suppliedFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one branch field must be supplied",
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "name") &&
      (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.trim().length > 150
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch name",
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "branch_code") &&
      (
        typeof body.branch_code !== "string" ||
        !body.branch_code.trim() ||
        body.branch_code.trim().length > 50
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch code",
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "phone") &&
      body.phone !== null &&
      body.phone !== "" &&
      (typeof body.phone !== "string" || body.phone.trim().length > 30)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch phone number",
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "address") &&
      body.address !== null &&
      typeof body.address !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch address",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    await connection.query(
      "SELECT id FROM organizations WHERE id = ? FOR UPDATE",
      [organizationId]
    );

    const [branches] = await connection.query(
      `SELECT id, organization_id, name, branch_code,
              phone, address, status
       FROM branches
       WHERE id = ? AND organization_id = ?
       LIMIT 1
       FOR UPDATE`,
      [branchId, organizationId]
    );

    if (branches.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({
        success: false,
        message: "Branch not found in this organization",
      });
    }

    const oldBranch = branches[0];

    if (oldBranch.status !== "active") {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({
        success: false,
        message: "Reactivate the branch before editing it",
      });
    }

    const updates = [];
    const params = [];
    const newValues = {};

    const fieldMapping = {
      name: "name",
      branch_code: "branch_code",
      phone: "phone",
      address: "address",
    };

    for (const key of suppliedFields) {
      let value = body[key];

      if (key === "name") value = value.trim();
      if (key === "branch_code") value = value.trim().toUpperCase();
      if (key === "phone") value = value ? value.trim() : null;
      if (key === "address") value = value ? value.trim() : null;

      updates.push(`${fieldMapping[key]} = ?`);
      params.push(value);
      newValues[key] = value;
    }

    if (Object.prototype.hasOwnProperty.call(body, "branch_code")) {
      const [duplicates] = await connection.query(
        `SELECT id FROM branches
         WHERE organization_id = ?
           AND branch_code = ?
           AND id <> ?
         LIMIT 1`,
        [organizationId, newValues.branch_code, branchId]
      );

      if (duplicates.length > 0) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(409).json({
          success: false,
          message: "Branch code already exists for this organization",
        });
      }
    }

    params.push(branchId, organizationId);

    await connection.query(
      `UPDATE branches
       SET ${updates.join(", ")}
       WHERE id = ? AND organization_id = ?`,
      params
    );

    const [updatedRows] = await connection.query(
      `SELECT id, organization_id, name, branch_code,
              phone, address, status, updated_at
       FROM branches
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
      [branchId, organizationId]
    );

    const updatedBranch = updatedRows[0];

    await writePlatformAuditLog(connection, {
      platformAdminId: req.platformAdmin.id,
      organizationId,
      action: "BRANCH_UPDATED",
      entityType: "branch",
      entityId: branchId,
      description: `Updated branch ${updatedBranch.name}`,
      oldValues: oldBranch,
      newValues: updatedBranch,
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Branch updated successfully",
      branch: updatedBranch,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "Branch code already exists for this organization",
      });
    }

    console.error("Update branch error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update branch",
    });
  } finally {
    if (connection) connection.release();
  }
};

const setBranchStatus = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = parsePositiveId(req.params.organizationId);
    const branchId = parsePositiveId(req.params.branchId);
    const { status } = req.body || {};

    if (!organizationId || !branchId) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization or branch ID",
      });
    }

    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be active or inactive",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    await connection.query(
      "SELECT id FROM organizations WHERE id = ? FOR UPDATE",
      [organizationId]
    );

    const [branches] = await connection.query(
      `SELECT id, organization_id, name, branch_code,
              phone, address, status
       FROM branches
       WHERE id = ? AND organization_id = ?
       LIMIT 1
       FOR UPDATE`,
      [branchId, organizationId]
    );

    if (branches.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({
        success: false,
        message: "Branch not found in this organization",
      });
    }

    const oldBranch = branches[0];

    if (oldBranch.status === status) {
      await connection.rollback();
      transactionStarted = false;
      return res.json({
        success: true,
        message: `Branch is already ${status}`,
        branch: oldBranch,
      });
    }

    await connection.query(
      `UPDATE branches
       SET status = ?
       WHERE id = ? AND organization_id = ?`,
      [status, branchId, organizationId]
    );

    await writePlatformAuditLog(connection, {
      platformAdminId: req.platformAdmin.id,
      organizationId,
      action: status === "inactive"
        ? "BRANCH_DEACTIVATED"
        : "BRANCH_REACTIVATED",
      entityType: "branch",
      entityId: branchId,
      description: `${status === "inactive" ? "Deactivated" : "Reactivated"} branch ${oldBranch.name}`,
      oldValues: { status: oldBranch.status },
      newValues: { status },
      ipAddress: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: `Branch ${status === "inactive" ? "deactivated" : "reactivated"} successfully`,
      branch: {
        id: branchId,
        organization_id: organizationId,
        status,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      await connection.rollback();
    }

    console.error("Set branch status error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update branch status",
    });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getBranches,
  createBranch,
  updateBranch,
  setBranchStatus,
};
