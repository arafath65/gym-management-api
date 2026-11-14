const db = require("../config/db");

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const ALLOWED_INPUT_FIELDS = new Set([
  "name",
  "description",
  "package_type",
  "tier",
  "duration_value",
  "duration_unit",
  "price",
  "currency_code",
  "included_members",
  "paying_members",
]);

const FIELD_COLUMNS = {
  name: "name",
  description: "description",
  package_type: "package_type",
  tier: "tier",
  duration_value: "duration_value",
  duration_unit: "duration_unit",
  price: "price",
  currency_code: "currency_code",
  included_members: "included_members",
  paying_members: "paying_members",
};

const PLAN_SELECT = `
  SELECT
    id,
    organization_id,
    plan_code,
    name,
    description,
    package_type,
    tier,
    duration_value,
    duration_unit,
    price,
    currency_code,
    included_members,
    paying_members,
    status,
    created_by_user_id,
    updated_by_user_id,
    created_at,
    updated_at
  FROM membership_plans
`;

const getPlanResponse = (row) => ({
  id: Number(row.id),
  organization_id: Number(row.organization_id),
  plan_code: row.plan_code,
  name: row.name,
  description: row.description,
  package_type: row.package_type,
  tier: row.tier,
  duration_value: Number(row.duration_value),
  duration_unit: row.duration_unit,
  price: String(row.price),
  currency_code: row.currency_code,
  included_members: Number(row.included_members),
  paying_members: Number(row.paying_members),
  status: row.status,
  created_by_user_id: Number(row.created_by_user_id),
  updated_by_user_id:
    row.updated_by_user_id == null
      ? null
      : Number(row.updated_by_user_id),
  created_at: row.created_at,
  updated_at: row.updated_at,

  // Member/subscription tables will be introduced in a later module.
  // null means that the statistic is not available yet, not zero.
  active_member_count: null,
  total_enrolled_member_count: null,
  usage_statistics_available: false,
});

const validateAllowedFields = (body) => {
  const unknown = Object.keys(body).filter(
    (key) => !ALLOWED_INPUT_FIELDS.has(key)
  );

  if (unknown.length > 0) {
    return `Unsupported field(s): ${unknown.join(", ")}`;
  }

  return null;
};

const parsePrice = (value) => {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null;
  }

  const raw = String(value).trim();

  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) {
    return null;
  }

  const [whole, fraction = ""] = raw.split(".");
  return `${String(Number(whole))}.${fraction.padEnd(2, "0")}`;
};

