const db = require("../config/db");

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const isSystemGymAdmin = (req) =>
  (req.gymStaff?.roles || []).some(
    (role) => role.name === "Gym Admin" && role.is_system_role === true
  );

const normalizePermissionKeys = (value) => {
  if (!Array.isArray(value)) return { error: "permission_keys must be an array." };
  if (value.length > 250) return { error: "A role cannot contain more than 250 permissions." };

  const keys = [];
  const seen = new Set();

  for (const raw of value) {
    if (typeof raw !== "string") {
      return { error: "Every permission key must be text." };
    }

    const key = raw.trim();
    if (!key || key.length > 100) {
      return { error: "A permission key is invalid." };
    }

    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }

  return { keys };
};

const loadGymPermissionRows = async (executor, permissionKeys) => {
  if (permissionKeys.length === 0) return [];

  const placeholders = permissionKeys.map(() => "?").join(", ");
  const [rows] = await executor.query(
    `SELECT id, permission_key, module_name, description
     FROM permissions
     WHERE permission_scope = 'gym'
       AND permission_key IN (${placeholders})
     ORDER BY module_name ASC, permission_key ASC`,
    permissionKeys
  );

  if (rows.length !== permissionKeys.length) {
    const found = new Set(rows.map((row) => row.permission_key));
    const invalid = permissionKeys.filter((key) => !found.has(key));
    const error = new Error(`Unknown or unavailable Gym permissions: ${invalid.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  return rows;
};

const ensureActorMayGrant = (req, permissionKeys) => {
  if (isSystemGymAdmin(req)) return;

  const actorPermissions = new Set(req.gymStaff?.permissions || []);
  const notAllowed = permissionKeys.filter((key) => !actorPermissions.has(key));

  if (notAllowed.length > 0) {
    const error = new Error(
      "You cannot grant permissions that are not assigned to your own account."
    );
    error.statusCode = 403;
    error.code = "ROLE_PERMISSION_ESCALATION_DENIED";
    throw error;
  }
};

const writeRoleAuditLog = async (
  connection,
  req,
  { action, roleId, description }
) => {
  await connection.query(
    `INSERT INTO audit_logs
      (organization_id, branch_id, user_id, action, entity_type, entity_id,
       description, ip_address, user_agent)
     VALUES (?, ?, ?, ?, 'role', ?, ?, ?, ?)`,
    [
      Number(req.gymStaff.organizationId),
      Number(req.gymStaff.branchId),
      Number(req.gymStaff.userId),
      action,
      roleId,
      description,
      req.ip || null,
      req.get("user-agent")
        ? req.get("user-agent").substring(0, 500)
        : null,
    ]
  );
};

const rollback = async (connection, transactionStarted) => {
  if (!connection || !transactionStarted) return;
  try {
    await connection.rollback();
  } catch (error) {
    console.error("Gym role transaction rollback failed:", error.message);
  }
};

const listGymPermissions = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, permission_key, module_name, description, gym_admin_default
       FROM permissions
       WHERE permission_scope = 'gym'
       ORDER BY module_name ASC, permission_key ASC`
    );

    const grouped = new Map();
    for (const row of rows) {
      const moduleName = row.module_name;
      if (!grouped.has(moduleName)) grouped.set(moduleName, []);
      grouped.get(moduleName).push({
        id: Number(row.id),
        permission_key: row.permission_key,
        description: row.description,
        gym_admin_default: Boolean(row.gym_admin_default),
      });
    }

    return res.json({
      success: true,
      modules: Array.from(grouped.entries()).map(([module_name, permissions]) => ({
        module_name,
        permissions,
      })),
      permission_count: rows.length,
    });
  } catch (error) {
    console.error("List Gym permission catalogue error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load Gym permissions.",
    });
  }
};

