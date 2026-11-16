const bcrypt = require("bcrypt");
const db = require("../config/db");

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const httpError = (message, statusCode = 400, code = "GYM_STAFF_REQUEST_INVALID") => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const isSystemGymAdmin = (req) =>
  (req.gymStaff?.roles || []).some(
    (role) =>
      role.name === "Gym Admin" &&
      Number(role.is_system_role) === 1
  );

const requireActor = (req) => {
  const organizationId = parsePositiveId(req.gymStaff?.organizationId);
  const userId = parsePositiveId(req.gymStaff?.userId);

  if (!organizationId || !userId) {
    throw httpError("Invalid Gym Staff session.", 401, "GYM_STAFF_SESSION_INVALID");
  }

  return { organizationId, userId };
};

const normalizeIdList = (value, fieldName) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw httpError(`${fieldName} must contain between 1 and 100 IDs.`);
  }

  const ids = [];
  const seen = new Set();

  for (const item of value) {
    const id = parsePositiveId(item);
    if (!id) {
      throw httpError(`${fieldName} contains an invalid ID.`);
    }

    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
};

const withTransaction = async (work) => {
  const connection = await db.getConnection();
  let started = false;

  try {
    await connection.beginTransaction();
    started = true;

    const result = await work(connection);

    await connection.commit();
    started = false;

    return result;
  } catch (error) {
    if (started) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Gym Staff rollback error:", rollbackError.message);
      }
    }
    throw error;
  } finally {
    connection.release();
  }
};

const lockActiveOrganization = async (connection, organizationId) => {
  const [rows] = await connection.query(
    `SELECT id, status
     FROM organizations
     WHERE id = ?
     LIMIT 1
     FOR UPDATE`,
    [organizationId]
  );

  if (rows.length === 0) {
    throw httpError("Organization not found.", 404, "ORGANIZATION_NOT_FOUND");
  }

  if (rows[0].status !== "active") {
    throw httpError(
      "This organization is inactive. Staff accounts cannot be changed.",
      403,
      "ORGANIZATION_INACTIVE"
    );
  }
};

const getActorAccessibleBranchIds = async (executor, req) => {
  const { organizationId, userId } = requireActor(req);

  let sql = `
    SELECT b.id
    FROM branches b
    WHERE b.organization_id = ?
      AND b.status = 'active'
  `;
  const params = [organizationId];

  if (!isSystemGymAdmin(req)) {
    sql += `
      AND EXISTS (
        SELECT 1
        FROM user_branch_access uba
        WHERE uba.organization_id = b.organization_id
          AND uba.branch_id = b.id
          AND uba.user_id = ?
      )
    `;
    params.push(userId);
  }

  sql += " ORDER BY b.id ASC";

  const [rows] = await executor.query(sql, params);
  return rows.map((row) => Number(row.id));
};

const assertRequestedBranchesAllowed = async (
  executor,
  req,
  requestedBranchIds
) => {
  const allowedIds = await getActorAccessibleBranchIds(executor, req);
  const allowed = new Set(allowedIds);

  if (allowedIds.length === 0) {
    throw httpError(
      "Your account has no active branch access.",
      403,
      "NO_ACTIVE_BRANCH_ACCESS"
    );
  }

  const denied = requestedBranchIds.filter((id) => !allowed.has(id));

  if (denied.length > 0) {
    throw httpError(
      "You can assign staff only to branches assigned to your own account.",
      403,
      "STAFF_BRANCH_ASSIGNMENT_DENIED"
    );
  }

  return requestedBranchIds;
};

