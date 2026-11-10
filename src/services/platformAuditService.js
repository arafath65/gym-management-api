const writePlatformAuditLog = async (connection, data) => {
  const {
    platformAdminId,
    organizationId = null,
    action,
    entityType = null,
    entityId = null,
    description = null,
    oldValues = null,
    newValues = null,
    ipAddress = null,
    userAgent = null,
  } = data;

  if (!connection) {
    throw new Error("Database transaction connection is required for audit logging");
  }

  if (!Number.isInteger(Number(platformAdminId)) ||
      Number(platformAdminId) <= 0) {
    throw new Error("Valid Platform Admin ID is required for audit logging");
  }

  if (!action) {
    throw new Error("Audit action is required");
  }

  await connection.query(
    `INSERT INTO platform_audit_logs
      (
        platform_admin_id,
        organization_id,
        action,
        entity_type,
        entity_id,
        description,
        old_values,
        new_values,
        ip_address,
        user_agent
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(platformAdminId),
      organizationId,
      action,
      entityType,
      entityId,
      description,
      oldValues === null ? null : JSON.stringify(oldValues),
      newValues === null ? null : JSON.stringify(newValues),
      ipAddress,
      userAgent ? userAgent.substring(0, 500) : null,
    ]
  );
};

module.exports = {
  writePlatformAuditLog,
};
