const jwt = require("jsonwebtoken");
const db = require("../config/db");

const authenticateGymStaff = async (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      code: "GYM_STAFF_TOKEN_REQUIRED",
      message: "Gym Staff authentication token is required",
    });
  }

  const secret = process.env.GYM_STAFF_JWT_SECRET;

  if (!secret || secret.length < 64) {
    return res.status(500).json({
      success: false,
      message: "Gym Staff authentication service is not configured",
    });
  }

  if (!req.device) {
    return res.status(500).json({
      success: false,
      message: "Device authentication must run before Gym Staff authentication",
    });
  }

  const token = authorization.slice(7).trim();

  let decoded;

  try {
    decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      code: "INVALID_GYM_STAFF_TOKEN",
      message: "Gym Staff session is invalid or expired. Please log in again.",
    });
  }

  const userId = Number(decoded.user_id);
  const organizationId = Number(decoded.organization_id);
  const deviceId = Number(decoded.device_id);
  const branchId = Number(decoded.branch_id);

  if (
    decoded.token_type !== "gym_staff" ||
    !Number.isSafeInteger(userId) || userId <= 0 ||
    !Number.isSafeInteger(organizationId) || organizationId <= 0 ||
    !Number.isSafeInteger(deviceId) || deviceId <= 0 ||
    !Number.isSafeInteger(branchId) || branchId <= 0
  ) {
    return res.status(401).json({
      success: false,
      code: "INVALID_GYM_STAFF_TOKEN",
      message: "Invalid Gym Staff session",
    });
  }

  if (
    deviceId !== Number(req.device.id) ||
    organizationId !== Number(req.device.organizationId)
  ) {
    return res.status(403).json({
      success: false,
      code: "GYM_STAFF_DEVICE_MISMATCH",
      message: "This session belongs to a different device or organization",
    });
  }

  try {
    const [users] = await db.query(
      `SELECT id, organization_id, full_name, email, status
       FROM users
       WHERE id = ?
         AND organization_id = ?
       LIMIT 1`,
      [userId, organizationId]
    );

    if (users.length === 0 || users[0].status !== "active") {
      return res.status(403).json({
        success: false,
        code: "GYM_STAFF_INACTIVE",
        message: "Your Gym Staff account is not active",
      });
    }

    const [branchRows] = await db.query(
      `SELECT b.id, b.name, b.branch_code
       FROM user_branch_access uba
       INNER JOIN branches b
         ON b.organization_id = uba.organization_id
        AND b.id = uba.branch_id
       WHERE uba.organization_id = ?
         AND uba.user_id = ?
         AND uba.branch_id = ?
         AND b.status = 'active'
       LIMIT 1`,
      [organizationId, userId, branchId]
    );

    if (branchRows.length === 0) {
      return res.status(403).json({
        success: false,
        code: "BRANCH_ACCESS_REVOKED",
        message: "Your access to the selected branch is no longer active",
      });
    }

    // Active branch comes from the Gym Staff JWT and is validated against user branch access.


    const [roleRows] = await db.query(
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
      return res.status(403).json({
        success: false,
        code: "GYM_STAFF_ROLE_NOT_ASSIGNED",
        message: "No active role is assigned to this account",
      });
    }

    const [permissionRows] = await db.query(
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

    const [accessibleBranchRows] = await db.query(
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

    const user = users[0];
    const branch = branchRows[0];

    // Never trust role or permission claims in the JWT.
    // Current values are loaded from MySQL on every request.
    req.gymStaff = {
      userId,
      organizationId,
      deviceId,
      branchId,

      user: {
        id: userId,
        full_name: user.full_name,
        email: user.email,
      },

      organization: {
        id: organizationId,
        name: req.device.organizationName,
      },

      device: {
        id: deviceId,
        name: req.device.deviceName,
      },

      branch: {
        id: branchId,
        name: branch.name,
        branch_code: branch.branch_code,
      },

      roles: roleRows.map((role) => ({
        id: Number(role.id),
        name: role.name,
        is_system_role: Boolean(role.is_system_role),
      })),

      permissions: permissionRows.map(
        (permission) => permission.permission_key
      ),

      branches: accessibleBranchRows.map((item) => ({
        id: Number(item.id),
        name: item.name,
        branch_code: item.branch_code,
      })),
    };

    return next();

  } catch (error) {
    console.error("Gym Staff authentication error:", error.message);

    return res.status(500).json({
      success: false,
      code: "GYM_STAFF_AUTHENTICATION_FAILED",
      message: "Unable to authenticate Gym Staff session",
    });
  }
};

const requireGymPermission = (permissionKey) => {
  return (req, res, next) => {
    if (
      typeof permissionKey !== "string" ||
      !permissionKey.trim()
    ) {
      return res.status(500).json({
        success: false,
        message: "Gym permission configuration is invalid",
      });
    }

    const permissions = req.gymStaff?.permissions || [];

    if (!permissions.includes(permissionKey)) {
      return res.status(403).json({
        success: false,
        code: "GYM_PERMISSION_DENIED",
        message: "You do not have permission to perform this action",
        required_permission: permissionKey,
      });
    }

    req.requiredGymPermission = permissionKey;
    return next();
  };
};

const requireGymBranchAccess = (branchIdResolver = null) => {
  return (req, res, next) => {
    if (!req.gymStaff?.branchId) {
      return res.status(401).json({
        success: false,
        code: "GYM_STAFF_BRANCH_REQUIRED",
        message: "A selected Gym Staff branch is required",
      });
    }

    let requestedBranchId = null;

    if (typeof branchIdResolver === "function") {
      requestedBranchId = branchIdResolver(req);
    } else if (typeof branchIdResolver === "string") {
      requestedBranchId = req.params?.[branchIdResolver];
    } else {
      requestedBranchId =
        req.params?.branchId ??
        req.body?.branch_id;
    }

    if (
      requestedBranchId !== null &&
      requestedBranchId !== undefined &&
      requestedBranchId !== ""
    ) {
      const parsedId = Number(requestedBranchId);

      if (
        !Number.isSafeInteger(parsedId) ||
        parsedId !== Number(req.gymStaff.branchId)
      ) {
        return res.status(403).json({
          success: false,
          code: "GYM_BRANCH_ACCESS_DENIED",
          message: "The requested branch does not match your active session",
        });
      }
    }

    return next();
  };
};

module.exports = {
  authenticateGymStaff,
  requireGymPermission,
  requireGymBranchAccess,
};