const assertRolesAssignable = async (
  connection,
  req,
  requestedRoleIds
) => {
  const { organizationId } = requireActor(req);
  const placeholders = requestedRoleIds.map(() => "?").join(", ");

  const [roles] = await connection.query(
    `SELECT id, name, is_system_role
     FROM roles
     WHERE organization_id = ?
       AND id IN (${placeholders})
     ORDER BY id ASC
     FOR UPDATE`,
    [organizationId, ...requestedRoleIds]
  );

  if (roles.length !== requestedRoleIds.length) {
    throw httpError(
      "One or more selected roles do not belong to this organization.",
      400,
      "INVALID_STAFF_ROLE"
    );
  }

  if (roles.some((role) => Number(role.is_system_role) === 1)) {
    throw httpError(
      "The protected system Gym Admin role cannot be assigned through Staff Management.",
      403,
      "SYSTEM_ROLE_ASSIGNMENT_DENIED"
    );
  }

  if (!isSystemGymAdmin(req)) {
    const [permissionRows] = await connection.query(
      `SELECT DISTINCT p.permission_key
       FROM role_permissions rp
       INNER JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id IN (${placeholders})
         AND p.permission_scope = 'gym'`,
      requestedRoleIds
    );

    const actorPermissions = new Set(req.gymStaff?.permissions || []);
    const missing = permissionRows
      .map((row) => row.permission_key)
      .filter((key) => !actorPermissions.has(key));

    if (missing.length > 0) {
      throw httpError(
        "You cannot assign a role containing permissions that are not assigned to your own account.",
        403,
        "ROLE_PERMISSION_ESCALATION_DENIED"
      );
    }
  }

  return roles;
};

const findManageableStaff = async (
  connection,
  req,
  staffId,
  actorBranchIds
) => {
  const { organizationId } = requireActor(req);

  let sql = `
    SELECT u.id, u.organization_id, u.full_name, u.email,
           u.phone, u.status, u.last_login_at,
           u.created_at, u.updated_at
    FROM users u
    WHERE u.organization_id = ?
      AND u.id = ?
  `;
  const params = [organizationId, staffId];

  if (!isSystemGymAdmin(req)) {
    if (actorBranchIds.length === 0) {
      throw httpError("You have no active branch access.", 403, "NO_ACTIVE_BRANCH_ACCESS");
    }

    const placeholders = actorBranchIds.map(() => "?").join(", ");
    sql += `
      AND EXISTS (
        SELECT 1
        FROM user_branch_access scoped
        WHERE scoped.organization_id = u.organization_id
          AND scoped.user_id = u.id
          AND scoped.branch_id IN (${placeholders})
      )
      AND NOT EXISTS (
        SELECT 1
        FROM user_branch_access outside_scope
        WHERE outside_scope.organization_id = u.organization_id
          AND outside_scope.user_id = u.id
          AND outside_scope.branch_id NOT IN (${placeholders})
      )
      AND NOT EXISTS (
        SELECT 1
        FROM user_roles protected_ur
        INNER JOIN roles protected_role
          ON protected_role.organization_id = protected_ur.organization_id
         AND protected_role.id = protected_ur.role_id
        WHERE protected_ur.organization_id = u.organization_id
          AND protected_ur.user_id = u.id
          AND protected_role.name = 'Gym Admin'
          AND protected_role.is_system_role = 1
      )
    `;
    params.push(...actorBranchIds, ...actorBranchIds);
  }

  sql += " LIMIT 1 FOR UPDATE";

  const [rows] = await connection.query(sql, params);

  if (rows.length === 0) {
    throw httpError(
      "Staff member not found or you do not have access to manage this account.",
      404,
      "STAFF_NOT_FOUND"
    );
  }

  return rows[0];
};

const isProtectedSystemAdminAccount = async (
  executor,
  organizationId,
  userId
) => {
  const [rows] = await executor.query(
    `SELECT 1
     FROM user_roles ur
     INNER JOIN roles r
       ON r.organization_id = ur.organization_id
      AND r.id = ur.role_id
     WHERE ur.organization_id = ?
       AND ur.user_id = ?
       AND r.name = 'Gym Admin'
       AND r.is_system_role = 1
     LIMIT 1`,
    [organizationId, userId]
  );

  return rows.length > 0;
};

