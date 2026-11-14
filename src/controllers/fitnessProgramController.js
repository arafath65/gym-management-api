const db = require("../config/db");

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const ALLOWED_INPUT_FIELDS = new Set([
  "name",
  "category",
  "description",
  "duration_value",
  "duration_unit",
  "instructions",
]);

const FIELD_COLUMNS = {
  name: "name",
  category: "category",
  description: "description",
  duration_value: "duration_value",
  duration_unit: "duration_unit",
  instructions: "instructions",
};

const PROGRAM_SELECT = `
  SELECT
    id,
    organization_id,
    program_code,
    name,
    category,
    description,
    duration_value,
    duration_unit,
    instructions,
    status,
    created_by_user_id,
    updated_by_user_id,
    created_at,
    updated_at
  FROM fitness_programs
`;

const getProgramResponse = (row) => ({
  id: Number(row.id),
  organization_id: Number(row.organization_id),
  program_code: row.program_code,
  name: row.name,
  category: row.category,
  description: row.description,
  duration_value: Number(row.duration_value),
  duration_unit: row.duration_unit,
  instructions: row.instructions,
  status: row.status,
  created_by_user_id: Number(row.created_by_user_id),
  updated_by_user_id: row.updated_by_user_id == null
    ? null
    : Number(row.updated_by_user_id),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const validateAllowedFields = (body) => {
  const unknown = Object.keys(body).filter(key => !ALLOWED_INPUT_FIELDS.has(key));
  return unknown.length ? `Unsupported field(s): ${unknown.join(", ")}` : null;
};

const normalizeOptionalText = (value, label, maxLength, errors) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength) {
    errors.push(`${label} must be text (maximum ${maxLength} characters).`);
    return null;
  }
  return value.trim() || null;
};

const normalizeProgramInput = (body, existing = null) => {
  const values = {
    name: existing?.name ?? "",
    category: existing?.category ?? "",
    description: existing?.description ?? null,
    duration_value: existing?.duration_value ?? null,
    duration_unit: existing?.duration_unit ?? null,
    instructions: existing?.instructions ?? null,
  };
  Object.assign(values, body);
  const errors = [];

  if (typeof values.name !== "string" || !values.name.trim() || values.name.trim().length > 120) {
    errors.push("Program name is required (maximum 120 characters).");
  } else {
    values.name = values.name.trim();
  }

  if (typeof values.category !== "string" || !values.category.trim() || values.category.trim().length > 80) {
    errors.push("Category is required (maximum 80 characters).");
  } else {
    values.category = values.category.trim();
  }

  values.description = normalizeOptionalText(values.description, "Description", 10000, errors);
  values.instructions = normalizeOptionalText(values.instructions, "Instructions", 10000, errors);

  const durationValue = Number(values.duration_value);
  if (!Number.isSafeInteger(durationValue) || durationValue < 1 || durationValue > 65535) {
    errors.push("Duration must be a whole number between 1 and 65535.");
  } else {
    values.duration_value = durationValue;
  }

  if (!["day", "week", "month", "year"].includes(values.duration_unit)) {
    errors.push("Duration unit must be day, week, month or year.");
  }

  return { values, errors };
};

