const jwt = require("jsonwebtoken");
const db = require("../config/db");

const authenticatePlatformAdmin = async (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
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
      message: "Invalid or expired authentication token",
    });
  }

  if (
    decoded.role !== "platform_admin" ||
    !decoded.platform_admin_id
  ) {
    return res.status(403).json({
      success: false,
      message: "Platform Admin access is required",
    });
  }

  try {
    const [admins] = await db.query(
      `SELECT id, status
       FROM platform_admins
       WHERE id = ?
       LIMIT 1`,
      [decoded.platform_admin_id]
    );

    if (admins.length === 0 || admins[0].status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Your Platform Admin account is not active",
      });
    }

    req.platformAdmin = {
      id: admins[0].id,
      email: decoded.email,
    };

    next();
  } catch (error) {
    console.error("Platform Admin authentication error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to authenticate Platform Admin",
    });
  }
};

module.exports = {
  authenticatePlatformAdmin,
};
