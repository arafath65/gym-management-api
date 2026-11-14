const db = require("../config/db");

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const isSystemGymAdmin = (req) =>
  (req.gymStaff?.roles || []).some(
    (role) => role.name === "Gym Admin" && role.is_system_role === true
  );

const writeBranchAuditLog = async (
  connection,
  req,
  { action, branchId, message, oldValues = null, newValues = null }
) => {
  const organizationId = Number(req.gymStaff.organizationId);
  const userId = Number(req.gymStaff.userId);
  const details = [
    message,
    oldValues ? `old_values=${JSON.stringify(oldValues)}` : null,
    newValues ? `new_values=${JSON.stringify(newValues)}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  await connection.query(
    `INSERT INTO audit_logs
      (organization_id, branch_id, user_id, action, entity_type, entity_id,
       description, ip_address, user_agent)
     VALUES (?, ?, ?, ?, 'branch', ?, ?, ?, ?)`,
    [
      organizationId,
      branchId,
      userId,
      action,
      branchId,
      details,
      req.ip || null,
      req.get("user-agent") ? req.get("user-agent").substring(0, 500) : null,
    ]
  );
};

const branchFields = `
  b.id, b.organization_id, b.name, b.branch_code,
  b.phone, b.address, b.status, b.created_at, b.updated_at
`;

const listBranches = async (req, res) => {
  try {
    const organizationId = parsePositiveId(req.gymStaff?.organizationId);
    const userId = parsePositiveId(req.gymStaff?.userId);

    if (!organizationId || !userId) {
      return res.status(401).json({
        success: false,
        message: "Invalid Gym Staff organization session.",
      });
    }

    const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(req.query.page_size, 10) || 25)
    );
    const status = (req.query.status || "all").toString().toLowerCase();

    if (!["all", "active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch status filter.",
      });
    }

    const conditions = ["b.organization_id = ?"];
    const params = [organizationId];

    // System Gym Admins can manage the organization's complete branch list.
    // Other staff can see only branches explicitly assigned to their account.
    if (!isSystemGymAdmin(req)) {
      conditions.push(`EXISTS (
        SELECT 1
        FROM user_branch_access uba
        WHERE uba.organization_id = b.organization_id
          AND uba.branch_id = b.id
          AND uba.user_id = ?
      )`);
      params.push(userId);
    }

    if (status !== "all") {
      conditions.push("b.status = ?");
      params.push(status);
    }

    const search = (req.query.search || "").toString().trim();
    if (search) {
      conditions.push(`(
        b.name LIKE ? OR b.branch_code LIKE ? OR
        COALESCE(b.phone, '') LIKE ? OR COALESCE(b.address, '') LIKE ?
      )`);
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    const whereSql = conditions.join(" AND ");
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM branches b
       WHERE ${whereSql}`,
      params
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;

    const [branches] = await db.query(
      `SELECT ${branchFields}
       FROM branches b
       WHERE ${whereSql}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return res.json({
      success: true,
      branches,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: totalPages,
      },
    });
  } catch (error) {
    console.error("List Gym branches error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve branches.",
    });
  }
};

const validateBranchPayload = (body, allowPartial = false) => {
  const suppliedFields = ["name", "branch_code", "phone", "address"].filter(
    (field) => Object.prototype.hasOwnProperty.call(body, field)
  );

  if (!allowPartial && (!suppliedFields.includes("name") || !suppliedFields.includes("branch_code"))) {
    return { error: "Branch name and branch code are required." };
  }

  if (allowPartial && suppliedFields.length === 0) {
    return { error: "At least one branch field must be supplied." };
  }

  if (
    Object.prototype.hasOwnProperty.call(body, "name") &&
    (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 150)
  ) {
    return { error: "Valid branch name is required (maximum 150 characters)." };
  }

  if (
    Object.prototype.hasOwnProperty.call(body, "branch_code") &&
    (typeof body.branch_code !== "string" || !body.branch_code.trim() || body.branch_code.trim().length > 50)
  ) {
    return { error: "Valid branch code is required (maximum 50 characters)." };
  }

  if (
    Object.prototype.hasOwnProperty.call(body, "phone") &&
    body.phone !== null &&
    body.phone !== "" &&
    (typeof body.phone !== "string" || body.phone.trim().length > 30)
  ) {
    return { error: "Invalid branch phone number (maximum 30 characters)." };
  }

  if (
    Object.prototype.hasOwnProperty.call(body, "address") &&
    body.address !== null &&
    body.address !== "" &&
    typeof body.address !== "string"
  ) {
    return { error: "Invalid branch address." };
  }

  return { fields: suppliedFields };
};

const hasBranchAccess = async (connection, req, branchId) => {
  if (isSystemGymAdmin(req)) return true;

  const [rows] = await connection.query(
    `SELECT 1
     FROM user_branch_access
     WHERE organization_id = ?
       AND user_id = ?
       AND branch_id = ?
     LIMIT 1`,
    [req.gymStaff.organizationId, req.gymStaff.userId, branchId]
  );

  return rows.length > 0;
};

const createBranch = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = parsePositiveId(req.gymStaff?.organizationId);
    const userId = parsePositiveId(req.gymStaff?.userId);
    const body = req.body || {};
    const validation = validateBranchPayload(body);

    if (!organizationId || !userId) {
      return res.status(401).json({ success: false, message: "Invalid Gym Staff session." });
    }
    if (validation.error) {
      return res.status(400).json({ success: false, message: validation.error });
    }

    const name = body.name.trim();
    const branchCode = body.branch_code.trim().toUpperCase();
    const phone = body.phone ? body.phone.trim() : null;
    const address = body.address ? body.address.trim() : null;

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
      return res.status(404).json({ success: false, message: "Organization not found." });
    }

    if (organizations[0].status !== "active") {
      await connection.rollback();
      transactionStarted = false;
      return res.status(403).json({ success: false, message: "Cannot create a branch for an inactive organization." });
    }

    const [duplicates] = await connection.query(
      `SELECT id
       FROM branches
       WHERE organization_id = ? AND branch_code = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId, branchCode]
    );

    if (duplicates.length > 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({ success: false, message: "Branch code already exists for this organization." });
    }

    const [insertResult] = await connection.query(
      `INSERT INTO branches
        (organization_id, name, branch_code, phone, address, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [organizationId, name, branchCode, phone, address]
    );

    const branchId = Number(insertResult.insertId);

    // The creator receives access to the branch they created.
    await connection.query(
      `INSERT IGNORE INTO user_branch_access
        (organization_id, user_id, branch_id)
       VALUES (?, ?, ?)`,
      [organizationId, userId, branchId]
    );

    // System Gym Admins receive access to every newly created branch.
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
        `INSERT IGNORE INTO user_branch_access
          (organization_id, user_id, branch_id)
         VALUES (?, ?, ?)`,
        [organizationId, gymAdmin.id, branchId]
      );
    }

    const [createdRows] = await connection.query(
      `SELECT id, organization_id, name, branch_code, phone, address,
              status, created_at, updated_at
       FROM branches
       WHERE organization_id = ? AND id = ?
       LIMIT 1`,
      [organizationId, branchId]
    );
    const branch = createdRows[0];

    await writeBranchAuditLog(connection, req, {
      action: "BRANCH_CREATED",
      branchId,
      message: `Created branch ${name} (${branchCode})`,
      newValues: {
        name,
        branch_code: branchCode,
        phone,
        address,
        status: "active",
        creator_access_granted: true,
        system_gym_admin_access_count: gymAdminUsers.length,
      },
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Branch created successfully.",
      branch,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error("Create Gym branch rollback error:", rollbackError);
      }
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Branch code already exists for this organization." });
    }

    console.error("Create Gym branch error:", error);
    return res.status(500).json({ success: false, message: "Failed to create branch." });
  } finally {
    if (connection) connection.release();
  }
};

const updateBranch = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = parsePositiveId(req.gymStaff?.organizationId);
    const branchId = parsePositiveId(req.params.branchId);
    const body = req.body || {};
    const validation = validateBranchPayload(body, true);

    if (!organizationId || !branchId) {
      return res.status(400).json({ success: false, message: "Invalid organization or branch ID." });
    }
    if (validation.error) {
      return res.status(400).json({ success: false, message: validation.error });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [organizations] = await connection.query(
      `SELECT id, status FROM organizations WHERE id = ? LIMIT 1 FOR UPDATE`,
      [organizationId]
    );
    if (organizations.length === 0) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ success: false, message: "Organization not found." });
    }
    if (organizations[0].status !== "active") {
      await connection.rollback(); transactionStarted = false;
      return res.status(403).json({ success: false, message: "Cannot update branches for an inactive organization." });
    }

    const [rows] = await connection.query(
      `SELECT id, organization_id, name, branch_code, phone, address, status
       FROM branches
       WHERE organization_id = ? AND id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId, branchId]
    );
    if (rows.length === 0) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ success: false, message: "Branch not found in this organization." });
    }

    if (!(await hasBranchAccess(connection, req, branchId))) {
      await connection.rollback(); transactionStarted = false;
      return res.status(403).json({ success: false, message: "You do not have access to manage this branch." });
    }

    const oldBranch = rows[0];
    if (oldBranch.status !== "active") {
      await connection.rollback(); transactionStarted = false;
      return res.status(409).json({ success: false, message: "Reactivate the branch before editing it." });
    }

    const updates = [];
    const values = [];
    const newValues = {};
    const normalize = {
      name: (value) => value.trim(),
      branch_code: (value) => value.trim().toUpperCase(),
      phone: (value) => value ? value.trim() : null,
      address: (value) => value ? value.trim() : null,
    };

    for (const key of validation.fields) {
      const value = normalize[key](body[key]);
      updates.push(`${key} = ?`);
      values.push(value);
      newValues[key] = value;
    }

    if (Object.prototype.hasOwnProperty.call(body, "branch_code")) {
      const [duplicates] = await connection.query(
        `SELECT id FROM branches
         WHERE organization_id = ? AND branch_code = ? AND id <> ?
         LIMIT 1`,
        [organizationId, newValues.branch_code, branchId]
      );
      if (duplicates.length > 0) {
        await connection.rollback(); transactionStarted = false;
        return res.status(409).json({ success: false, message: "Branch code already exists for this organization." });
      }
    }

    await connection.query(
      `UPDATE branches SET ${updates.join(", ")}
       WHERE organization_id = ? AND id = ?`,
      [...values, organizationId, branchId]
    );

    const [updatedRows] = await connection.query(
      `SELECT id, organization_id, name, branch_code, phone, address,
              status, created_at, updated_at
       FROM branches WHERE organization_id = ? AND id = ? LIMIT 1`,
      [organizationId, branchId]
    );
    const updatedBranch = updatedRows[0];

    await writeBranchAuditLog(connection, req, {
      action: "BRANCH_UPDATED",
      branchId,
      message: `Updated branch ${oldBranch.name}`,
      oldValues: oldBranch,
      newValues: updatedBranch,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({ success: true, message: "Branch updated successfully.", branch: updatedBranch });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error("Update Gym branch rollback error:", rollbackError);
      }
    }
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Branch code already exists for this organization." });
    }
    console.error("Update Gym branch error:", error);
    return res.status(500).json({ success: false, message: "Failed to update branch." });
  } finally {
    if (connection) connection.release();
  }
};