const writeStaffAuditLog = async (
  connection,
  req,
  { action, staffId, description }
) => {
  const { organizationId, userId } = requireActor(req);
  const branchId = parsePositiveId(req.gymStaff?.branchId);

  await connection.query(
    `INSERT INTO audit_logs
      (organization_id, branch_id, user_id, action,
       entity_type, entity_id, description, ip_address, user_agent)
     VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?)`,
    [
      organizationId,
      branchId,
      userId,
      action,
      staffId,
      description,
      req.ip || null,
      req.get("user-agent")
        ? req.get("user-agent").substring(0, 500)
        : null,
    ]
  );
};

const loadStaffAssignments = async (
  executor,
  organizationId,
  staffIds,
  actorBranchIds,
  ownerView
) => {
  const roleMap = new Map();
  const branchMap = new Map();

  for (const id of staffIds) {
    roleMap.set(id, []);
    branchMap.set(id, []);
  }

  if (staffIds.length === 0) {
    return { roleMap, branchMap };
  }

  const staffPlaceholders = staffIds.map(() => "?").join(", ");

  const [roleRows] = await executor.query(
    `SELECT ur.user_id, r.id AS role_id, r.name AS role_name,
            r.is_system_role
     FROM user_roles ur
     INNER JOIN roles r
       ON r.organization_id = ur.organization_id
      AND r.id = ur.role_id
     WHERE ur.organization_id = ?
       AND ur.user_id IN (${staffPlaceholders})
     ORDER BY r.name ASC`,
    [organizationId, ...staffIds]
  );

  for (const row of roleRows) {
    roleMap.get(Number(row.user_id)).push({
      id: Number(row.role_id),
      name: row.role_name,
      is_system_role: Boolean(Number(row.is_system_role)),
    });
  }

  let branchSql = `
    SELECT uba.user_id, b.id AS branch_id, b.name,
           b.branch_code, b.status
    FROM user_branch_access uba
    INNER JOIN branches b
      ON b.organization_id = uba.organization_id
     AND b.id = uba.branch_id
    WHERE uba.organization_id = ?
      AND uba.user_id IN (${staffPlaceholders})
  `;
  const branchParams = [organizationId, ...staffIds];

  if (!ownerView) {
    if (actorBranchIds.length === 0) {
      return { roleMap, branchMap };
    }

    const branchPlaceholders = actorBranchIds.map(() => "?").join(", ");
    branchSql += ` AND b.id IN (${branchPlaceholders})`;
    branchParams.push(...actorBranchIds);
  }

  branchSql += " ORDER BY b.name ASC";

  const [branchRows] = await executor.query(branchSql, branchParams);

  for (const row of branchRows) {
    branchMap.get(Number(row.user_id)).push({
      id: Number(row.branch_id),
      name: row.name,
      branch_code: row.branch_code,
      status: row.status,
    });
  }

  return { roleMap, branchMap };
};

const sendError = (res, error, fallbackMessage) => {
  if (error.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      success: false,
      code: "DUPLICATE_STAFF_EMAIL",
      message: "A staff account with this email already exists in your organization.",
    });
  }

  const statusCode = Number(error.statusCode) || 500;

  if (statusCode >= 500) {
    console.error("Gym Staff API error:", error);
  }

  return res.status(statusCode).json({
    success: false,
    code: error.code || "GYM_STAFF_REQUEST_FAILED",
    message: statusCode >= 500 ? fallbackMessage : error.message,
  });
};