const normalizePlanInput = (body, existing = null) => {
  const initialPackageType =
    body.package_type ?? existing?.package_type ?? "individual";

  const defaultIncludedMembers =
    initialPackageType === "couple" ? 2 : 1;

  const defaultPayingMembers = 1;

  const values = {
    name: existing?.name ?? "",
    description: existing?.description ?? null,
    package_type: existing?.package_type ?? "individual",
    tier: existing?.tier ?? null,
    duration_value: existing?.duration_value ?? null,
    duration_unit: existing?.duration_unit ?? null,
    price: existing?.price ?? null,
    currency_code: existing?.currency_code ?? "LKR",
    included_members: existing?.included_members ?? defaultIncludedMembers,
    paying_members: existing?.paying_members ?? defaultPayingMembers,
  };

  Object.assign(values, body);

  // Automatically use the standard coverage counts when changing
  // package type without explicitly supplying member counts.
  if (
    existing &&
    Object.prototype.hasOwnProperty.call(body, "package_type") &&
    body.package_type !== existing.package_type &&
    !Object.prototype.hasOwnProperty.call(body, "included_members") &&
    !Object.prototype.hasOwnProperty.call(body, "paying_members")
  ) {
    if (body.package_type === "couple") {
      values.included_members = 2;
      values.paying_members = 1;
    } else if (body.package_type === "individual") {
      values.included_members = 1;
      values.paying_members = 1;
    }
  }

  const errors = [];

  if (
    typeof values.name !== "string" ||
    !values.name.trim() ||
    values.name.trim().length > 120
  ) {
    errors.push("Plan name is required (maximum 120 characters).");
  } else {
    values.name = values.name.trim();
  }

  if (values.description !== null && values.description !== "") {
    if (
      typeof values.description !== "string" ||
      values.description.length > 10000
    ) {
      errors.push("Description must be text (maximum 10000 characters).");
    } else {
      values.description = values.description.trim() || null;
    }
  } else {
    values.description = null;
  }

  if (
    !["individual", "couple"].includes(values.package_type)
  ) {
    errors.push("Package type must be individual or couple.");
  }

  if (values.tier !== null && values.tier !== "") {
    if (
      typeof values.tier !== "string" ||
      values.tier.trim().length > 50
    ) {
      errors.push("Tier must be text (maximum 50 characters).");
    } else {
      values.tier = values.tier.trim() || null;
    }
  } else {
    values.tier = null;
  }

  const durationValue = Number(values.duration_value);

  if (
    !Number.isSafeInteger(durationValue) ||
    durationValue < 1 ||
    durationValue > 65535
  ) {
    errors.push("Duration value must be a whole number between 1 and 65535.");
  } else {
    values.duration_value = durationValue;
  }

  if (!["day", "week", "month", "year"].includes(values.duration_unit)) {
    errors.push("Duration unit must be day, week, month or year.");
  }

  const normalizedPrice = parsePrice(values.price);

  if (normalizedPrice === null) {
    errors.push("Price must be a non-negative amount with up to two decimal places.");
  } else {
    values.price = normalizedPrice;
  }

  if (
    typeof values.currency_code !== "string" ||
    !/^[A-Za-z]{3}$/.test(values.currency_code.trim())
  ) {
    errors.push("Currency code must contain exactly three letters.");
  } else {
    values.currency_code = values.currency_code.trim().toUpperCase();
  }

  const includedMembers = Number(values.included_members);
  const payingMembers = Number(values.paying_members);

  if (
    !Number.isSafeInteger(includedMembers) ||
    includedMembers < 1 ||
    includedMembers > 65535
  ) {
    errors.push("Included members must be a positive whole number.");
  }

  if (
    !Number.isSafeInteger(payingMembers) ||
    payingMembers < 1 ||
    payingMembers > 65535
  ) {
    errors.push("Paying members must be a positive whole number.");
  }

  if (
    Number.isSafeInteger(includedMembers) &&
    Number.isSafeInteger(payingMembers)
  ) {
    values.included_members = includedMembers;
    values.paying_members = payingMembers;

    if (includedMembers < payingMembers) {
      errors.push("Included members cannot be fewer than paying members.");
    }

    if (
      values.package_type === "individual" &&
      (includedMembers !== 1 || payingMembers !== 1)
    ) {
      errors.push("Individual plans must cover exactly one paying member.");
    }

    if (
      values.package_type === "couple" &&
      (includedMembers !== 2 || payingMembers !== 1)
    ) {
      errors.push("Couple plans must cover two members with one paying member.");
    }
  }

  return {
    values,
    errors,
  };
};

const writeAuditLog = async (
  connection,
  req,
  {
    action,
    planId,
    message,
    oldValues = null,
    newValues = null,
  }
) => {
  const organizationId = Number(req.gymStaff.organizationId);
  const userId = Number(req.gymStaff.userId);
  const branchId = parsePositiveId(req.gymStaff.branchId);

  const details = [
    message,
    oldValues ? `old_values=${JSON.stringify(oldValues)}` : null,
    newValues ? `new_values=${JSON.stringify(newValues)}` : null,
  ].filter(Boolean).join(" | ");

  await connection.query(
    `INSERT INTO audit_logs
      (
        organization_id,
        branch_id,
        user_id,
        action,
        entity_type,
        entity_id,
        description,
        ip_address,
        user_agent
      )
     VALUES (?, ?, ?, ?, 'membership_plan', ?, ?, ?, ?)`,
    [
      organizationId,
      branchId,
      userId,
      action,
      planId,
      details,
      req.ip || null,
      req.get("user-agent")
        ? req.get("user-agent").substring(0, 500)
        : null,
    ]
  );
};

const rollbackAndReturn = async (
  connection,
  res,
  statusCode,
  code,
  message
) => {
  await connection.rollback();

  return res.status(statusCode).json({
    success: false,
    code,
    message,
  });
};

