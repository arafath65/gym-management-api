const db = require("../config/db");

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const isSystemGymAdmin = (req) =>
  (req.gymStaff?.roles || []).some(
    (role) => role.name === "Gym Admin" && role.is_system_role === true
  );

const rollback = async (connection, transactionStarted) => {
  if (connection && transactionStarted) {
    try {
      await connection.rollback();
    } catch (error) {
      console.error("Device branch transfer rollback error:", error.message);
    }
  }
};

const listGymDevices = async (req, res) => {
  if (!isSystemGymAdmin(req)) {
    return res.status(403).json({
      success: false,
      code: "GYM_OWNER_REQUIRED",
      message: "Only the Gym Owner can view registered device assignments.",
    });
  }

  try {
    const organizationId = parsePositiveId(req.gymStaff?.organizationId);
    if (!organizationId) {
      return res.status(401).json({ success: false, message: "Invalid Gym Staff organization session." });
    }

    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search.length > 100) {
      return res.status(400).json({ success: false, message: "Search cannot exceed 100 characters." });
    }

    const conditions = ["d.organization_id = ?"];
    const params = [organizationId];
    if (search) {
      conditions.push(`CONCAT_WS(' ', d.device_name, d.device_uuid,
        d.device_type, d.status, b.name, b.branch_code) LIKE ?`);
      params.push(`%${search}%`);
    }

    const [devices] = await db.query(
      `SELECT
         d.id,
         d.organization_id,
         d.registered_branch_id,
         d.device_uuid,
         d.device_name,
         d.device_type,
         d.status,
         d.last_seen_at,
         d.created_at,
         d.updated_at,
         b.name AS registered_branch_name,
         b.branch_code AS registered_branch_code
       FROM devices d
       LEFT JOIN branches b
         ON b.organization_id = d.organization_id
        AND b.id = d.registered_branch_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY d.created_at DESC, d.id DESC`,
      params
    );

    return res.json({ success: true, devices });
  } catch (error) {
    console.error("List Gym devices error:", error);
    return res.status(500).json({ success: false, message: "Unable to load registered devices." });
  }
};

const getDeviceBranchTransferHistory = async (req, res) => {
  if (!isSystemGymAdmin(req)) {
    return res.status(403).json({
      success: false,
      code: "GYM_OWNER_REQUIRED",
      message: "Only the Gym Owner can review device branch history.",
    });
  }

  try {
    const organizationId = parsePositiveId(req.gymStaff?.organizationId);
    const deviceId = parsePositiveId(req.params.deviceId);
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.page_size ?? 50);

    if (!organizationId || !deviceId) {
      return res.status(400).json({ success: false, message: "Invalid organization or device ID." });
    }
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return res.status(400).json({ success: false, message: "Invalid history pagination." });
    }

    const [deviceRows] = await db.query(
      `SELECT id, device_name, device_uuid
       FROM devices
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
      [deviceId, organizationId]
    );
    if (deviceRows.length === 0) {
      return res.status(404).json({ success: false, message: "Device not found in this organization." });
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM device_branch_transfer_history
       WHERE organization_id = ? AND device_id = ?`,
      [organizationId, deviceId]
    );
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * pageSize;

    const [history] = await db.query(
      `SELECT
         h.id,
         h.device_id,
         h.from_branch_id,
         h.from_branch_name,
         h.from_branch_code,
         h.to_branch_id,
         h.to_branch_name,
         h.to_branch_code,
         h.transferred_by_user_id,
         u.full_name AS transferred_by_name,
         h.reason,
         h.transferred_at
       FROM device_branch_transfer_history h
       INNER JOIN users u
         ON u.organization_id = h.organization_id
        AND u.id = h.transferred_by_user_id
       WHERE h.organization_id = ? AND h.device_id = ?
       ORDER BY h.transferred_at DESC, h.id DESC
       LIMIT ? OFFSET ?`,
      [organizationId, deviceId, pageSize, offset]
    );

    return res.json({
      success: true,
      device: {
        id: Number(deviceRows[0].id),
        name: deviceRows[0].device_name,
        uuid: deviceRows[0].device_uuid,
      },
      history,
      pagination: { page: currentPage, page_size: pageSize, total, total_pages: totalPages },
    });
  } catch (error) {
    console.error("Get device branch history error:", error);
    return res.status(500).json({ success: false, message: "Unable to load device transfer history." });
  }
};