const listGymStaff = async (req, res) => {
  try {
    const { organizationId } = requireActor(req);
    const ownerView = isSystemGymAdmin(req);
    const actorBranchIds = await getActorAccessibleBranchIds(db, req);

    if (!ownerView && actorBranchIds.length === 0) {
      throw httpError("You have no active branch access.", 403, "NO_ACTIVE_BRANCH_ACCESS");
    }

    const page = Number.parseInt(req.query.page ?? "1", 10);
    const pageSize = Number.parseInt(req.query.page_size ?? "25", 10);
    const status = String(req.query.status ?? "all").toLowerCase();
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    if (!Number.isSafeInteger(page) || page < 1 ||
        !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw httpError("Invalid staff pagination values.");
    }

    if (!["all", "active", "inactive", "locked"].includes(status)) {
      throw httpError("Invalid staff status filter.");
    }

    if (search.length > 100) {
      throw httpError("Search cannot exceed 100 characters.");
    }

    const conditions = ["u.organization_id = ?"];
    const params = [organizationId];

    if (!ownerView) {
      const placeholders = actorBranchIds.map(() => "?").join(", ");
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM user_branch_access scoped
          WHERE scoped.organization_id = u.organization_id
            AND scoped.user_id = u.id
            AND scoped.branch_id IN (${placeholders})
        )
        AND NOT EXISTS (
          SELECT 1
          FROM user_branch_access outside_scope
          WHERE outside_scope.organization_id = u.organization_id
            AND outside_scope.user_id = u.id
            AND outside_scope.branch_id NOT IN (${placeholders})
        )
        AND NOT EXISTS (
          SELECT 1
          FROM user_roles protected_ur
          INNER JOIN roles protected_role
            ON protected_role.organization_id = protected_ur.organization_id
           AND protected_role.id = protected_ur.role_id
          WHERE protected_ur.organization_id = u.organization_id
            AND protected_ur.user_id = u.id
            AND protected_role.name = 'Gym Admin'
            AND protected_role.is_system_role = 1
        )
      `);
      params.push(...actorBranchIds, ...actorBranchIds);
    }

    if (status !== "all") {
      conditions.push("u.status = ?");
      params.push(status);
    }

    if (search) {
      conditions.push(`(
        u.full_name LIKE ? OR u.username LIKE ? OR u.email LIKE ?
        OR COALESCE(u.phone, '') LIKE ?
      )`);
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    const whereSql = conditions.join(" AND ");

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM users u
       WHERE ${whereSql}`,
      params
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * pageSize;

    const [staffRows] = await db.query(
      `SELECT u.id, u.full_name, u.username, u.email, u.phone, u.status,
              u.last_login_at, u.created_at, u.updated_at
       FROM users u
       WHERE ${whereSql}
       ORDER BY u.full_name ASC, u.id ASC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const staffIds = staffRows.map((row) => Number(row.id));
    const assignments = await loadStaffAssignments(
      db,
      organizationId,
      staffIds,
      actorBranchIds,
      ownerView
    );

    const staff = staffRows.map((row) => {
      const id = Number(row.id);
      return {
        ...row,
        id,
        roles: assignments.roleMap.get(id) || [],
        branches: assignments.branchMap.get(id) || [],
      };
    });

    return res.json({
      success: true,
      staff,
      pagination: {
        page: currentPage,
        page_size: pageSize,
        total,
        total_pages: totalPages,
      },
    });
  } catch (error) {
    return sendError(res, error, "Unable to load Gym Staff accounts.");
  }
};

const getGymStaff = async (req, res) => {
  try {
    const { organizationId } = requireActor(req);
    const staffId = parsePositiveId(req.params.staffId);

    if (!staffId) {
      throw httpError("Invalid staff ID.");
    }

    const ownerView = isSystemGymAdmin(req);
    const actorBranchIds = await getActorAccessibleBranchIds(db, req);

    if (!ownerView && actorBranchIds.length === 0) {
      throw httpError("You have no active branch access.", 403, "NO_ACTIVE_BRANCH_ACCESS");
    }

    let sql = `
      SELECT u.id, u.full_name, u.username, u.email, u.phone, u.status,
             u.last_login_at, u.created_at, u.updated_at
      FROM users u
      WHERE u.organization_id = ?
        AND u.id = ?
    `;
    const params = [organizationId, staffId];

    if (!ownerView) {
      const placeholders = actorBranchIds.map(() => "?").join(", ");
      sql += `
        AND EXISTS (
          SELECT 1
          FROM user_branch_access scoped
          WHERE scoped.organization_id = u.organization_id
            AND scoped.user_id = u.id
            AND scoped.branch_id IN (${placeholders})
        )
        AND NOT EXISTS (
          SELECT 1
          FROM user_branch_access outside_scope
          WHERE outside_scope.organization_id = u.organization_id
            AND outside_scope.user_id = u.id
            AND outside_scope.branch_id NOT IN (${placeholders})
        )
        AND NOT EXISTS (
          SELECT 1
          FROM user_roles protected_ur
          INNER JOIN roles protected_role
            ON protected_role.organization_id = protected_ur.organization_id
           AND protected_role.id = protected_ur.role_id
          WHERE protected_ur.organization_id = u.organization_id
            AND protected_ur.user_id = u.id
            AND protected_role.name = 'Gym Admin'
            AND protected_role.is_system_role = 1
        )
      `;
      params.push(...actorBranchIds, ...actorBranchIds);
    }

    sql += " LIMIT 1";

    const [rows] = await db.query(sql, params);

    if (rows.length === 0) {
      throw httpError("Staff member not found or access denied.", 404, "STAFF_NOT_FOUND");
    }

    const assignments = await loadStaffAssignments(
      db,
      organizationId,
      [staffId],
      actorBranchIds,
      ownerView
    );

    return res.json({
      success: true,
      staff: {
        ...rows[0],
        id: Number(rows[0].id),
        roles: assignments.roleMap.get(staffId) || [],
        branches: assignments.branchMap.get(staffId) || [],
      },
    });
  } catch (error) {
    return sendError(res, error, "Unable to load the staff account.");
  }
};

const createGymStaff = async (req, res) => {
  try {
    const { organizationId } = requireActor(req);
    const body = req.body || {};

    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const email = body.email == null ||
      (typeof body.email === "string" && body.email.trim() === "")
      ? null
      : typeof body.email === "string" ? body.email.trim().toLowerCase() : undefined;
    const phone = body.phone == null || body.phone === ""
      ? null
      : typeof body.phone === "string" ? body.phone.trim() : undefined;
    const password = body.password;

    if (!fullName || fullName.length > 150) {
      throw httpError("Valid full_name is required (maximum 150 characters).");
    }

    if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username)) {
      throw httpError("Username must be 3-50 characters and use lowercase letters, numbers, dots, underscores, or hyphens.");
    }

    if (email !== null && (email === undefined ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150)) {
      throw httpError("Enter a valid email address or leave it blank.");
    }

    if (phone === undefined || (phone && phone.length > 30)) {
      throw httpError("Invalid phone number (maximum 30 characters).");
    }

    if (typeof password !== "string" ||
        password.length < 8 ||
        Buffer.byteLength(password, "utf8") > 72) {
      throw httpError("Password must be at least 8 characters and no more than 72 UTF-8 bytes.");
    }

    const roleIds = normalizeIdList(body.role_ids, "role_ids");
    const branchIds = normalizeIdList(body.branch_ids, "branch_ids");
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await withTransaction(async (connection) => {
      await lockActiveOrganization(connection, organizationId);

      await assertRequestedBranchesAllowed(connection, req, branchIds);
      await assertRolesAssignable(connection, req, roleIds);

      const [usernameDuplicates] = await connection.query(
        `SELECT id
         FROM users
         WHERE organization_id = ? AND username = ?
         LIMIT 1
         FOR UPDATE`,
        [organizationId, username]
      );

      if (usernameDuplicates.length > 0) {
        throw httpError(
          "A staff account with this username already exists.",
          409,
          "DUPLICATE_STAFF_USERNAME"
        );
      }

      if (email !== null) {
        const [emailDuplicates] = await connection.query(
          `SELECT id
           FROM users
           WHERE organization_id = ? AND email = ?
           LIMIT 1
           FOR UPDATE`,
          [organizationId, email]
        );

        if (emailDuplicates.length > 0) {
          throw httpError(
            "A staff account with this email already exists.",
            409,
            "DUPLICATE_STAFF_EMAIL"
          );
        }
      }

      const [insertResult] = await connection.query(
        `INSERT INTO users
          (organization_id, full_name, username, email, phone, password_hash, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [organizationId, fullName, username, email, phone, passwordHash]
      );

      const staffId = Number(insertResult.insertId);

      const roleValues = roleIds.map(() => "(?, ?, ?)").join(", ");
      const roleParams = [];
      for (const roleId of roleIds) {
        roleParams.push(organizationId, staffId, roleId);
      }

      await connection.query(
        `INSERT INTO user_roles (organization_id, user_id, role_id)
         VALUES ${roleValues}`,
        roleParams
      );

      const branchValues = branchIds.map(() => "(?, ?, ?)").join(", ");
      const branchParams = [];
      for (const branchId of branchIds) {
        branchParams.push(organizationId, staffId, branchId);
      }

      await connection.query(
        `INSERT INTO user_branch_access (organization_id, user_id, branch_id)
         VALUES ${branchValues}`,
        branchParams
      );

      await writeStaffAuditLog(connection, req, {
        action: "GYM_STAFF_CREATED",
        staffId,
        description: `Created staff account ${fullName} (${username}; email=${email || "not provided"}); role_ids=${roleIds.join(",")}; branch_ids=${branchIds.join(",")}`,
      });

      return { staffId };
    });

    return res.status(201).json({
      success: true,
      message: "Staff account created successfully.",
      staff_id: result.staffId,
    });
  } catch (error) {
    return sendError(res, error, "Unable to create the Gym Staff account.");
  }
};

