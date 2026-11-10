const db = require("../config/db");

const isValidDate = (value) => {
  if (typeof value !== "string") return false;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const parseOptionalId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : NaN;
};

// GET /api/platform-admin/audit-logs
// Read-only, paginated platform audit history.
const getPlatformAuditLogs = async (req, res) => {
  try {
    const {
      search = "",
      action,
      entityType,
      organizationId,
      platformAdminId,
      fromDate,
      toDate,
    } = req.query;

    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 25);
    const allowedLimits = [25, 50, 100];

    if (!Number.isInteger(page) || page < 1) {
      return res.status(400).json({
        success: false,
        message: "Page must be a positive integer",
      });
    }

    if (!allowedLimits.includes(limit)) {
      return res.status(400).json({
        success: false,
        message: "Limit must be 25, 50 or 100",
      });
    }

    const orgId = parseOptionalId(organizationId);
    const adminId = parseOptionalId(platformAdminId);

    if (Number.isNaN(orgId) || Number.isNaN(adminId)) {
      return res.status(400).json({
        success: false,
        message: "Organization and administrator IDs must be positive integers",
      });
    }

    const normalizedAction = action == null ? "" : String(action).trim();
    const normalizedEntityType = entityType == null ? "" : String(entityType).trim();
    const normalizedSearch = String(search).trim().slice(0, 150);
    const normalizedFromDate = fromDate == null ? "" : String(fromDate).trim();
    const normalizedToDate = toDate == null ? "" : String(toDate).trim();

    if (normalizedAction.length > 100 || normalizedEntityType.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Action and entity type filters cannot exceed 100 characters",
      });
    }

    if (normalizedFromDate && !isValidDate(normalizedFromDate)) {
      return res.status(400).json({
        success: false,
        message: "fromDate must use YYYY-MM-DD format",
      });
    }

    if (normalizedToDate && !isValidDate(normalizedToDate)) {
      return res.status(400).json({
        success: false,
        message: "toDate must use YYYY-MM-DD format",
      });
    }

    if (
      normalizedFromDate &&
      normalizedToDate &&
      normalizedFromDate > normalizedToDate
    ) {
      return res.status(400).json({
        success: false,
        message: "fromDate cannot be later than toDate",
      });
    }

    const conditions = [];
    const params = [];

    if (normalizedAction) {
      conditions.push("pal.action = ?");
      params.push(normalizedAction);
    }

    if (normalizedEntityType) {
      conditions.push("pal.entity_type = ?");
      params.push(normalizedEntityType);
    }

    if (orgId !== null) {
      conditions.push("pal.organization_id = ?");
      params.push(orgId);
    }

    if (adminId !== null) {
      conditions.push("pal.platform_admin_id = ?");
      params.push(adminId);
    }

    if (normalizedFromDate) {
      conditions.push("pal.created_at >= ?");
      params.push(`${normalizedFromDate} 00:00:00`);
    }

    if (normalizedToDate) {
      conditions.push("pal.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
      params.push(`${normalizedToDate} 00:00:00`);
    }

    if (normalizedSearch) {
      const like = `%${normalizedSearch}%`;
      conditions.push(`(
        pal.action LIKE ? OR
        COALESCE(pal.entity_type, '') LIKE ? OR
        COALESCE(pal.description, '') LIKE ? OR
        COALESCE(pal.ip_address, '') LIKE ? OR
        COALESCE(pa.full_name, '') LIKE ? OR
        COALESCE(pa.email, '') LIKE ? OR
        COALESCE(o.name, '') LIKE ? OR
        COALESCE(o.organization_code, '') LIKE ? OR
        CAST(pal.entity_id AS CHAR) LIKE ?
      )`);
      params.push(like, like, like, like, like, like, like, like, like);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const joins = `
      FROM platform_audit_logs pal
      INNER JOIN platform_admins pa
        ON pa.id = pal.platform_admin_id
      LEFT JOIN organizations o
        ON o.id = pal.organization_id
    `;

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total ${joins} ${whereClause}`,
      params
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);
    const currentPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    const offset = (currentPage - 1) * limit;

    const [auditLogs] = await db.query(
      `SELECT
         pal.id,
         pal.platform_admin_id,
         pa.full_name AS platform_admin_name,
         pa.email AS platform_admin_email,
         pal.organization_id,
         o.name AS organization_name,
         o.organization_code,
         pal.action,
         pal.entity_type,
         pal.entity_id,
         pal.description,
         pal.old_values,
         pal.new_values,
         pal.ip_address,
         pal.user_agent,
         pal.created_at
       ${joins}
       ${whereClause}
       ORDER BY pal.created_at DESC, pal.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [actionRows] = await db.query(
      `SELECT DISTINCT action
       FROM platform_audit_logs
       ORDER BY action ASC`
    );

    const [entityRows] = await db.query(
      `SELECT DISTINCT entity_type
       FROM platform_audit_logs
       WHERE entity_type IS NOT NULL AND entity_type <> ''
       ORDER BY entity_type ASC`
    );

    return res.json({
      success: true,
      auditLogs,
      pagination: {
        page: currentPage,
        limit,
        total,
        totalPages,
        hasPreviousPage: currentPage > 1,
        hasNextPage: currentPage < totalPages,
      },
      actions: actionRows.map((row) => row.action),
      entityTypes: entityRows.map((row) => row.entity_type),
      filters: {
        search: normalizedSearch,
        action: normalizedAction || "all",
        entityType: normalizedEntityType || "all",
        organizationId: orgId,
        platformAdminId: adminId,
        fromDate: normalizedFromDate || null,
        toDate: normalizedToDate || null,
      },
    });
  } catch (error) {
    console.error("Get platform audit logs error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load platform audit logs",
    });
  }
};

module.exports = {
  getPlatformAuditLogs,
};
