const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const getGymStaffSecret = () => {
  const secret = process.env.GYM_STAFF_JWT_SECRET;

  if (!secret || secret.length < 64) {
    throw new Error("GYM_STAFF_JWT_SECRET is missing or too short");
  }

  return secret;
};

const authError = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const parseBranchId = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const getAccessibleBranches = async (
  executor,
  organizationId,
  userId
) => {
  const [rows] = await executor.query(
    `SELECT b.id, b.name, b.branch_code
     FROM user_branch_access uba
     INNER JOIN branches b
       ON b.organization_id = uba.organization_id
      AND b.id = uba.branch_id
     WHERE uba.organization_id = ?
       AND uba.user_id = ?
       AND b.status = 'active'
     ORDER BY b.name ASC, b.id ASC`,
    [organizationId, userId]
  );

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    branch_code: row.branch_code,
  }));
};

/**
 * Creates a Gym Staff session.
 *
 * User status, selected branch access, roles and permissions
 * are checked against the database before a session is issued.
 */
const createGymStaffSession = async ({
  userId,
  organizationId,
  branchId,
  req,
  auditAction = "GYM_STAFF_LOGIN",
  previousBranchId = null,
}) => {
  const secret = getGymStaffSecret();

  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const [users] = await connection.query(
      `SELECT id, organization_id, full_name, email, status
       FROM users
       WHERE id = ?
         AND organization_id = ?
       LIMIT 1
       FOR UPDATE`,
      [userId, organizationId]
    );

    if (users.length === 0 || users[0].status !== "active") {
      throw authError(
        "Gym Staff account is not active",
        403,
        "GYM_STAFF_INACTIVE"
      );
    }

    const user = users[0];

    const deviceId = Number(req.device.id);
    const selectedBranchId = Number(branchId);

    if (
      !Number.isSafeInteger(Number(user.id)) ||
      !Number.isSafeInteger(Number(organizationId)) ||
      !Number.isSafeInteger(deviceId) ||
      !Number.isSafeInteger(selectedBranchId) ||
      selectedBranchId <= 0
    ) {
      throw authError(
        "Invalid authentication identifiers",
        400,
        "INVALID_AUTH_IDENTIFIERS"
      );
    }

    const [branchRows] = await connection.query(
      `SELECT b.id, b.name, b.branch_code
       FROM user_branch_access uba
       INNER JOIN branches b
         ON b.organization_id = uba.organization_id
        AND b.id = uba.branch_id
       WHERE uba.organization_id = ?
         AND uba.user_id = ?
         AND uba.branch_id = ?
         AND b.status = 'active'
       LIMIT 1
       FOR UPDATE`,
      [organizationId, userId, selectedBranchId]
    );

    if (branchRows.length === 0) {
      throw authError(
        "You do not have access to this active branch",
        403,
        "BRANCH_ACCESS_DENIED"
      );
    }

    // Device identity remains bound to its registered organization.
    // Its registered branch is a default, not a permanent session restriction.
    const registeredBranchId = req.device.registeredBranchId;

    const [roleRows] = await connection.query(
      `SELECT DISTINCT r.id, r.name, r.is_system_role
       FROM user_roles ur
       INNER JOIN roles r
         ON r.organization_id = ur.organization_id
        AND r.id = ur.role_id
       WHERE ur.organization_id = ?
         AND ur.user_id = ?
       ORDER BY r.name ASC`,
      [organizationId, userId]
    );

    if (roleRows.length === 0) {
      throw authError(
        "No active role is assigned to this account",
        403,
        "GYM_STAFF_ROLE_NOT_ASSIGNED"
      );
    }

    const [permissionRows] = await connection.query(
      `SELECT DISTINCT p.permission_key
       FROM user_roles ur
       INNER JOIN role_permissions rp
         ON rp.role_id = ur.role_id
       INNER JOIN permissions p
         ON p.id = rp.permission_id
       WHERE ur.organization_id = ?
         AND ur.user_id = ?
       ORDER BY p.permission_key ASC`,
      [organizationId, userId]
    );

    const branches = await getAccessibleBranches(
      connection,
      organizationId,
      userId
    );

    const branch = branchRows[0];

    // Permissions and roles are deliberately not embedded in the JWT.
    const token = jwt.sign(
      {
        token_type: "gym_staff",
        user_id: Number(userId),
        organization_id: Number(organizationId),
        device_id: deviceId,
        branch_id: selectedBranchId,
      },
      secret,
      {
        expiresIn: "8h",
        algorithm: "HS256",
      }
    );

    await connection.query(
      `UPDATE users
       SET last_login_at = NOW()
       WHERE id = ?
         AND organization_id = ?`,
      [userId, organizationId]
    );

    await connection.query(
      `UPDATE devices
       SET last_seen_at = NOW()
       WHERE id = ?
         AND organization_id = ?
         AND status = 'active'`,
      [deviceId, organizationId]
    );

    await connection.query(
      `INSERT INTO audit_logs
       (
         organization_id,
         branch_id,
         user_id,
         action,
         entity_type,
         entity_id,
         description,
         ip_address,
         user_agent
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        organizationId,
        selectedBranchId,
        userId,
        auditAction,
        "user",
        userId,
        auditAction === "GYM_STAFF_BRANCH_SWITCH"
          ? `Gym Staff switched active branch from ${previousBranchId} to ${selectedBranchId} using device ${req.device.deviceName || deviceId}`
          : `Gym Staff logged in using device ${req.device.deviceName || deviceId}`,
        req.ip || null,
        req.get("user-agent")
          ? req.get("user-agent").substring(0, 500)
          : null,
      ]
    );

    await connection.commit();
    transactionStarted = false;

    return {
      success: true,
      message: "Gym Staff login successful",
      token,
      token_type: "Bearer",
      expires_in: "8h",

      user: {
        id: Number(user.id),
        full_name: user.full_name,
        email: user.email,
      },

      organization: {
        id: Number(organizationId),
        name: req.device.organizationName,
      },

      device: {
        id: deviceId,
        name: req.device.deviceName,
        registered_branch_id:
          registeredBranchId == null
            ? null
            : Number(registeredBranchId),
      },

      branch: {
        id: Number(branch.id),
        name: branch.name,
        branch_code: branch.branch_code,
      },

      branches,

      roles: roleRows.map((role) => ({
        id: Number(role.id),
        name: role.name,
        is_system_role: Boolean(role.is_system_role),
      })),

      permissions: permissionRows.map(
        (permission) => permission.permission_key
      ),
    };

  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Gym Staff login rollback failed:",
          rollbackError.message
        );
      }
    }

    throw error;
  } finally {
    connection.release();
  }
};

/**
 * Login using the organization identified by the authenticated device.
 */
const loginGymStaff = async (req, res) => {
  try {
    const secret = getGymStaffSecret();

    const body = req.body || {};
    const email = body.email;
    const password = body.password;

    if (
      typeof email !== "string" ||
      !email.trim() ||
      email.trim().length > 150 ||
      typeof password !== "string" ||
      !password ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid email and password are required",
      });
    }

    if (!req.device || !req.device.organizationId) {
      return res.status(401).json({
        success: false,
        message: "A valid registered device is required",
      });
    }

    const organizationId = Number(req.device.organizationId);

    if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid device organization",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Never accept organization_id from the login request.
    const [users] = await db.query(
      `SELECT
         id,
         organization_id,
         full_name,
         email,
         password_hash,
         status
       FROM users
       WHERE organization_id = ?
         AND email = ?
       LIMIT 1`,
      [organizationId, normalizedEmail]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
      });
    }

    const user = users[0];

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
      });
    }

    if (user.status !== "active") {
      return res.status(403).json({
        success: false,
        code: "GYM_STAFF_INACTIVE",
        message: "Your Gym Staff account is not active",
      });
    }

    const branches = await getAccessibleBranches(
      db,
      organizationId,
      Number(user.id)
    );

    if (branches.length === 0) {
      return res.status(403).json({
        success: false,
        code: "BRANCH_ACCESS_DENIED",
        message: "No active branch access is assigned to this account",
      });
    }

    const hasRequestedBranch =
      body.branch_id !== undefined &&
      body.branch_id !== null &&
      body.branch_id !== "";

    const requestedBranchId = hasRequestedBranch
      ? parseBranchId(body.branch_id)
      : null;

    if (hasRequestedBranch && requestedBranchId === null) {
      return res.status(400).json({
        success: false,
        code: "INVALID_BRANCH_ID",
        message: "Invalid branch ID",
      });
    }

    const registeredBranchId =
      req.device.registeredBranchId == null
        ? null
        : Number(req.device.registeredBranchId);

    let selectedBranchId = null;

    if (registeredBranchId !== null) {
      if (
        requestedBranchId !== null &&
        requestedBranchId !== registeredBranchId
      ) {
        return res.status(403).json({
          success: false,
          code: "DEVICE_BRANCH_MISMATCH",
          message: "This device is registered to a different branch",
        });
      }

      const hasAccess = branches.some(
        (branch) => branch.id === registeredBranchId
      );

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          code: "DEVICE_BRANCH_ACCESS_DENIED",
          message: "Your account does not have access to this device's registered branch",
        });
      }

      selectedBranchId = registeredBranchId;

    } else if (requestedBranchId !== null) {
      const hasAccess = branches.some(
        (branch) => branch.id === requestedBranchId
      );

      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          code: "BRANCH_ACCESS_DENIED",
          message: "You do not have access to the selected branch",
        });
      }

      selectedBranchId = requestedBranchId;

    } else if (branches.length === 1) {
      selectedBranchId = branches[0].id;

    } else {
      const selectionToken = jwt.sign(
        {
          token_type: "gym_branch_selection",
          user_id: Number(user.id),
          organization_id: organizationId,
          device_id: Number(req.device.id),
        },
        secret,
        {
          expiresIn: "5m",
          algorithm: "HS256",
        }
      );

      return res.json({
        success: true,
        requires_branch_selection: true,
        message: "Select a branch to continue",
        selection_token: selectionToken,
        selection_expires_in: "5m",

        user: {
          id: Number(user.id),
          full_name: user.full_name,
          email: user.email,
        },

        organization: {
          id: organizationId,
          name: req.device.organizationName,
        },

        branches,
      });
    }

    const session = await createGymStaffSession({
      userId: Number(user.id),
      organizationId,
      branchId: selectedBranchId,
      req,
    });

    return res.json(session);

  } catch (error) {
    console.error("Gym Staff login error:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || "GYM_STAFF_LOGIN_FAILED",
      message: error.statusCode
        ? error.message
        : "Gym Staff login failed",
    });
  }
};

/**
 * Completes a branch selection using the short-lived token.
 */
const selectGymStaffBranch = async (req, res) => {
  try {
    const secret = getGymStaffSecret();

    const selectionToken = req.body?.selection_token;
    const branchId = parseBranchId(req.body?.branch_id);

    if (
      typeof selectionToken !== "string" ||
      !selectionToken.trim() ||
      branchId === null
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_BRANCH_SELECTION",
        message: "Selection token and valid branch ID are required",
      });
    }

    let decoded;

    try {
      decoded = jwt.verify(
        selectionToken,
        secret,
        {
          algorithms: ["HS256"],
        }
      );
    } catch (error) {
      return res.status(401).json({
        success: false,
        code: "INVALID_BRANCH_SELECTION_TOKEN",
        message: "Branch selection has expired. Please log in again.",
      });
    }

    if (
      decoded.token_type !== "gym_branch_selection" ||
      Number(decoded.device_id) !== Number(req.device.id) ||
      Number(decoded.organization_id) !== Number(req.device.organizationId) ||
      !Number.isSafeInteger(Number(decoded.user_id))
    ) {
      return res.status(401).json({
        success: false,
        code: "BRANCH_SELECTION_DEVICE_MISMATCH",
        message: "Invalid branch selection session",
      });
    }

    const session = await createGymStaffSession({
      userId: Number(decoded.user_id),
      organizationId: Number(decoded.organization_id),
      branchId,
      req,
    });

    return res.json(session);

  } catch (error) {
    console.error("Gym Staff branch selection error:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || "BRANCH_SELECTION_FAILED",
      message: error.statusCode
        ? error.message
        : "Unable to select branch",
    });
  }
};

/**
 * Switch the active working branch for the current Gym Staff session.
 *
 * Device identity and organization remain unchanged.
 * The requested branch is revalidated against user_branch_access.
 * A new JWT is issued with the selected branch ID.
 */
const switchGymStaffBranch = async (req, res) => {
  try {
    if (!req.gymStaff) {
      return res.status(401).json({
        success: false,
        code: "GYM_STAFF_SESSION_REQUIRED",
        message: "Gym Staff session is required",
      });
    }

    const branchId = parseBranchId(req.body?.branch_id);

    if (branchId === null) {
      return res.status(400).json({
        success: false,
        code: "INVALID_BRANCH_ID",
        message: "A valid branch ID is required",
      });
    }

    const previousBranchId = Number(req.gymStaff.branchId);

    if (previousBranchId === branchId) {
      return res.status(400).json({
        success: false,
        code: "BRANCH_ALREADY_SELECTED",
        message: "This branch is already active",
      });
    }

    const session = await createGymStaffSession({
      userId: Number(req.gymStaff.userId),
      organizationId: Number(req.gymStaff.organizationId),
      branchId,
      req,
      auditAction: "GYM_STAFF_BRANCH_SWITCH",
      previousBranchId,
    });

    return res.json({
      ...session,
      message: "Active branch changed successfully",
    });

  } catch (error) {
    console.error("Gym Staff branch switch error:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || "BRANCH_SWITCH_FAILED",
      message: error.statusCode
        ? error.message
        : "Unable to switch active branch",
    });
  }
};
const getGymStaffMe = async (req, res) => {
  return res.json({
    success: true,
    staff: req.gymStaff,
  });
};

module.exports = {
  loginGymStaff,
  selectGymStaffBranch,
  switchGymStaffBranch,
  getGymStaffMe,
};