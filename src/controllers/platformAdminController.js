
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const loginPlatformAdmin = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is not configured");

      return res.status(500).json({
        success: false,
        message: "Authentication service is not configured",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const [admins] = await db.query(
      `SELECT id, full_name, email, password_hash, status
       FROM platform_admins
       WHERE email = ?
       LIMIT 1`,
      [normalizedEmail]
    );

    if (admins.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const admin = admins[0];

    if (admin.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Your Super Admin account is not active",
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    await db.query(
      `UPDATE platform_admins
       SET last_login_at = NOW()
       WHERE id = ?`,
      [admin.id]
    );

    const token = jwt.sign(
      {
        platform_admin_id: admin.id,
        email: admin.email,
        role: "platform_admin",
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "12h",
      }
    );

    return res.json({
      success: true,
      message: "Super Admin login successful",
      admin: {
        id: admin.id,
        full_name: admin.full_name,
        email: admin.email,
      },
      token,
      expires_in: "12h",
    });
  } catch (error) {
    console.error("Platform Admin login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed",
    });
  }
};

module.exports = {
  loginPlatformAdmin,
};