const updateGymStaff = async (req, res) => {
  try {
    const { organizationId, userId: actorUserId } = requireActor(req);
    const staffId = parsePositiveId(req.params.staffId);
    const body = req.body || {};

    if (!staffId) {
      throw httpError("Invalid staff ID.");
    }

    const allowedFields = new Set(["full_name", "username", "email", "phone", "password"]);
    const unknownFields = Object.keys(body).filter((key) => !allowedFields.has(key));

    if (unknownFields.length > 0) {
      throw httpError(`Unsupported update fields: ${unknownFields.join(", ")}`);
    }

    const updates = [];
    const values = [];
    const auditChanges = [];
    let normalizedUsername = null;
    let normalizedEmail = null;

    if (Object.prototype.hasOwnProperty.call(body, "full_name")) {
      if (typeof body.full_name !== "string" ||
          !body.full_name.trim() ||
          body.full_name.trim().length > 150) {
        throw httpError("Valid full_name is required (maximum 150 characters).");
      }
      updates.push("full_name = ?");
      values.push(body.full_name.trim());
      auditChanges.push("name updated");
    }

    if (Object.prototype.hasOwnProperty.call(body, "username")) {
      if (typeof body.username !== "string") {
        throw httpError("Invalid username.");
      }

      normalizedUsername = body.username.trim().toLowerCase();

      if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(normalizedUsername)) {
        throw httpError("Username must be 3-50 characters and use lowercase letters, numbers, dots, underscores, or hyphens.");
      }

      updates.push("username = ?");
      values.push(normalizedUsername);
      auditChanges.push("username updated");
    }

    if (Object.prototype.hasOwnProperty.call(body, "email")) {
      if (body.email !== null && typeof body.email !== "string") {
        throw httpError("Invalid email address.");
      }

      const emailInput = body.email === null ? "" : body.email.trim();

      normalizedEmail = emailInput === "" ? null : emailInput.toLowerCase();

      if (normalizedEmail !== null &&
          (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 150)) {
        throw httpError("Enter a valid email address or clear the field.");
      }

      updates.push("email = ?");
      values.push(normalizedEmail);
      auditChanges.push(normalizedEmail === null ? "email cleared" : "email updated");
    }

    if (Object.prototype.hasOwnProperty.call(body, "phone")) {
      let phone = body.phone;
      if (phone === "") phone = null;
      if (phone !== null &&
          (typeof phone !== "string" || phone.trim().length > 30)) {
        throw httpError("Invalid phone number (maximum 30 characters).");
      }
      updates.push("phone = ?");
      values.push(phone === null ? null : phone.trim());
      auditChanges.push("phone updated");
    }

    if (Object.prototype.hasOwnProperty.call(body, "password")) {
      if (typeof body.password !== "string" ||
          body.password.length < 8 ||
          Buffer.byteLength(body.password, "utf8") > 72) {
        throw httpError("Password must be at least 8 characters and no more than 72 UTF-8 bytes.");
      }
      updates.push("password_hash = ?");
      values.push(await bcrypt.hash(body.password, 12));
      auditChanges.push("password reset");
    }

    if (updates.length === 0) {
      throw httpError("At least one profile field must be supplied.");
    }

    await withTransaction(async (connection) => {
      await lockActiveOrganization(connection, organizationId);

      const actorBranchIds = await getActorAccessibleBranchIds(connection, req);
      const target = await findManageableStaff(
        connection,
        req,
        staffId,
        actorBranchIds
      );

      if (await isProtectedSystemAdminAccount(connection, organizationId, staffId)) {
        throw httpError(
          "The protected system Gym Admin account cannot be edited through Staff Management.",
          403,
          "SYSTEM_GYM_ADMIN_PROTECTED"
        );
      }

      if (Object.prototype.hasOwnProperty.call(body, "username")) {
        const [duplicates] = await connection.query(
          `SELECT id
           FROM users
           WHERE organization_id = ?
             AND username = ?
             AND id <> ?
           LIMIT 1
           FOR UPDATE`,
          [organizationId, normalizedUsername, staffId]
        );

        if (duplicates.length > 0) {
          throw httpError(
            "A staff account with this username already exists.",
            409,
            "DUPLICATE_STAFF_USERNAME"
          );
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, "email") && normalizedEmail !== null) {
        const [duplicates] = await connection.query(
          `SELECT id
           FROM users
           WHERE organization_id = ?
             AND email = ?
             AND id <> ?
           LIMIT 1
           FOR UPDATE`,
          [organizationId, normalizedEmail, staffId]
        );

        if (duplicates.length > 0) {
          throw httpError(
            "A staff account with this email already exists.",
            409,
            "DUPLICATE_STAFF_EMAIL"
          );
        }
      }

      await connection.query(
        `UPDATE users
         SET ${updates.join(", ")}
         WHERE organization_id = ? AND id = ?`,
        [...values, organizationId, staffId]
      );

      await writeStaffAuditLog(connection, req, {
        action: "GYM_STAFF_PROFILE_UPDATED",
        staffId,
        description: `Updated staff account ${target.full_name}; ${auditChanges.join(", ")}`,
      });
    });

    return res.json({
      success: true,
      message: "Staff profile updated successfully.",
    });
  } catch (error) {
    return sendError(res, error, "Unable to update the Gym Staff account.");
  }
};