const handleDatabaseError = (res, error, operation) => {
  if (error.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      success: false,
      code: "MEMBERSHIP_PLAN_CODE_CONFLICT",
      message: "A membership plan with this code already exists.",
    });
  }

  if (
    error.code === "ER_CHECK_CONSTRAINT_VIOLATED" ||
    error.errno === 3819
  ) {
    return res.status(400).json({
      success: false,
      code: "MEMBERSHIP_PLAN_VALIDATION_FAILED",
      message: "Membership plan values do not satisfy the database rules.",
    });
  }

  console.error(`${operation} error:`, error);

  return res.status(500).json({
    success: false,
    code: "MEMBERSHIP_PLAN_SERVER_ERROR",
    message: "Unable to process the membership plan request.",
  });
};

// --------------------------------------------------
// GET /api/membership-plans
// --------------------------------------------------

const getMembershipPlans = async (req, res) => {
  try {
    const organizationId = Number(req.gymStaff.organizationId);

    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.page_size ?? 12);

    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "Page must be positive and page_size must be between 1 and 100.",
      });
    }

    const filters = ["organization_id = ?"];
    const params = [organizationId];

    if (req.query.status !== undefined) {
      if (!["active", "inactive"].includes(req.query.status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status filter.",
        });
      }

      filters.push("status = ?");
      params.push(req.query.status);
    }

    if (req.query.package_type !== undefined) {
      if (!["individual", "couple"].includes(req.query.package_type)) {
        return res.status(400).json({
          success: false,
          message: "Invalid package_type filter.",
        });
      }

      filters.push("package_type = ?");
      params.push(req.query.package_type);
    }

    if (req.query.duration_unit !== undefined) {
      if (!["day", "week", "month", "year"].includes(req.query.duration_unit)) {
        return res.status(400).json({
          success: false,
          message: "Invalid duration_unit filter.",
        });
      }

      filters.push("duration_unit = ?");
      params.push(req.query.duration_unit);
    }

    if (req.query.search !== undefined) {
      if (
        typeof req.query.search !== "string" ||
        req.query.search.trim().length > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "Search must not exceed 100 characters.",
        });
      }

      const search = `%${req.query.search.trim()}%`;
      filters.push("(name LIKE ? OR plan_code LIKE ? OR tier LIKE ?)");
      params.push(search, search, search);
    }

    const whereSql = `WHERE ${filters.join(" AND ")}`;

    const orderColumns = {
      created_at: "created_at",
      name: "name",
      price: "price",
      duration_value: "duration_value",
    };

    const sortBy = req.query.sort_by || "created_at";
    const sortDirection =
      String(req.query.sort_order || "desc").toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(orderColumns, sortBy)) {
      return res.status(400).json({
        success: false,
        message: "Invalid sort_by value.",
      });
    }

    if (!["asc", "desc"].includes(sortDirection)) {
      return res.status(400).json({
        success: false,
        message: "sort_order must be asc or desc.",
      });
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM membership_plans
       ${whereSql}`,
      params
    );

    const total = Number(countRows[0].total);
    const offset = (page - 1) * pageSize;

    const [rows] = await db.query(
      `${PLAN_SELECT}
       ${whereSql}
       ORDER BY ${orderColumns[sortBy]} ${sortDirection}, id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return res.json({
      success: true,
      plans: rows.map(getPlanResponse),
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
      usage_statistics_available: false,
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Get membership plans");
  }
};

// --------------------------------------------------
// GET /api/membership-plans/:planId
// --------------------------------------------------

const getMembershipPlan = async (req, res) => {
  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const planId = parsePositiveId(req.params.planId);

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: "Invalid membership plan ID.",
      });
    }

    const [rows] = await db.query(
      `${PLAN_SELECT}
       WHERE organization_id = ? AND id = ?
       LIMIT 1`,
      [organizationId, planId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: "MEMBERSHIP_PLAN_NOT_FOUND",
        message: "Membership plan not found.",
      });
    }

    return res.json({
      success: true,
      plan: getPlanResponse(rows[0]),
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Get membership plan");
  }
};