const listGymRoles = async (req, res) => {
  try {
    const organizationId = parsePositiveId(req.gymStaff?.organizationId);
    if (!organizationId) {
      return res.status(401).json({ success: false, message: "Invalid organization session." });
    }

    const [roles] = await db.query(
      `SELECT
         r.id,
         r.name,
         r.description,
         r.is_system_role,
         r.created_at,
         (SELECT COUNT(DISTINCT ur.user_id)
          FROM user_roles ur
          WHERE ur.organization_id = r.organization_id
            AND ur.role_id = r.id) AS assigned_user_count,
         (SELECT COUNT(*)
          FROM role_permissions rp
          INNER JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = r.id
            AND p.permission_scope = 'gym') AS permission_count
       FROM roles r
       WHERE r.organization_id = ?
       ORDER BY r.is_system_role DESC, r.name ASC, r.id ASC`,
      [organizationId]
    );

    return res.json({
      success: true,
      roles: roles.map((role) => ({
        ...role,
        id: Number(role.id),
        is_system_role: Boolean(role.is_system_role),
        assigned_user_count: Number(role.assigned_user_count),
        permission_count: Number(role.permission_count),
      })),
    });
  } catch (error) {
    console.error("List Gym roles error:", error);
    return res.status(500).json({ success: false, message: "Unable to load roles." });
  }
};

const getGymRole = async (req, res) => {
  try {
    const organizationId = parsePositiveId(req.gymStaff?.organizationId);
    const roleId = parsePositiveId(req.params.roleId);

    if (!organizationId || !roleId) {
      return res.status(400).json({ success: false, message: "Invalid organization or role ID." });
    }

    const [roles] = await db.query(
      `SELECT id, organization_id, name, description, is_system_role, created_at
       FROM roles
       WHERE organization_id = ? AND id = ?
       LIMIT 1`,
      [organizationId, roleId]
    );

    if (roles.length === 0) {
      return res.status(404).json({ success: false, message: "Role not found." });
    }

    const [permissionRows] = await db.query(
      `SELECT p.id, p.permission_key, p.module_name, p.description
       FROM role_permissions rp
       INNER JOIN permissions p ON p.id = rp.permission_id
       INNER JOIN roles r ON r.id = rp.role_id
       WHERE r.organization_id = ?
         AND r.id = ?
         AND p.permission_scope = 'gym'
       ORDER BY p.module_name ASC, p.permission_key ASC`,
      [organizationId, roleId]
    );

    return res.json({
      success: true,
      role: {
        ...roles[0],
        id: Number(roles[0].id),
        is_system_role: Boolean(roles[0].is_system_role),
        permission_keys: permissionRows.map((row) => row.permission_key),
        permissions: permissionRows.map((row) => ({
          id: Number(row.id),
          permission_key: row.permission_key,
          module_name: row.module_name,
          description: row.description,
        })),
      },
    });
  } catch (error) {
    console.error("Get Gym role error:", error);
    return res.status(500).json({ success: false, message: "Unable to load role details." });
  }
};

