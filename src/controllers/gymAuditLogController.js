const db = require("../config/db");

const parsePositiveInteger = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const isValidDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const parseDescription = (value) => {
  const raw = typeof value === "string" ? value : "";
  const markers = [" | old_values=", " | new_values="];
  const positions = markers
    .map((marker) => ({ marker, index: raw.indexOf(marker) }))
    .filter((item) => item.index >= 0);

  const messageEnd = positions.length > 0
    ? Math.min(...positions.map((item) => item.index))
    : raw.length;

  const extractJson = (marker, nextMarker) => {
    const start = raw.indexOf(marker);
    if (start < 0) return null;

    const valueStart = start + marker.length;
    const next = nextMarker ? raw.indexOf(nextMarker, valueStart) : -1;
    const jsonText = raw.slice(valueStart, next < 0 ? raw.length : next).trim();

    try {
      const parsed = JSON.parse(jsonText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch (_) {
      return null;
    }
  };

  return {
    message: raw.slice(0, messageEnd).trim() || "Activity recorded.",
    old_values: extractJson(" | old_values=", " | new_values="),
    new_values: extractJson(" | new_values=", null),
  };
};

const getGymAuditLogs = async (req, res) => {
  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.page_size ?? 20);

    if (
      !Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Page must be positive and page_size must be between 1 and 100.",
      });
    }

    const isGymAdmin = (req.gymStaff.roles || []).some(
      (role) => role.name === "Gym Admin" && role.is_system_role === true,
    );

    // Gym Admin can review organization-wide activity. Other permitted staff
    // remain restricted to their authenticated active branch.
    const visibilityFilters = ["al.organization_id = ?"];
    const visibilityParams = [organizationId];
    if (!isGymAdmin) {
      visibilityFilters.push("al.branch_id = ?");
      visibilityParams.push(Number(req.gymStaff.branchId));
    }

    const filters = [...visibilityFilters];
    const params = [...visibilityParams];

    const search = req.query.search;
    if (search !== undefined) {
      if (typeof search !== "string" || search.trim().length > 100) {
        return res.status(400).json({
          success: false,
          message: "Search must not exceed 100 characters.",
        });
      }

      if (search.trim()) {
        const term = `%${search.trim()}%`;
        filters.push(`(
          al.action LIKE ? OR al.entity_type LIKE ? OR al.description LIKE ?
          OR u.full_name LIKE ? OR b.name LIKE ?
        )`);
        params.push(term, term, term, term, term);
      }
    }

    for (const [queryKey, column] of [
      ["action", "al.action"],
      ["entity_type", "al.entity_type"],
    ]) {
      const value = req.query[queryKey];
      if (value !== undefined && value !== "all" && value !== "") {
        if (typeof value !== "string" || value.length > 100) {
          return res.status(400).json({
            success: false,
            message: `Invalid ${queryKey} filter.`,
          });
        }
        filters.push(`${column} = ?`);
        params.push(value);
      }
    }

    if (req.query.user_id !== undefined && req.query.user_id !== "all" && req.query.user_id !== "") {
      const userId = parsePositiveInteger(req.query.user_id);
      if (!userId) {
        return res.status(400).json({
          success: false,
          message: "Invalid user filter.",
        });
      }
      filters.push("al.user_id = ?");
      params.push(userId);
    }

    const dateFrom = req.query.date_from;
    const dateTo = req.query.date_to;

    if (dateFrom !== undefined && dateFrom !== "") {
      if (!isValidDate(dateFrom)) {
        return res.status(400).json({ success: false, message: "Invalid start date." });
      }
      filters.push("al.created_at >= ?");
      params.push(`${dateFrom} 00:00:00`);
    }

    if (dateTo !== undefined && dateTo !== "") {
      if (!isValidDate(dateTo)) {
        return res.status(400).json({ success: false, message: "Invalid end date." });
      }
      filters.push("al.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
      params.push(`${dateTo} 00:00:00`);
    }

    if (dateFrom && dateTo && dateFrom > dateTo) {
      return res.status(400).json({
        success: false,
        message: "Start date cannot be later than end date.",
      });
    }

    const joins = `
      FROM audit_logs al
      LEFT JOIN users u
        ON u.organization_id = al.organization_id
       AND u.id = al.user_id
      LEFT JOIN branches b
        ON b.organization_id = al.organization_id
       AND b.id = al.branch_id
    `;
    const whereSql = `WHERE ${filters.join(" AND ")}`;

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total ${joins} ${whereSql}`,
      params,
    );

    const total = Number(countRows[0].total);
    const offset = (page - 1) * pageSize;

    const [rows] = await db.query(
      `SELECT
         al.id,
         al.organization_id,
         al.branch_id,
         b.name AS branch_name,
         al.user_id,
         COALESCE(u.full_name, CASE
           WHEN al.user_id IS NULL THEN 'System'
           ELSE CONCAT('User #', al.user_id)
         END) AS user_name,
         al.action,
         al.entity_type,
         al.entity_id,
         al.description,
         al.created_at
       ${joins}
       ${whereSql}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );

    // Filter options are also restricted to the signed-in organization.
    const visibilitySql = `WHERE ${visibilityFilters.join(" AND ")}`;

    const [actionRows] = await db.query(
      `SELECT DISTINCT action
       FROM audit_logs al
       ${visibilitySql}
       ORDER BY action ASC
       LIMIT 100`,
      visibilityParams,
    );

    const [entityRows] = await db.query(
      `SELECT DISTINCT entity_type
       FROM audit_logs al
       ${visibilitySql}
         AND entity_type IS NOT NULL
         AND entity_type <> ''
       ORDER BY entity_type ASC
       LIMIT 100`,
      visibilityParams,
    );

    const [userRows] = await db.query(
      `SELECT DISTINCT
         al.user_id,
         COALESCE(u.full_name, CONCAT('User #', al.user_id)) AS user_name
       FROM audit_logs al
       LEFT JOIN users u
         ON u.organization_id = al.organization_id
        AND u.id = al.user_id
       ${visibilitySql}
         AND al.user_id IS NOT NULL
       ORDER BY user_name ASC
       LIMIT 200`,
      visibilityParams,
    );

    return res.json({
      success: true,
      logs: rows.map((row) => {
        const parsed = parseDescription(row.description);
        return {
          id: Number(row.id),
          organization_id: Number(row.organization_id),
          branch_id: row.branch_id == null ? null : Number(row.branch_id),
          branch_name: row.branch_name,
          user_id: row.user_id == null ? null : Number(row.user_id),
          user_name: row.user_name,
          action: row.action,
          entity_type: row.entity_type,
          entity_id: row.entity_id == null ? null : Number(row.entity_id),
          message: parsed.message,
          old_values: parsed.old_values,
          new_values: parsed.new_values,
          created_at: row.created_at,
        };
      }),
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      },
      filter_options: {
        actions: actionRows.map((row) => row.action),
        entity_types: entityRows.map((row) => row.entity_type),
        users: userRows.map((row) => ({
          id: Number(row.user_id),
          name: row.user_name,
        })),
      },
    });
  } catch (error) {
    console.error("Get Gym Audit Logs error:", error);
    return res.status(500).json({
      success: false,
      code: "GYM_AUDIT_LOGS_SERVER_ERROR",
      message: "Unable to load audit logs.",
    });
  }
};

module.exports = { getGymAuditLogs };