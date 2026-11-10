
const db = require("../config/db");

const checkOrganizationLicense = async (req, res, next) => {
  try {
    const organizationId =
      req.params.organizationId ||
      req.body.organizationId ||
      req.body.organization_id;

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: "Organization ID is required",
      });
    }

    const [licenses] = await db.query(
      `SELECT
          id,
          organization_id,
          license_type,
          license_status,
          starts_at,
          expires_at,
          max_devices
       FROM licenses
       WHERE organization_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [organizationId]
    );

    if (licenses.length === 0) {
      return res.status(403).json({
        success: false,
        code: "LICENSE_NOT_FOUND",
        message: "No license found for this organization",
      });
    }

    const license = licenses[0];
    const now = new Date();

    if (license.license_status !== "active") {
      return res.status(403).json({
        success: false,
        code: "LICENSE_INACTIVE",
        message: "This organization's license is not active",
      });
    }

    if (new Date(license.starts_at) > now) {
      return res.status(403).json({
        success: false,
        code: "LICENSE_NOT_STARTED",
        message: "This organization's license has not started yet",
      });
    }

    if (license.expires_at && new Date(license.expires_at) < now) {
      return res.status(403).json({
        success: false,
        code: "LICENSE_EXPIRED",
        message: "This organization's license has expired",
      });
    }

    req.organizationLicense = license;

    next();
  } catch (error) {
    console.error("License check error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to verify organization license",
    });
  }
};

module.exports = {
  checkOrganizationLicense,
};
