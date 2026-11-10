const db = require("../config/db");

const getPlatformDashboardStats = async (req, res) => {
  try {
    const [
      [deviceCounts],
      [licenseCounts],
      [pendingDeviceCounts],
    ] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS active_devices
         FROM devices
         WHERE status = 'active'`
      ),

      db.query(
        `SELECT COUNT(*) AS active_licenses
         FROM licenses l
         WHERE l.id = (
           SELECT l2.id
           FROM licenses l2
           WHERE l2.organization_id = l.organization_id
           ORDER BY l2.created_at DESC, l2.id DESC
           LIMIT 1
         )
         AND l.license_status = 'active'
         AND l.starts_at <= NOW()
         AND (l.expires_at IS NULL OR l.expires_at >= NOW())`
      ),

      db.query(
        `SELECT COUNT(*) AS pending_devices
         FROM devices
         WHERE status = 'pending'`
      ),
    ]);

    return res.json({
      success: true,
      stats: {
        active_devices: Number(deviceCounts[0].active_devices),
        active_licenses: Number(licenseCounts[0].active_licenses),
        pending_devices: Number(pendingDeviceCounts[0].pending_devices),
      },
    });
  } catch (error) {
    console.error("Platform dashboard stats error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve dashboard statistics",
    });
  }
};

module.exports = {
  getPlatformDashboardStats,
};