const updateGymStaffAssignments = async (req, res) => {
  try {
    const { organizationId, userId: actorUserId } = requireActor(req);
    const staffId = parsePositiveId(req.params.staffId);
    const body = req.body || {};

    if (!staffId) {
      throw httpError("Invalid staff ID.");
    }

    if (staffId === actorUserId) {
      throw httpError(
        "You cannot change your own role or branch assignments.",
        403,
        "SELF_ASSIGNMENT_CHANGE_DENIED"
      );
    }

    const roleIds = normalizeIdList(body.role_ids, "role_ids");
    const branchIds = normalizeIdList(body.branch_ids, "branch_ids");

    await withTransaction(async (connection) => {
      await lockActiveOrganization(connection, organizationId);

      const actorBranchIds = await getActorAccessibleBranchIds(connection, req);
      const target = await findManageableStaff(
        connection,
        req,
        staffId,
        actorBranchIds
      );

      if (await isProtectedSystemAdminAccount(connection, organizationId, staffId)) {
        throw httpError(
          "The protected system Gym Admin account cannot be reassigned.",
          403,
          "SYSTEM_GYM_ADMIN_PROTECTED"
        );
      }

      await assertRequestedBranchesAllowed(connection, req, branchIds);
      await assertRolesAssignable(connection, req, roleIds);

      await connection.query(
        `DELETE FROM user_roles
         WHERE organization_id = ? AND user_id = ?`,
        [organizationId, staffId]
      );

      await connection.query(
        `DELETE FROM user_branch_access
         WHERE organization_id = ? AND user_id = ?`,
        [organizationId, staffId]
      );

      const roleValues = roleIds.map(() => "(?, ?, ?)").join(", ");
      const roleParams = [];
      for (const roleId of roleIds) {
        roleParams.push(organizationId, staffId, roleId);
      }

      await connection.query(
        `INSERT INTO user_roles (organization_id, user_id, role_id)
         VALUES ${roleValues}`,
        roleParams
      );

      const branchValues = branchIds.map(() => "(?, ?, ?)").join(", ");
      const branchParams = [];
      for (const branchId of branchIds) {
        branchParams.push(organizationId, staffId, branchId);
      }

      await connection.query(
        `INSERT INTO user_branch_access (organization_id, user_id, branch_id)
         VALUES ${branchValues}`,
        branchParams
      );

      await writeStaffAuditLog(connection, req, {
        action: "GYM_STAFF_ASSIGNMENTS_UPDATED",
        staffId,
        description: `Updated assignments for ${target.full_name}; role_ids=${roleIds.join(",")}; branch_ids=${branchIds.join(",")}`,
      });
    });

    return res.json({
      success: true,
      message: "Staff role and branch assignments updated successfully.",
      role_ids: roleIds,
      branch_ids: branchIds,
    });
  } catch (error) {
    return sendError(res, error, "Unable to update staff assignments.");
  }
};