// --------------------------------------------------
// POST /api/membership-plans
// --------------------------------------------------

const createMembershipPlan = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const userId = Number(req.gymStaff.userId);
    const body = req.body || {};

    const unknownError = validateAllowedFields(body);

    if (unknownError) {
      return res.status(400).json({
        success: false,
        message: unknownError,
      });
    }

    const { values, errors } = normalizePlanInput(body);

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_MEMBERSHIP_PLAN",
        message: "Please correct the membership plan details.",
        errors,
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [organizations] = await connection.query(
      `SELECT id, name, status
       FROM organizations
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId]
    );

    if (organizations.length === 0) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "ORGANIZATION_NOT_FOUND",
        "Organization not found."
      );
    }

    if (organizations[0].status !== "active") {
      return await rollbackAndReturn(
        connection,
        res,
        403,
        "ORGANIZATION_INACTIVE",
        "Cannot create plans for an inactive organization."
      );
    }

    // Locking the organization row serializes plan-code generation
    // for concurrent plan creation requests within this organization.
    const [sequenceRows] = await connection.query(
      `SELECT
         COALESCE(
           MAX(CAST(SUBSTRING(plan_code, 4) AS UNSIGNED)),
           0
         ) + 1 AS next_number
       FROM membership_plans
       WHERE organization_id = ?
         AND plan_code REGEXP '^MP-[0-9]+$'`,
      [organizationId]
    );

    const nextNumber = Number(sequenceRows[0].next_number);

    if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) {
      throw new Error("Unable to generate membership plan code.");
    }

    const planCode = `MP-${String(nextNumber).padStart(6, "0")}`;

    const [insertResult] = await connection.query(
      `INSERT INTO membership_plans
        (
          organization_id,
          plan_code,
          name,
          description,
          package_type,
          tier,
          duration_value,
          duration_unit,
          price,
          currency_code,
          included_members,
          paying_members,
          status,
          created_by_user_id
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        organizationId,
        planCode,
        values.name,
        values.description,
        values.package_type,
        values.tier,
        values.duration_value,
        values.duration_unit,
        values.price,
        values.currency_code,
        values.included_members,
        values.paying_members,
        userId,
      ]
    );

    const planId = Number(insertResult.insertId);

    const [createdRows] = await connection.query(
      `${PLAN_SELECT}
       WHERE organization_id = ? AND id = ?
       LIMIT 1`,
      [organizationId, planId]
    );

    const plan = createdRows[0];

    await writeAuditLog(connection, req, {
      action: "MEMBERSHIP_PLAN_CREATED",
      planId,
      message: `Created membership plan ${planCode} - ${values.name}`,
      newValues: getPlanResponse(plan),
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Membership plan created successfully.",
      plan: getPlanResponse(plan),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Membership plan create rollback error:", rollbackError);
      }
    }

    return handleDatabaseError(res, error, "Create membership plan");
  } finally {
    if (connection) connection.release();
  }
};

// --------------------------------------------------
// PATCH /api/membership-plans/:planId
// --------------------------------------------------