const writeAuditLog = async (connection, req, { action, programId, message, oldValues = null, newValues = null }) => {
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
      (organization_id, branch_id, user_id, action, entity_type, entity_id,
       description, ip_address, user_agent)
     VALUES (?, ?, ?, ?, 'fitness_program', ?, ?, ?, ?)`,
    [
      organizationId,
      branchId,
      userId,
      action,
      programId,
      details,
      req.ip || null,
      req.get("user-agent") ? req.get("user-agent").substring(0, 500) : null,
    ]
  );
};

const rollbackAndReturn = async (connection, res, statusCode, code, message) => {
  await connection.rollback();
  return res.status(statusCode).json({ success: false, code, message });
};

const handleDatabaseError = (res, error, operation) => {
  if (error.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      success: false,
      code: "FITNESS_PROGRAM_CODE_CONFLICT",
      message: "A fitness program with this code already exists.",
    });
  }
  if (error.code === "ER_CHECK_CONSTRAINT_VIOLATED" || error.errno === 3819) {
    return res.status(400).json({
      success: false,
      code: "FITNESS_PROGRAM_VALIDATION_FAILED",
      message: "Fitness program values do not satisfy the database rules.",
    });
  }
  console.error(`${operation} error:`, error);
  return res.status(500).json({
    success: false,
    code: "FITNESS_PROGRAM_SERVER_ERROR",
    message: "Unable to process the fitness program request.",
  });
};

// GET /api/fitness-programs
const getFitnessPrograms = async (req, res) => {
  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.page_size ?? 12);

    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return res.status(400).json({ success: false, message: "Page must be positive and page_size must be between 1 and 100." });
    }

    const filters = ["organization_id = ?"];
    const params = [organizationId];

    if (req.query.status !== undefined) {
      if (!["active", "inactive"].includes(req.query.status)) {
        return res.status(400).json({ success: false, message: "Invalid status filter." });
      }
      filters.push("status = ?");
      params.push(req.query.status);
    }

    if (req.query.duration_unit !== undefined) {
      if (!["day", "week", "month", "year"].includes(req.query.duration_unit)) {
        return res.status(400).json({ success: false, message: "Invalid duration_unit filter." });
      }
      filters.push("duration_unit = ?");
      params.push(req.query.duration_unit);
    }

    if (req.query.category !== undefined) {
      if (typeof req.query.category !== "string" || req.query.category.trim().length > 80) {
        return res.status(400).json({ success: false, message: "Category filter must not exceed 80 characters." });
      }
      filters.push("category = ?");
      params.push(req.query.category.trim());
    }

    if (req.query.search !== undefined) {
      if (typeof req.query.search !== "string" || req.query.search.trim().length > 100) {
        return res.status(400).json({ success: false, message: "Search must not exceed 100 characters." });
      }
      const search = `%${req.query.search.trim()}%`;
      filters.push("(name LIKE ? OR program_code LIKE ? OR category LIKE ?)");
      params.push(search, search, search);
    }

    const orderColumns = {
      created_at: "created_at",
      name: "name",
      duration_value: "duration_value",
      category: "category",
    };
    const sortBy = req.query.sort_by || "created_at";
    const sortDirection = String(req.query.sort_order || "desc").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(orderColumns, sortBy)) {
      return res.status(400).json({ success: false, message: "Invalid sort_by value." });
    }
    if (!["asc", "desc"].includes(sortDirection)) {
      return res.status(400).json({ success: false, message: "sort_order must be asc or desc." });
    }

    const whereSql = `WHERE ${filters.join(" AND ")}`;
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total FROM fitness_programs ${whereSql}`,
      params
    );
    const total = Number(countRows[0].total);
    const offset = (page - 1) * pageSize;
    const [rows] = await db.query(
      `${PROGRAM_SELECT} ${whereSql}
       ORDER BY ${orderColumns[sortBy]} ${sortDirection}, id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return res.json({
      success: true,
      programs: rows.map(getProgramResponse),
      pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Get fitness programs");
  }
};

// GET /api/fitness-programs/:programId
const getFitnessProgram = async (req, res) => {
  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const programId = parsePositiveId(req.params.programId);
    if (!programId) {
      return res.status(400).json({ success: false, message: "Invalid fitness program ID." });
    }

    const [rows] = await db.query(
      `${PROGRAM_SELECT} WHERE organization_id = ? AND id = ? LIMIT 1`,
      [organizationId, programId]
    );
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: "FITNESS_PROGRAM_NOT_FOUND",
        message: "Fitness program not found.",
      });
    }
    return res.json({ success: true, program: getProgramResponse(rows[0]) });
  } catch (error) {
    return handleDatabaseError(res, error, "Get fitness program");
  }
};

// POST /api/fitness-programs
const createFitnessProgram = async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const userId = Number(req.gymStaff.userId);
    const body = req.body || {};
    const unknownError = validateAllowedFields(body);
    if (unknownError) {
      return res.status(400).json({ success: false, message: unknownError });
    }

    const { values, errors } = normalizeProgramInput(body);
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_FITNESS_PROGRAM",
        message: "Please correct the fitness program details.",
        errors,
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [organizations] = await connection.query(
      `SELECT id, status FROM organizations WHERE id = ? LIMIT 1 FOR UPDATE`,
      [organizationId]
    );
    if (organizations.length === 0) {
      return await rollbackAndReturn(connection, res, 404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
    }
    if (organizations[0].status !== "active") {
      return await rollbackAndReturn(connection, res, 403, "ORGANIZATION_INACTIVE", "Cannot create programs for an inactive organization.");
    }

    const [sequenceRows] = await connection.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(program_code, 4) AS UNSIGNED)), 0) + 1 AS next_number
       FROM fitness_programs
       WHERE organization_id = ? AND program_code REGEXP '^FP-[0-9]+$'`,
      [organizationId]
    );
    const nextNumber = Number(sequenceRows[0].next_number);
    if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) {
      throw new Error("Unable to generate fitness program code.");
    }
    const programCode = `FP-${String(nextNumber).padStart(6, "0")}`;

    const [insertResult] = await connection.query(
      `INSERT INTO fitness_programs
        (organization_id, program_code, name, category, description,
         duration_value, duration_unit, instructions, status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [organizationId, programCode, values.name, values.category, values.description,
       values.duration_value, values.duration_unit, values.instructions, userId]
    );
    const programId = Number(insertResult.insertId);
    const [createdRows] = await connection.query(
      `${PROGRAM_SELECT} WHERE organization_id = ? AND id = ? LIMIT 1`,
      [organizationId, programId]
    );
    const program = createdRows[0];

    await writeAuditLog(connection, req, {
      action: "FITNESS_PROGRAM_CREATED",
      programId,
      message: `Created fitness program ${programCode} - ${values.name}`,
      newValues: getProgramResponse(program),
    });

    await connection.commit();
    transactionStarted = false;
    return res.status(201).json({
      success: true,
      message: "Fitness program created successfully.",
      program: getProgramResponse(program),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error("Fitness program create rollback error:", rollbackError);
      }
    }
    return handleDatabaseError(res, error, "Create fitness program");
  } finally {
    if (connection) connection.release();
  }
};

// PATCH /api/fitness-programs/:programId
const updateFitnessProgram = async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const userId = Number(req.gymStaff.userId);
    const programId = parsePositiveId(req.params.programId);
    const body = req.body || {};

    if (!programId) {
      return res.status(400).json({ success: false, message: "Invalid fitness program ID." });
    }
    const unknownError = validateAllowedFields(body);
    if (unknownError) {
      return res.status(400).json({ success: false, message: unknownError });
    }
    if (Object.keys(body).length === 0) {
      return res.status(400).json({ success: false, message: "At least one program field must be supplied." });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [existingRows] = await connection.query(
      `${PROGRAM_SELECT} WHERE organization_id = ? AND id = ? LIMIT 1 FOR UPDATE`,
      [organizationId, programId]
    );
    if (existingRows.length === 0) {
      return await rollbackAndReturn(connection, res, 404, "FITNESS_PROGRAM_NOT_FOUND", "Fitness program not found.");
    }

    const oldProgram = existingRows[0];
    const { values, errors } = normalizeProgramInput(body, oldProgram);
    if (errors.length > 0) {
      return await rollbackAndReturn(connection, res, 400, "INVALID_FITNESS_PROGRAM", errors.join(" "));
    }

    const updates = [];
    const params = [];
    for (const key of Object.keys(body)) {
      updates.push(`${FIELD_COLUMNS[key]} = ?`);
      params.push(values[key]);
    }
    updates.push("updated_by_user_id = ?");
    params.push(userId, organizationId, programId);

    await connection.query(
      `UPDATE fitness_programs SET ${updates.join(", ")}
       WHERE organization_id = ? AND id = ?`,
      params
    );

    const [updatedRows] = await connection.query(
      `${PROGRAM_SELECT} WHERE organization_id = ? AND id = ? LIMIT 1`,
      [organizationId, programId]
    );
    const updatedProgram = updatedRows[0];

    await writeAuditLog(connection, req, {
      action: "FITNESS_PROGRAM_UPDATED",
      programId,
      message: `Updated fitness program ${oldProgram.program_code} - ${updatedProgram.name}`,
      oldValues: getProgramResponse(oldProgram),
      newValues: getProgramResponse(updatedProgram),
    });

    await connection.commit();
    transactionStarted = false;
    return res.json({
      success: true,
      message: "Fitness program updated successfully.",
      program: getProgramResponse(updatedProgram),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error("Fitness program update rollback error:", rollbackError);
      }
    }
    return handleDatabaseError(res, error, "Update fitness program");
  } finally {
    if (connection) connection.release();
  }
};

const changeFitnessProgramStatus = async (req, res, status) => {
  let connection;
  let transactionStarted = false;
  try {
    const organizationId = Number(req.gymStaff.organizationId);
    const userId = Number(req.gymStaff.userId);
    const programId = parsePositiveId(req.params.programId);
    if (!programId) {
      return res.status(400).json({ success: false, message: "Invalid fitness program ID." });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.query(
      `${PROGRAM_SELECT} WHERE organization_id = ? AND id = ? LIMIT 1 FOR UPDATE`,
      [organizationId, programId]
    );
    if (rows.length === 0) {
      return await rollbackAndReturn(connection, res, 404, "FITNESS_PROGRAM_NOT_FOUND", "Fitness program not found.");
    }

    const oldProgram = rows[0];
    if (oldProgram.status === status) {
      await connection.commit();
      transactionStarted = false;
      return res.json({
        success: true,
        message: `Fitness program is already ${status}.`,
        program: getProgramResponse(oldProgram),
      });
    }

    await connection.query(
      `UPDATE fitness_programs SET status = ?, updated_by_user_id = ?
       WHERE organization_id = ? AND id = ?`,
      [status, userId, organizationId, programId]
    );
    const [updatedRows] = await connection.query(
      `${PROGRAM_SELECT} WHERE organization_id = ? AND id = ? LIMIT 1`,
      [organizationId, programId]
    );
    const updatedProgram = updatedRows[0];

    await writeAuditLog(connection, req, {
      action: status === "inactive" ? "FITNESS_PROGRAM_DEACTIVATED" : "FITNESS_PROGRAM_REACTIVATED",
      programId,
      message: `${status === "inactive" ? "Deactivated" : "Reactivated"} fitness program ${oldProgram.program_code} - ${oldProgram.name}`,
      oldValues: { status: oldProgram.status },
      newValues: { status },
    });

    await connection.commit();
    transactionStarted = false;
    return res.json({
      success: true,
      message: `Fitness program ${status === "inactive" ? "deactivated" : "reactivated"} successfully.`,
      program: getProgramResponse(updatedProgram),
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error("Fitness program status rollback error:", rollbackError);
      }
    }
    return handleDatabaseError(res, error,
      status === "inactive" ? "Deactivate fitness program" : "Reactivate fitness program"
    );
  } finally {
    if (connection) connection.release();
  }
};

const deactivateFitnessProgram = (req, res) => changeFitnessProgramStatus(req, res, "inactive");
const reactivateFitnessProgram = (req, res) => changeFitnessProgramStatus(req, res, "active");

module.exports = {
  getFitnessPrograms,
  getFitnessProgram,
  createFitnessProgram,
  updateFitnessProgram,
  deactivateFitnessProgram,
  reactivateFitnessProgram,
};