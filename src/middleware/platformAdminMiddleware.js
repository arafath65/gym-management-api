
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const authenticatePlatformAdmin = async (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      code: "AUTH_TOKEN_REQUIRED",
      message: "Authentication token is required",
    });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      success: false,
      message: "Authentication service is not configured",
    });
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication token is required",
    });
  }

  let decoded;

  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({
      success: false,
      code: "INVALID_AUTH_TOKEN",
      message: "Invalid or expired authentication token",
    });
  }

  const platformAdminId = Number(decoded.platform_admin_id);

  if (
    decoded.role !== "platform_admin" ||
    !Number.isSafeInteger(platformAdminId) ||
    platformAdminId <= 0
  ) {
    return res.status(403).json({
      success: false,
      message: "Platform Admin access is required",
    });
  }

  try {
    const [admins] = await db.query(
      `SELECT id, full_name, email, status
       FROM platform_admins
       WHERE id = ?
       LIMIT 1`,
      [platformAdminId]
    );

    if (admins.length === 0 || admins[0].status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Your Platform Admin account is not active",
      });
    }

    // Load currently assigned permissions from the database.
    // Do not trust permissions stored in the JWT.
    const [permissionRows] = await db.query(
      `SELECT DISTINCT pp.permission_key
       FROM platform_admin_roles par
       INNER JOIN platform_role_permissions prp
         ON prp.platform_role_id = par.platform_role_id
       INNER JOIN platform_permissions pp
         ON pp.id = prp.permission_id
       WHERE par.platform_admin_id = ?
       ORDER BY pp.permission_key ASC`,
      [platformAdminId]
    );

    req.platformAdmin = {
      id: admins[0].id,
      fullName: admins[0].full_name,
      email: admins[0].email,
      permissions: permissionRows.map((row) => row.permission_key),
    };

    return next();
  } catch (error) {
    console.error("Platform Admin authentication error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to authenticate Platform Admin",
    });
  }
};

/**
 * Backend authorization middleware.
 *
 * Accepts either:
 *   requirePlatformPermission("branches.view")
 *
 * Or a resolver:
 *   requirePlatformPermission((req) => ...)
 */
const requirePlatformPermission = (permissionResolver) => {
  return (req, res, next) => {
    const permissionKey =
      typeof permissionResolver === "function"
        ? permissionResolver(req)
        : permissionResolver;

    if (
      typeof permissionKey !== "string" ||
      permissionKey.trim().length === 0
    ) {
      return res.status(500).json({
        success: false,
        message: "Platform permission configuration is invalid",
      });
    }

    const grantedPermissions = req.platformAdmin?.permissions || [];

    if (!grantedPermissions.includes(permissionKey)) {
      return res.status(403).json({
        success: false,
        code: "PLATFORM_PERMISSION_DENIED",
        message: "You do not have permission to perform this action",
        required_permission: permissionKey,
      });
    }

    req.requiredPlatformPermission = permissionKey;

    return next();
  };
};

module.exports = {
  authenticatePlatformAdmin,
  requirePlatformPermission,
};