const updateMembershipPlan = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const userId = Number(req.gymStaff.userId);
    const planId = parsePositiveId(req.params.planId);
    const body = req.body || {};

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: "Invalid membership plan ID.",
      });
    }

    const unknownError = validateAllowedFields(body);

    if (unknownError) {
      return res.status(400).json({
        success: false,
        message: unknownError,
      });
    }

    if (Object.keys(body).length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one plan field must be supplied.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [existingRows] = await connection.query(
      `${PLAN_SELECT}
       WHERE organization_id = ? AND id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId, planId]
    );

    if (existingRows.length === 0) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "MEMBERSHIP_PLAN_NOT_FOUND",
        "Membership plan not found."
      );
    }

    const oldPlan = existingRows[0];
    const { values, errors } = normalizePlanInput(body, oldPlan);

    if (errors.length > 0) {
      return await rollbackAndReturn(
        connection,
        res,
        400,
        "INVALID_MEMBERSHIP_PLAN",
        errors.join(" ")
      );
    }

    const updates = [];
    const params = [];

    for (const key of Object.keys(body)) {
      updates.push(`${FIELD_COLUMNS[key]} = ?`);
      params.push(values[key]);
    }

    // Package-type changes must keep couple/individual coverage valid.
    if (
      Object.prototype.hasOwnProperty.call(body, "package_type") &&
      !Object.prototype.hasOwnProperty.call(body, "included_members") &&
      !Object.prototype.hasOwnProperty.call(body, "paying_members")
    ) {
      updates.push("included_members = ?");
      updates.push("paying_members = ?");
      params.push(values.included_members, values.paying_members);
    }

    updates.push("updated_by_user_id = ?");
    params.push(userId, organizationId, planId);

    await connection.query(
      `UPDATE membership_plans
       SET ${updates.join(", ")}
       WHERE organization_id = ? AND id = ?`,
      params
    );

    const [updatedRows] = await connection.query(
      `${PLAN_SELECT}
       WHERE organization_id = ? AND id = ?
       LIMIT 1`,
      [organizationId, planId]
    );

    const updatedPlan = updatedRows[0];

    await writeAuditLog(connection, req, {
      action: "MEMBERSHIP_PLAN_UPDATED",
      planId,
      message: `Updated membership plan ${oldPlan.plan_code} - ${updatedPlan.name}`,
      oldValues: getPlanResponse(oldPlan),
      newValues: getPlanResponse(updatedPlan),
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Membership plan updated successfully.",
      plan: getPlanResponse(updatedPlan),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Membership plan update rollback error:", rollbackError);
      }
    }

    return handleDatabaseError(res, error, "Update membership plan");
  } finally {
    if (connection) connection.release();
  }
};

// --------------------------------------------------
// STATUS CHANGE HELPER
// --------------------------------------------------

const changeMembershipPlanStatus = async (req, res, status) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const userId = Number(req.gymStaff.userId);
    const planId = parsePositiveId(req.params.planId);

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: "Invalid membership plan ID.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [rows] = await connection.query(
      `${PLAN_SELECT}
       WHERE organization_id = ? AND id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId, planId]
    );

    if (rows.length === 0) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "MEMBERSHIP_PLAN_NOT_FOUND",
        "Membership plan not found."
      );
    }

    const oldPlan = rows[0];

    if (oldPlan.status === status) {
      await connection.commit();
      transactionStarted = false;

      return res.json({
        success: true,
        message: `Membership plan is already ${status}.`,
        plan: getPlanResponse(oldPlan),
      });
    }

    await connection.query(
      `UPDATE membership_plans
       SET status = ?, updated_by_user_id = ?
       WHERE organization_id = ? AND id = ?`,
      [status, userId, organizationId, planId]
    );

    const [updatedRows] = await connection.query(
      `${PLAN_SELECT}
       WHERE organization_id = ? AND id = ?
       LIMIT 1`,
      [organizationId, planId]
    );

    const updatedPlan = updatedRows[0];

    await writeAuditLog(connection, req, {
      action: status === "inactive"
        ? "MEMBERSHIP_PLAN_DEACTIVATED"
        : "MEMBERSHIP_PLAN_REACTIVATED",
      planId,
      message: `${status === "inactive" ? "Deactivated" : "Reactivated"} membership plan ${oldPlan.plan_code} - ${oldPlan.name}`,
      oldValues: { status: oldPlan.status },
      newValues: { status },
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: `Membership plan ${status === "inactive" ? "deactivated" : "reactivated"} successfully.`,
      plan: getPlanResponse(updatedPlan),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Membership plan status rollback error:", rollbackError);
      }
    }

    return handleDatabaseError(
      res,
      error,
      status === "inactive"
        ? "Deactivate membership plan"
        : "Reactivate membership plan"
    );
  } finally {
    if (connection) connection.release();
  }
};

const deactivateMembershipPlan = (req, res) =>
  changeMembershipPlanStatus(req, res, "inactive");

const reactivateMembershipPlan = (req, res) =>
  changeMembershipPlanStatus(req, res, "active");

module.exports = {
  getMembershipPlans,
  getMembershipPlan,
  createMembershipPlan,
  updateMembershipPlan,
  deactivateMembershipPlan,
  reactivateMembershipPlan,
};