const setGymStaffStatus = async (req, res) => {
  try {
    const { organizationId, userId: actorUserId } = requireActor(req);
    const staffId = parsePositiveId(req.params.staffId);
    const status = typeof req.body?.status === "string"
      ? req.body.status.trim().toLowerCase()
      : "";

    if (!staffId) {
      throw httpError("Invalid staff ID.");
    }

    if (staffId === actorUserId) {
      throw httpError(
        "You cannot deactivate or reactivate your own account.",
        403,
        "SELF_STATUS_CHANGE_DENIED"
      );
    }

    if (!["active", "inactive"].includes(status)) {
      throw httpError("Status must be either active or inactive.");
    }

    await withTransaction(async (connection) => {
      await lockActiveOrganization(connection, organizationId);

      const actorBranchIds = await getActorAccessibleBranchIds(connection, req);
      const target = await findManageableStaff(
        connection,
        req,
        staffId,
        actorBranchIds
      );

      if (await isProtectedSystemAdminAccount(connection, organizationId, staffId)) {
        throw httpError(
          "The protected system Gym Admin account cannot be deactivated.",
          403,
          "SYSTEM_GYM_ADMIN_PROTECTED"
        );
      }

      if (target.status === status) {
        return;
      }

      await connection.query(
        `UPDATE users
         SET status = ?
         WHERE organization_id = ? AND id = ?`,
        [status, organizationId, staffId]
      );

      await writeStaffAuditLog(connection, req, {
        action: status === "inactive"
          ? "GYM_STAFF_DEACTIVATED"
          : "GYM_STAFF_REACTIVATED",
        staffId,
        description: `${status === "inactive" ? "Deactivated" : "Reactivated"} staff account ${target.full_name}`,
      });
    });

    return res.json({
      success: true,
      message: status === "inactive"
        ? "Staff account deactivated successfully."
        : "Staff account reactivated successfully.",
      status,
    });
  } catch (error) {
    return sendError(res, error, "Unable to update staff account status.");
  }
};

module.exports = {
  listGymStaff,
  getGymStaff,
  createGymStaff,
  updateGymStaff,
  updateGymStaffAssignments,
  setGymStaffStatus,
};