const transferDeviceBranch = async (req, res) => {
  if (!isSystemGymAdmin(req)) {
    return res.status(403).json({
      success: false,
      code: "GYM_OWNER_REQUIRED",
      message: "Only the Gym Owner can assign or transfer device branches.",
    });
  }

  const organizationId = parsePositiveId(req.gymStaff?.organizationId);
  const userId = parsePositiveId(req.gymStaff?.userId);
  const deviceId = parsePositiveId(req.params.deviceId);
  const destinationBranchId = parsePositiveId(req.body?.branch_id);
  const rawReason = req.body?.reason;

  if (!organizationId || !userId || !deviceId || !destinationBranchId) {
    return res.status(400).json({ success: false, message: "A valid device ID and destination branch ID are required." });
  }
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== "string") {
    return res.status(400).json({ success: false, message: "Transfer reason must be text." });
  }
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (reason.length > 500) {
    return res.status(400).json({ success: false, message: "Transfer reason cannot exceed 500 characters." });
  }

  let connection;
  let transactionStarted = false;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [deviceRows] = await connection.query(
      `SELECT id, organization_id, registered_branch_id,
              device_name, device_uuid, device_type, status
       FROM devices
       WHERE id = ? AND organization_id = ?
       LIMIT 1
       FOR UPDATE`,
      [deviceId, organizationId]
    );

    if (deviceRows.length === 0) {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ success: false, message: "Device not found in this organization." });
    }
    const device = deviceRows[0];
    if (device.status === "revoked") {
      await connection.rollback(); transactionStarted = false;
      return res.status(409).json({ success: false, message: "A revoked device cannot be assigned. Reactivate it first." });
    }

    const currentBranchId = device.registered_branch_id == null ? null : Number(device.registered_branch_id);
    if (currentBranchId === destinationBranchId) {
      await connection.rollback(); transactionStarted = false;
      return res.status(409).json({ success: false, message: "This device is already assigned to the selected branch." });
    }

    const [destinationRows] = await connection.query(
      `SELECT id, name, branch_code, status
       FROM branches
       WHERE id = ? AND organization_id = ?
       LIMIT 1
       FOR UPDATE`,
      [destinationBranchId, organizationId]
    );
    if (destinationRows.length === 0 || destinationRows[0].status !== "active") {
      await connection.rollback(); transactionStarted = false;
      return res.status(404).json({ success: false, message: "Select an active branch belonging to this gym." });
    }
    const destination = destinationRows[0];

    let source = null;
    if (currentBranchId !== null) {
      const [sourceRows] = await connection.query(
        `SELECT id, name, branch_code
         FROM branches
         WHERE id = ? AND organization_id = ?
         LIMIT 1`,
        [currentBranchId, organizationId]
      );
      source = sourceRows[0] || null;
    }

    await connection.query(
      `INSERT INTO device_branch_transfer_history
       (organization_id, device_id,
        from_branch_id, from_branch_name, from_branch_code,
        to_branch_id, to_branch_name, to_branch_code,
        transferred_by_user_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        organizationId,
        deviceId,
        currentBranchId,
        source?.name || null,
        source?.branch_code || null,
        destinationBranchId,
        destination.name,
        destination.branch_code,
        userId,
        reason || null,
      ]
    );

    const [updateResult] = await connection.query(
      `UPDATE devices
       SET registered_branch_id = ?, updated_at = NOW()
       WHERE id = ? AND organization_id = ?`,
      [destinationBranchId, deviceId, organizationId]
    );
    if (updateResult.affectedRows !== 1) {
      throw new Error("The device branch assignment could not be updated.");
    }

    const action = currentBranchId === null ? "DEVICE_BRANCH_ASSIGNED" : "DEVICE_BRANCH_TRANSFERRED";
    const oldValues = {
      registered_branch_id: currentBranchId,
      registered_branch_name: source?.name || null,
      registered_branch_code: source?.branch_code || null,
    };
    const newValues = {
      registered_branch_id: destinationBranchId,
      registered_branch_name: destination.name,
      registered_branch_code: destination.branch_code,
    };
    const description = [
      currentBranchId === null
        ? `Assigned device ${device.device_name} to ${destination.name} (${destination.branch_code})`
        : `Transferred device ${device.device_name} from ${source?.name || "previous branch"} to ${destination.name}`,
      `old_values=${JSON.stringify(oldValues)}`,
      `new_values=${JSON.stringify(newValues)}`,
      reason ? `reason=${reason}` : null,
    ].filter(Boolean).join(" | ");

    // The active working branch is audit context only. It is never changed here.
    await connection.query(
      `INSERT INTO audit_logs
       (organization_id, branch_id, user_id, action, entity_type, entity_id,
        description, ip_address, user_agent)
       VALUES (?, ?, ?, ?, 'device', ?, ?, ?, ?)`,
      [
        organizationId,
        Number(req.gymStaff.branchId),
        userId,
        action,
        deviceId,
        description,
        req.ip || null,
        req.get("user-agent") ? req.get("user-agent").substring(0, 500) : null,
      ]
    );

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: currentBranchId === null ? "Device assigned to branch successfully." : "Device branch transferred successfully.",
      device: {
        id: deviceId,
        name: device.device_name,
        device_uuid: device.device_uuid,
        registered_branch_id: destinationBranchId,
        registered_branch_name: destination.name,
        registered_branch_code: destination.branch_code,
      },
    });
  } catch (error) {
    await rollback(connection, transactionStarted);
    console.error("Transfer device branch error:", error);
    return res.status(500).json({ success: false, message: "Unable to assign or transfer this device." });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  listGymDevices,
  getDeviceBranchTransferHistory,
  transferDeviceBranch,
};