const setBranchStatus = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = parsePositiveId(req.gymStaff?.organizationId);
    const branchId = parsePositiveId(req.params.branchId);
    const status = (req.body?.status || "").toString().toLowerCase();

    if (!organizationId || !branchId) {
      return res.status(400).json({ success: false, message: "Invalid organization or branch ID." });
    }
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be active or inactive." });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [organizations] = await connection.query(
      `SELECT id, status FROM organizations WHERE id = ? LIMIT 1 FOR UPDATE`,
      [organizationId]
    );
    if (organizations.length === 0) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ success: false, message: "Organization not found." });
    }
    if (organizations[0].status !== "active") {
      await connection.rollback(); transactionStarted = false;
      return res.status(403).json({ success: false, message: "Cannot change branches for an inactive organization." });
    }

    const [rows] = await connection.query(
      `SELECT id, organization_id, name, branch_code, phone, address, status
       FROM branches
       WHERE organization_id = ? AND id = ?
       LIMIT 1 FOR UPDATE`,
      [organizationId, branchId]
    );
    if (rows.length === 0) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ success: false, message: "Branch not found in this organization." });
    }

    if (!(await hasBranchAccess(connection, req, branchId))) {
      await connection.rollback(); transactionStarted = false;
      return res.status(403).json({ success: false, message: "You do not have access to manage this branch." });
    }

    const oldBranch = rows[0];
    if (oldBranch.status === status) {
      await connection.commit(); transactionStarted = false;
      return res.json({ success: true, message: `Branch is already ${status}.`, branch: oldBranch });
    }

    if (status === "inactive") {
      if (branchId === Number(req.gymStaff.branchId)) {
        await connection.rollback(); transactionStarted = false;
        return res.status(409).json({
          success: false,
          message: "Switch to another active branch before deactivating your current branch.",
        });
      }

      const [activeCountRows] = await connection.query(
        `SELECT COUNT(*) AS active_count
         FROM branches
         WHERE organization_id = ? AND status = 'active'`,
        [organizationId]
      );
      if (Number(activeCountRows[0]?.active_count || 0) <= 1) {
        await connection.rollback(); transactionStarted = false;
        return res.status(409).json({
          success: false,
          message: "At least one active branch must remain in the organization.",
        });
      }
    }

    await connection.query(
      `UPDATE branches SET status = ? WHERE organization_id = ? AND id = ?`,
      [status, organizationId, branchId]
    );

    const [updatedRows] = await connection.query(
      `SELECT id, organization_id, name, branch_code, phone, address,
              status, created_at, updated_at
       FROM branches WHERE organization_id = ? AND id = ? LIMIT 1`,
      [organizationId, branchId]
    );
    const updatedBranch = updatedRows[0];

    await writeBranchAuditLog(connection, req, {
      action: status === "inactive" ? "BRANCH_DEACTIVATED" : "BRANCH_REACTIVATED",
      branchId,
      message: `${status === "inactive" ? "Deactivated" : "Reactivated"} branch ${oldBranch.name}`,
      oldValues: oldBranch,
      newValues: updatedBranch,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: status === "inactive" ? "Branch deactivated successfully." : "Branch reactivated successfully.",
      branch: updatedBranch,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error("Update Gym branch status rollback error:", rollbackError);
      }
    }
    console.error("Set Gym branch status error:", error);
    return res.status(500).json({ success: false, message: "Failed to update branch status." });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  listBranches,
  createBranch,
  updateBranch,
  setBranchStatus,
};