const createGymRole = async (req, res) => {
  const organizationId = parsePositiveId(req.gymStaff?.organizationId);
  const userId = parsePositiveId(req.gymStaff?.userId);
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description =
    body.description == null || body.description === ""
      ? null
      : typeof body.description === "string"
        ? body.description.trim()
        : undefined;

  if (!organizationId || !userId) {
    return res.status(401).json({ success: false, message: "Invalid Gym Staff session." });
  }
  if (!name || name.length > 100 || name.toLowerCase() === "gym admin") {
    return res.status(400).json({
      success: false,
      message: "Enter a valid role name. Gym Admin is a reserved system role.",
    });
  }
  if (description === undefined || (description && description.length > 255)) {
    return res.status(400).json({ success: false, message: "Role description cannot exceed 255 characters." });
  }

  const normalized = normalizePermissionKeys(body.permission_keys);
  if (normalized.error) {
    return res.status(400).json({ success: false, message: normalized.error });
  }

  let connection;
  let transactionStarted = false;

  try {
    ensureActorMayGrant(req, normalized.keys);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [duplicates] = await connection.query(
      `SELECT id
       FROM roles
       WHERE organization_id = ? AND LOWER(name) = LOWER(?)
       LIMIT 1
       FOR UPDATE`,
      [organizationId, name]
    );

    if (duplicates.length > 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({ success: false, message: "A role with this name already exists." });
    }

    const permissionRows = await loadGymPermissionRows(connection, normalized.keys);

    const [insertResult] = await connection.query(
      `INSERT INTO roles (organization_id, name, description, is_system_role)
       VALUES (?, ?, ?, 0)`,
      [organizationId, name, description]
    );
    const roleId = Number(insertResult.insertId);

    if (permissionRows.length > 0) {
      const values = permissionRows.flatMap((permission) => [
        roleId,
        permission.id,
      ]);
      const placeholders = permissionRows.map(() => "(?, ?)").join(", ");
      await connection.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ${placeholders}`,
        values
      );
    }

    await writeRoleAuditLog(connection, req, {
      action: "ROLE_CREATED",
      roleId,
      description: `Created custom role "${name}" with ${permissionRows.length} Gym permissions.`,
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Role created successfully.",
      role: {
        id: roleId,
        name,
        description,
        is_system_role: false,
        permission_keys: normalized.keys,
      },
    });
  } catch (error) {
    await rollback(connection, transactionStarted);
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "A role with this name already exists." });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || "ROLE_VALIDATION_FAILED",
        message: error.message,
      });
    }
    console.error("Create Gym role error:", error);
    return res.status(500).json({ success: false, message: "Unable to create role." });
  } finally {
    if (connection) connection.release();
  }
};

const updateGymRole = async (req, res) => {
  const organizationId = parsePositiveId(req.gymStaff?.organizationId);
  const roleId = parsePositiveId(req.params.roleId);
  const body = req.body || {};

  if (!organizationId || !roleId) {
    return res.status(400).json({ success: false, message: "Invalid organization or role ID." });
  }

  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
  const hasPermissions = Object.prototype.hasOwnProperty.call(body, "permission_keys");

  if (!hasName && !hasDescription && !hasPermissions) {
    return res.status(400).json({ success: false, message: "No role changes were supplied." });
  }

  const name = hasName && typeof body.name === "string" ? body.name.trim() : null;
  if (hasName && (!name || name.length > 100 || name.toLowerCase() === "gym admin")) {
    return res.status(400).json({ success: false, message: "Enter a valid role name. Gym Admin is reserved." });
  }

  const description = hasDescription
    ? body.description == null || body.description === ""
      ? null
      : typeof body.description === "string"
        ? body.description.trim()
        : undefined
    : null;

  if (hasDescription && (description === undefined || (description && description.length > 255))) {
    return res.status(400).json({ success: false, message: "Role description cannot exceed 255 characters." });
  }

  let permissionKeys = null;
  if (hasPermissions) {
    const normalized = normalizePermissionKeys(body.permission_keys);
    if (normalized.error) {
      return res.status(400).json({ success: false, message: normalized.error });
    }
    permissionKeys = normalized.keys;
  }

  let connection;
  let transactionStarted = false;

  try {
    if (permissionKeys !== null) ensureActorMayGrant(req, permissionKeys);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [roleRows] = await connection.query(
      `SELECT id, name, description, is_system_role
       FROM roles
       WHERE organization_id = ? AND id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId, roleId]
    );

    if (roleRows.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ success: false, message: "Role not found." });
    }

    const oldRole = roleRows[0];
    if (Boolean(oldRole.is_system_role)) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(403).json({
        success: false,
        code: "SYSTEM_ROLE_PROTECTED",
        message: "System roles cannot be edited.",
      });
    }

    if (hasName) {
      const [duplicates] = await connection.query(
        `SELECT id
         FROM roles
         WHERE organization_id = ?
           AND LOWER(name) = LOWER(?)
           AND id <> ?
         LIMIT 1
         FOR UPDATE`,
        [organizationId, name, roleId]
      );

      if (duplicates.length > 0) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(409).json({ success: false, message: "A role with this name already exists." });
      }
    }

    let permissionRows = null;
    let oldPermissionKeys = null;
    if (permissionKeys !== null) {
      const [oldPermissionRows] = await connection.query(
        `SELECT p.permission_key
         FROM role_permissions rp
         INNER JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.permission_scope = 'gym'
         ORDER BY p.permission_key ASC`,
        [roleId]
      );
      oldPermissionKeys = oldPermissionRows.map((row) => row.permission_key);
      permissionRows = await loadGymPermissionRows(connection, permissionKeys);
    }

    const updates = [];
    const values = [];
    if (hasName) {
      updates.push("name = ?");
      values.push(name);
    }
    if (hasDescription) {
      updates.push("description = ?");
      values.push(description);
    }

    if (updates.length > 0) {
      await connection.query(
        `UPDATE roles SET ${updates.join(", ")}
         WHERE organization_id = ? AND id = ?`,
        [...values, organizationId, roleId]
      );
    }

    if (permissionRows !== null) {
      await connection.query(
        `DELETE rp
         FROM role_permissions rp
         INNER JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.permission_scope = 'gym'`,
        [roleId]
      );

      if (permissionRows.length > 0) {
        const insertValues = permissionRows.flatMap((permission) => [
          roleId,
          permission.id,
        ]);
        const placeholders = permissionRows.map(() => "(?, ?)").join(", ");
        await connection.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ${placeholders}`,
          insertValues
        );
      }
    }

    await writeRoleAuditLog(connection, req, {
      action: "ROLE_UPDATED",
      roleId,
      description: [
        `Updated custom role "${oldRole.name}".`,
        `old_values=${JSON.stringify(oldRole)}`,
        `new_values=${JSON.stringify({
          name: hasName ? name : oldRole.name,
          description: hasDescription ? description : oldRole.description,
          permission_keys: permissionKeys === null ? oldPermissionKeys : permissionKeys,
        })}`,
        `permission_changes=${JSON.stringify(
          permissionKeys === null
            ? null
            : { before: oldPermissionKeys, after: permissionKeys }
        )}`,
      ].filter(Boolean).join(" | "),
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Role updated successfully.",
      role: {
        id: roleId,
        name: hasName ? name : oldRole.name,
        description: hasDescription ? description : oldRole.description,
        is_system_role: false,
        permission_keys: permissionKeys,
      },
    });
  } catch (error) {
    await rollback(connection, transactionStarted);
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "A role with this name already exists." });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || "ROLE_VALIDATION_FAILED",
        message: error.message,
      });
    }
    console.error("Update Gym role error:", error);
    return res.status(500).json({ success: false, message: "Unable to update role." });
  } finally {
    if (connection) connection.release();
  }
};

const deleteGymRole = async (req, res) => {
  const organizationId = parsePositiveId(req.gymStaff?.organizationId);
  const roleId = parsePositiveId(req.params.roleId);

  if (!organizationId || !roleId) {
    return res.status(400).json({ success: false, message: "Invalid organization or role ID." });
  }

  let connection;
  let transactionStarted = false;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [roleRows] = await connection.query(
      `SELECT id, name, description, is_system_role
       FROM roles
       WHERE organization_id = ? AND id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId, roleId]
    );

    if (roleRows.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ success: false, message: "Role not found." });
    }

    const role = roleRows[0];
    if (Boolean(role.is_system_role)) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(403).json({
        success: false,
        code: "SYSTEM_ROLE_PROTECTED",
        message: "System roles cannot be deleted.",
      });
    }

    const [assignedRows] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM user_roles
       WHERE organization_id = ? AND role_id = ?`,
      [organizationId, roleId]
    );

    const assignedCount = Number(assignedRows[0]?.total || 0);
    if (assignedCount > 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({
        success: false,
        code: "ROLE_IN_USE",
        message: "This role is assigned to staff. Remove those assignments before deleting it.",
        assigned_user_count: assignedCount,
      });
    }

    await writeRoleAuditLog(connection, req, {
      action: "ROLE_DELETED",
      roleId,
      description: `Deleted custom role "${role.name}".`,
    });

    await connection.query(
      `DELETE FROM roles
       WHERE organization_id = ? AND id = ? AND is_system_role = 0`,
      [organizationId, roleId]
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({ success: true, message: "Role deleted successfully." });
  } catch (error) {
    await rollback(connection, transactionStarted);
    console.error("Delete Gym role error:", error);
    return res.status(500).json({ success: false, message: "Unable to delete role." });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  listGymPermissions,
  listGymRoles,
  getGymRole,
  createGymRole,
  updateGymRole,
  deleteGymRole,
};
