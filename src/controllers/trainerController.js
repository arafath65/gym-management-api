const db = require("../config/db");
const localStorage = require("../services/storage/localStorageProvider");
const {
  optimizeTrainerPhoto,
  TrainerPhotoValidationError,
} = require("../services/storage/trainerPhotoProcessor");

// --------------------------------------------------
// COMMON HELPERS
// --------------------------------------------------

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const isSystemGymAdmin = (req) =>
  Array.isArray(req.gymStaff?.roles) &&
  req.gymStaff.roles.some(
    (role) =>
      role.name === "Gym Admin" &&
      role.is_system_role === true
  );

const getAccessibleBranchIds = (req) => {
  const branches = Array.isArray(req.gymStaff?.branches)
    ? req.gymStaff.branches
    : [];

  const ids = branches
    .map((branch) => parsePositiveId(branch.id))
    .filter(Boolean);

  const activeBranchId = parsePositiveId(req.gymStaff?.branchId);

  if (activeBranchId && !ids.includes(activeBranchId)) {
    ids.push(activeBranchId);
  }

  return [...new Set(ids)];
};

const TRAINER_SELECT = `
  SELECT
    t.id,
    t.organization_id,
    t.trainer_code,
    t.full_name,
    t.phone,
    t.email,
    t.address,
    t.specialization,
    t.qualifications,
    t.experience_years,
    t.bio,
    t.profile_photo_path,
    t.status,
    t.created_by_user_id,
    t.updated_by_user_id,
    t.created_at,
    t.updated_at
  FROM trainers t
`;

const getTrainerResponse = (row) => ({
  id: Number(row.id),
  organization_id: Number(row.organization_id),
  trainer_code: row.trainer_code,
  full_name: row.full_name,
  phone: row.phone,
  email: row.email,
  address: row.address,
  specialization: row.specialization,
  qualifications: row.qualifications,
  experience_years: Number(row.experience_years),
  bio: row.bio,
  profile_photo_path: row.profile_photo_path,
  status: row.status,
  created_by_user_id: Number(row.created_by_user_id),
  updated_by_user_id:
    row.updated_by_user_id == null
      ? null
      : Number(row.updated_by_user_id),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const ALLOWED_INPUT_FIELDS = new Set([
  "full_name",
  "phone",
  "email",
  "address",
  "specialization",
  "qualifications",
  "experience_years",
  "bio",
]);

const FIELD_COLUMNS = {
  full_name: "full_name",
  phone: "phone",
  email: "email",
  address: "address",
  specialization: "specialization",
  qualifications: "qualifications",
  experience_years: "experience_years",
  bio: "bio",
};

const validateAllowedFields = (body) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return "Request body must be a valid object.";
  }

  const unknown = Object.keys(body).filter(
    (key) => !ALLOWED_INPUT_FIELDS.has(key)
  );

  return unknown.length
    ? `Unsupported field(s): ${unknown.join(", ")}`
    : null;
};

const normalizeNullableText = (
  value,
  label,
  maxLength,
  errors
) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || value.trim().length > maxLength) {
    errors.push(
      `${label} must be text with a maximum of ${maxLength} characters.`
    );
    return null;
  }

  return value.trim() || null;
};

const normalizeTrainerInput = (body, existing = null) => {
  const values = {
    full_name: existing?.full_name ?? "",
    phone: existing?.phone ?? "",
    email: existing?.email ?? null,
    address: existing?.address ?? null,
    specialization: existing?.specialization ?? null,
    qualifications: existing?.qualifications ?? null,
    experience_years: existing?.experience_years ?? 0,
    bio: existing?.bio ?? null,
  };

  Object.assign(values, body);

  const errors = [];

  if (
    typeof values.full_name !== "string" ||
    !values.full_name.trim() ||
    values.full_name.trim().length > 150
  ) {
    errors.push(
      "Trainer name is required and must not exceed 150 characters."
    );
  } else {
    values.full_name = values.full_name.trim();
  }

  if (
    typeof values.phone !== "string" ||
    !values.phone.trim() ||
    values.phone.trim().length > 30 ||
    !/^[+0-9()\s.-]+$/.test(values.phone.trim()) ||
    values.phone.replace(/\D/g, "").length < 7
  ) {
    errors.push("A valid trainer phone number is required.");
  } else {
    values.phone = values.phone.trim();
  }

  values.email = normalizeNullableText(
    values.email,
    "Email",
    150,
    errors
  );

  if (
    values.email &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)
  ) {
    errors.push("Please provide a valid email address.");
  }

  values.address = normalizeNullableText(
    values.address,
    "Address",
    5000,
    errors
  );

  values.specialization = normalizeNullableText(
    values.specialization,
    "Specialization",
    255,
    errors
  );

  values.qualifications = normalizeNullableText(
    values.qualifications,
    "Qualifications",
    10000,
    errors
  );

  values.bio = normalizeNullableText(
    values.bio,
    "Bio",
    10000,
    errors
  );


  const experienceYears = Number(values.experience_years);

  if (
    !Number.isSafeInteger(experienceYears) ||
    experienceYears < 0 ||
    experienceYears > 60
  ) {
    errors.push(
      "Experience must be a whole number between 0 and 60 years."
    );
  } else {
    values.experience_years = experienceYears;
  }

  return { values, errors };
};

// --------------------------------------------------
// AUDIT LOGGING
// All writes use the existing audit_logs table.
// Called inside the same database transaction.
// --------------------------------------------------

const writeAuditLog = async (
  connection,
  req,
  {
    action,
    trainerId,
    message,
    oldValues = null,
    newValues = null,
  }
) => {
  const organizationId = Number(
    req.gymStaff.organizationId
  );

  const userId = Number(req.gymStaff.userId);
  const branchId = parsePositiveId(req.gymStaff.branchId);

  const details = [
    message,
    oldValues
      ? `old_values=${JSON.stringify(oldValues)}`
      : null,
    newValues
      ? `new_values=${JSON.stringify(newValues)}`
      : null,
  ]
    .filter(Boolean)
    .join(" | ");

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
     VALUES (?, ?, ?, ?, 'trainer', ?, ?, ?, ?)`,
    [
      organizationId,
      branchId,
      userId,
      action,
      trainerId,
      details,
      req.ip || null,
      req.get("user-agent")
        ? req.get("user-agent").substring(0, 500)
        : null,
    ]
  );
};

// --------------------------------------------------
// DATABASE HELPERS
// --------------------------------------------------

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
      code: "TRAINER_DUPLICATE",
      message:
        "A conflicting trainer or branch assignment already exists.",
    });
  }

  if (
    error.code === "ER_CHECK_CONSTRAINT_VIOLATED" ||
    error.errno === 3819
  ) {
    return res.status(400).json({
      success: false,
      code: "TRAINER_VALIDATION_FAILED",
      message:
        "Trainer values do not satisfy the database rules.",
    });
  }

  if (
    error.code === "ER_NO_REFERENCED_ROW_2" ||
    error.code === "ER_ROW_IS_REFERENCED_2"
  ) {
    return res.status(409).json({
      success: false,
      code: "TRAINER_REFERENCE_CONFLICT",
      message:
        "The trainer is referenced by another record and cannot be changed as requested.",
    });
  }

  console.error(`${operation} error:`, error);

  return res.status(500).json({
    success: false,
    code: "TRAINER_SERVER_ERROR",
    message: "Unable to process the trainer request.",
  });
};

// Non-admin staff can access a trainer only when the trainer
// has an active assignment at their current active branch.
// System Gym Admin can access all trainers in their organization.
const getTrainerForActor = async (
  executor,
  req,
  trainerId,
  lock = false
) => {
  const organizationId = Number(
    req.gymStaff.organizationId
  );

  const params = [organizationId, trainerId];

  let sql = `
    ${TRAINER_SELECT}
    WHERE t.organization_id = ?
      AND t.id = ?
  `;

  if (!isSystemGymAdmin(req)) {
    sql += `
      AND EXISTS (
        SELECT 1
        FROM trainer_branch_access tba
        WHERE tba.organization_id = t.organization_id
          AND tba.trainer_id = t.id
          AND tba.branch_id = ?
          AND tba.status = 'active'
      )
    `;

    params.push(Number(req.gymStaff.branchId));
  }

  sql += " LIMIT 1";

  if (lock) {
    sql += " FOR UPDATE";
  }

  const [rows] = await executor.query(sql, params);

  return rows.length ? rows[0] : null;
};

const getTrainerBranchRows = async (
  executor,
  req,
  trainerId
) => {
  const organizationId = Number(
    req.gymStaff.organizationId
  );

  const params = [organizationId, trainerId];

  let sql = `
    SELECT
      b.id,
      b.name,
      b.branch_code,
      b.status AS branch_status,
      tba.status AS assignment_status,
      tba.assigned_by_user_id,
      tba.updated_by_user_id,
      tba.assigned_at,
      tba.updated_at
    FROM trainer_branch_access tba
    INNER JOIN branches b
      ON b.organization_id = tba.organization_id
     AND b.id = tba.branch_id
    WHERE tba.organization_id = ?
      AND tba.trainer_id = ?
  `;

  // Non-admin users only see branches assigned to their own
  // authenticated Gym Staff account.
  if (!isSystemGymAdmin(req)) {
    const accessibleIds = getAccessibleBranchIds(req);

    if (accessibleIds.length === 0) {
      return [];
    }

    sql += `
      AND tba.branch_id IN (
        ${accessibleIds.map(() => "?").join(",")}
      )
    `;

    params.push(...accessibleIds);
  }

  sql += " ORDER BY b.name ASC, b.id ASC";

  const [rows] = await executor.query(sql, params);

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    branch_code: row.branch_code,
    branch_status: row.branch_status,
    assignment_status: row.assignment_status,
    assigned_by_user_id: Number(row.assigned_by_user_id),
    updated_by_user_id:
      row.updated_by_user_id == null
        ? null
        : Number(row.updated_by_user_id),
    assigned_at: row.assigned_at,
    updated_at: row.updated_at,
  }));
};

const getBranchForActor = async (
  executor,
  req,
  branchId,
  allowInactiveForAdmin = false
) => {
  const organizationId = Number(
    req.gymStaff.organizationId
  );

  const [rows] = await executor.query(
    `SELECT id, organization_id, name, branch_code, status
     FROM branches
     WHERE organization_id = ?
       AND id = ?
     LIMIT 1`,
    [organizationId, branchId]
  );

  if (rows.length === 0) {
    return null;
  }

  const branch = rows[0];

  if (
    branch.status !== "active" &&
    !(allowInactiveForAdmin && isSystemGymAdmin(req))
  ) {
    return null;
  }

  if (
    !isSystemGymAdmin(req) &&
    !getAccessibleBranchIds(req).includes(Number(branch.id))
  ) {
    return null;
  }

  return {
    id: Number(branch.id),
    organization_id: Number(branch.organization_id),
    name: branch.name,
    branch_code: branch.branch_code,
    status: branch.status,
  };
};

// --------------------------------------------------
// GET TRAINERS
// GET /api/trainers
// Only trainers assigned to the active branch are shown.
// --------------------------------------------------

const getTrainers = async (req, res) => {
  try {
    const organizationId = Number(
      req.gymStaff.organizationId
    );

    const branchId = Number(req.gymStaff.branchId);

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
        message:
          "Page must be positive and page_size must be between 1 and 100.",
      });
    }

    const filters = [
      "t.organization_id = ?",
      `EXISTS (
        SELECT 1
        FROM trainer_branch_access tba
        WHERE tba.organization_id = t.organization_id
          AND tba.trainer_id = t.id
          AND tba.branch_id = ?
          AND tba.status = 'active'
      )`,
    ];

    const params = [organizationId, branchId];

    if (req.query.status !== undefined) {
      if (!["active", "inactive", "all"].includes(req.query.status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid trainer status filter.",
        });
      }

      if (req.query.status !== "all") {
        filters.push("t.status = ?");
        params.push(req.query.status);
      }
    } else {
      filters.push("t.status = 'active'");
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

      filters.push(
        "(t.full_name LIKE ? OR t.trainer_code LIKE ? OR t.phone LIKE ? OR t.specialization LIKE ?)"
      );

      params.push(search, search, search, search);
    }

    const sortColumns = {
      created_at: "t.created_at",
      name: "t.full_name",
      trainer_code: "t.trainer_code",
      experience_years: "t.experience_years",
    };

    const sortBy = req.query.sort_by || "created_at";
    const sortDirection = String(
      req.query.sort_order || "desc"
    ).toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(sortColumns, sortBy)) {
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

    const whereSql = `WHERE ${filters.join(" AND ")}`;

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM trainers t
       ${whereSql}`,
      params
    );

    const total = Number(countRows[0].total);
    const offset = (page - 1) * pageSize;

    const [rows] = await db.query(
      `${TRAINER_SELECT}
       ${whereSql}
       ORDER BY ${sortColumns[sortBy]} ${sortDirection}, t.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return res.json({
      success: true,
      trainers: rows.map(getTrainerResponse),
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
      active_branch_id: branchId,
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Get trainers");
  }
};

// --------------------------------------------------
// GET TRAINER DETAILS
// GET /api/trainers/:trainerId
// --------------------------------------------------

const getTrainer = async (req, res) => {
  try {
    const trainerId = parsePositiveId(req.params.trainerId);

    if (!trainerId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER_ID",
        message: "Invalid trainer ID.",
      });
    }

    const trainer = await getTrainerForActor(
      db,
      req,
      trainerId
    );

    if (!trainer) {
      return res.status(404).json({
        success: false,
        code: "TRAINER_NOT_FOUND",
        message: "Trainer not found or not accessible.",
      });
    }

    const branches = await getTrainerBranchRows(
      db,
      req,
      trainerId
    );

    return res.json({
      success: true,
      trainer: {
        ...getTrainerResponse(trainer),
        branches,
      },
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Get trainer");
  }
};

// --------------------------------------------------
// CREATE TRAINER
// POST /api/trainers
//
// Automatically assigns the new trainer to the
// authenticated active branch.
// --------------------------------------------------

const createTrainer = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(
      req.gymStaff.organizationId
    );

    const userId = Number(req.gymStaff.userId);
    const branchId = Number(req.gymStaff.branchId);

    const body = req.body || {};

    const unknownError = validateAllowedFields(body);

    if (unknownError) {
      return res.status(400).json({
        success: false,
        message: unknownError,
      });
    }

    if (
      !Object.prototype.hasOwnProperty.call(body, "full_name") ||
      !Object.prototype.hasOwnProperty.call(body, "phone")
    ) {
      return res.status(400).json({
        success: false,
        code: "TRAINER_REQUIRED_FIELDS",
        message: "Trainer name and phone number are required.",
      });
    }

    const { values, errors } = normalizeTrainerInput(body);

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER",
        message: "Please correct the trainer details.",
        errors,
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [organizations] = await connection.query(
      `SELECT id, status
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
        "Cannot create trainers for an inactive organization."
      );
    }

    const [branchRows] = await connection.query(
      `SELECT id, name, branch_code
       FROM branches
       WHERE organization_id = ?
         AND id = ?
         AND status = 'active'
       LIMIT 1
       FOR UPDATE`,
      [organizationId, branchId]
    );

    if (branchRows.length === 0) {
      return await rollbackAndReturn(
        connection,
        res,
        403,
        "TRAINER_BRANCH_UNAVAILABLE",
        "The active branch is no longer available."
      );
    }

    const [sequenceRows] = await connection.query(
      `SELECT
         COALESCE(
           MAX(CAST(SUBSTRING(trainer_code, 4) AS UNSIGNED)),
           0
         ) + 1 AS next_number
       FROM trainers
       WHERE organization_id = ?
         AND trainer_code REGEXP '^TR-[0-9]+$'`,
      [organizationId]
    );

    const nextNumber = Number(sequenceRows[0].next_number);

    if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) {
      throw new Error("Unable to generate trainer code.");
    }

    const trainerCode = `TR-${String(nextNumber).padStart(6, "0")}`;

    const [insertResult] = await connection.query(
      `INSERT INTO trainers
        (
          organization_id,
          trainer_code,
          full_name,
          phone,
          email,
          address,
          specialization,
          qualifications,
          experience_years,
          bio,
          profile_photo_path,
          status,
          created_by_user_id
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        organizationId,
        trainerCode,
        values.full_name,
        values.phone,
        values.email,
        values.address,
        values.specialization,
        values.qualifications,
        values.experience_years,
        values.bio,
        null,
        userId,
      ]
    );

    const trainerId = Number(insertResult.insertId);

    // Initial branch assignment is part of trainer creation.
    await connection.query(
      `INSERT INTO trainer_branch_access
        (
          organization_id,
          trainer_id,
          branch_id,
          status,
          assigned_by_user_id
        )
       VALUES (?, ?, ?, 'active', ?)`,
      [organizationId, trainerId, branchId, userId]
    );

    const [createdRows] = await connection.query(
      `${TRAINER_SELECT}
       WHERE t.organization_id = ?
         AND t.id = ?
       LIMIT 1`,
      [organizationId, trainerId]
    );

    const trainer = getTrainerResponse(createdRows[0]);

    const branch = {
      id: Number(branchRows[0].id),
      name: branchRows[0].name,
      branch_code: branchRows[0].branch_code,
      assignment_status: "active",
    };

    // Audit 1: trainer profile created.
    await writeAuditLog(connection, req, {
      action: "TRAINER_CREATED",
      trainerId,
      message: `Created trainer ${trainerCode} - ${values.full_name}`,
      newValues: trainer,
    });

    // Audit 2: initial branch assignment.
    await writeAuditLog(connection, req, {
      action: "TRAINER_BRANCH_ASSIGNED",
      trainerId,
      message: `Assigned trainer ${trainerCode} to ${branch.name} during creation`,
      newValues: branch,
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Trainer created successfully.",
      trainer: {
        ...trainer,
        branches: [branch],
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Trainer creation rollback failed:",
          rollbackError.message
        );
      }
    }

    return handleDatabaseError(res, error, "Create trainer");
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// --------------------------------------------------
// UPDATE TRAINER
// PATCH /api/trainers/:trainerId
// --------------------------------------------------

const updateTrainer = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(
      req.gymStaff.organizationId
    );

    const userId = Number(req.gymStaff.userId);
    const trainerId = parsePositiveId(req.params.trainerId);
    const body = req.body || {};

    if (!trainerId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER_ID",
        message: "Invalid trainer ID.",
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
        message: "At least one trainer field must be supplied.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const oldRow = await getTrainerForActor(
      connection,
      req,
      trainerId,
      true
    );

    if (!oldRow) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "TRAINER_NOT_FOUND",
        "Trainer not found or not accessible."
      );
    }

    const oldTrainer = getTrainerResponse(oldRow);

    const { values, errors } = normalizeTrainerInput(
      body,
      oldRow
    );

    if (errors.length > 0) {
      return await rollbackAndReturn(
        connection,
        res,
        400,
        "INVALID_TRAINER",
        errors.join(" ")
      );
    }

    const updates = [];
    const params = [];

    for (const key of Object.keys(body)) {
      updates.push(`${FIELD_COLUMNS[key]} = ?`);
      params.push(values[key]);
    }

    updates.push("updated_by_user_id = ?");

    params.push(userId, organizationId, trainerId);

    await connection.query(
      `UPDATE trainers
       SET ${updates.join(", ")}
       WHERE organization_id = ?
         AND id = ?`,
      params
    );

    const [updatedRows] = await connection.query(
      `${TRAINER_SELECT}
       WHERE t.organization_id = ?
         AND t.id = ?
       LIMIT 1`,
      [organizationId, trainerId]
    );

    const updatedTrainer = getTrainerResponse(updatedRows[0]);

    await writeAuditLog(connection, req, {
      action: "TRAINER_UPDATED",
      trainerId,
      message: `Updated trainer ${oldTrainer.trainer_code} - ${updatedTrainer.full_name}`,
      oldValues: oldTrainer,
      newValues: updatedTrainer,
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Trainer updated successfully.",
      trainer: updatedTrainer,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Trainer update rollback failed:",
          rollbackError.message
        );
      }
    }

    return handleDatabaseError(res, error, "Update trainer");
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// --------------------------------------------------
// DEACTIVATE / REACTIVATE TRAINER
// --------------------------------------------------

const changeTrainerStatus = async (req, res, status) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(
      req.gymStaff.organizationId
    );

    const userId = Number(req.gymStaff.userId);
    const trainerId = parsePositiveId(req.params.trainerId);

    if (!trainerId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER_ID",
        message: "Invalid trainer ID.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const oldRow = await getTrainerForActor(
      connection,
      req,
      trainerId,
      true
    );

    if (!oldRow) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "TRAINER_NOT_FOUND",
        "Trainer not found or not accessible."
      );
    }

    const oldTrainer = getTrainerResponse(oldRow);

    if (oldRow.status === status) {
      await connection.commit();
      transactionStarted = false;

      return res.json({
        success: true,
        message: `Trainer is already ${status}.`,
        trainer: oldTrainer,
      });
    }

    await connection.query(
      `UPDATE trainers
       SET status = ?,
           updated_by_user_id = ?
       WHERE organization_id = ?
         AND id = ?`,
      [status, userId, organizationId, trainerId]
    );

    const [updatedRows] = await connection.query(
      `${TRAINER_SELECT}
       WHERE t.organization_id = ?
         AND t.id = ?
       LIMIT 1`,
      [organizationId, trainerId]
    );

    const updatedTrainer = getTrainerResponse(updatedRows[0]);

    const isDeactivating = status === "inactive";

    await writeAuditLog(connection, req, {
      action: isDeactivating
        ? "TRAINER_DEACTIVATED"
        : "TRAINER_REACTIVATED",
      trainerId,
      message: `${isDeactivating ? "Deactivated" : "Reactivated"} trainer ${oldTrainer.trainer_code} - ${oldTrainer.full_name}`,
      oldValues: { status: oldTrainer.status },
      newValues: { status },
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: `Trainer ${isDeactivating ? "deactivated" : "reactivated"} successfully.`,
      trainer: updatedTrainer,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Trainer status rollback failed:",
          rollbackError.message
        );
      }
    }

    return handleDatabaseError(
      res,
      error,
      status === "inactive"
        ? "Deactivate trainer"
        : "Reactivate trainer"
    );
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

const deactivateTrainer = (req, res) =>
  changeTrainerStatus(req, res, "inactive");

const reactivateTrainer = (req, res) =>
  changeTrainerStatus(req, res, "active");

// --------------------------------------------------
// GET TRAINER BRANCH ASSIGNMENTS
// GET /api/trainers/:trainerId/branches
// --------------------------------------------------

const getTrainerBranches = async (req, res) => {
  try {
    const trainerId = parsePositiveId(req.params.trainerId);

    if (!trainerId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER_ID",
        message: "Invalid trainer ID.",
      });
    }

    const trainer = await getTrainerForActor(
      db,
      req,
      trainerId
    );

    if (!trainer) {
      return res.status(404).json({
        success: false,
        code: "TRAINER_NOT_FOUND",
        message: "Trainer not found or not accessible.",
      });
    }

    const branches = await getTrainerBranchRows(
      db,
      req,
      trainerId
    );

    return res.json({
      success: true,
      trainer_id: trainerId,
      branches,
    });
  } catch (error) {
    return handleDatabaseError(
      res,
      error,
      "Get trainer branches"
    );
  }
};

// --------------------------------------------------
// ASSIGN TRAINER TO ANOTHER BRANCH
// POST /api/trainers/:trainerId/branches
//
// Requires trainers.assign_branches.
// Target branch must be in the actor's authorized branch list.
// --------------------------------------------------

const assignTrainerBranch = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(
      req.gymStaff.organizationId
    );

    const userId = Number(req.gymStaff.userId);
    const trainerId = parsePositiveId(req.params.trainerId);
    const branchId = parsePositiveId(req.body?.branch_id);

    if (!trainerId || !branchId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER_BRANCH",
        message: "A valid trainer ID and branch ID are required.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const trainerRow = await getTrainerForActor(
      connection,
      req,
      trainerId,
      true
    );

    if (!trainerRow) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "TRAINER_NOT_FOUND",
        "Trainer not found or not accessible."
      );
    }

    if (trainerRow.status !== "active") {
      return await rollbackAndReturn(
        connection,
        res,
        409,
        "TRAINER_INACTIVE",
        "An inactive trainer cannot be assigned to a branch."
      );
    }

    const branch = await getBranchForActor(
      connection,
      req,
      branchId
    );

    if (!branch) {
      return await rollbackAndReturn(
        connection,
        res,
        403,
        "TRAINER_BRANCH_ACCESS_DENIED",
        "The target branch is not available to this account."
      );
    }

    const [existingRows] = await connection.query(
      `SELECT organization_id, trainer_id, branch_id, status
       FROM trainer_branch_access
       WHERE organization_id = ?
         AND trainer_id = ?
         AND branch_id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId, trainerId, branchId]
    );

    const previousStatus = existingRows.length
      ? existingRows[0].status
      : null;

    if (previousStatus === "active") {
      return await rollbackAndReturn(
        connection,
        res,
        409,
        "TRAINER_BRANCH_ALREADY_ASSIGNED",
        "This trainer is already assigned to the selected branch."
      );
    }

    if (existingRows.length > 0) {
      await connection.query(
        `UPDATE trainer_branch_access
         SET status = 'active',
             updated_by_user_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = ?
           AND trainer_id = ?
           AND branch_id = ?`,
        [userId, organizationId, trainerId, branchId]
      );
    } else {
      await connection.query(
        `INSERT INTO trainer_branch_access
          (
            organization_id,
            trainer_id,
            branch_id,
            status,
            assigned_by_user_id
          )
         VALUES (?, ?, ?, 'active', ?)`,
        [organizationId, trainerId, branchId, userId]
      );
    }

    await writeAuditLog(connection, req, {
      action: "TRAINER_BRANCH_ASSIGNED",
      trainerId,
      message: `Assigned trainer ${trainerRow.trainer_code} to branch ${branch.name} (${branch.branch_code})`,
      oldValues: previousStatus
        ? { assignment_status: previousStatus }
        : null,
      newValues: {
        branch_id: branch.id,
        branch_name: branch.name,
        branch_code: branch.branch_code,
        assignment_status: "active",
      },
    });

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Trainer assigned to branch successfully.",
      trainer_id: trainerId,
      branch,
      assignment_status: "active",
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Trainer branch assignment rollback failed:",
          rollbackError.message
        );
      }
    }

    return handleDatabaseError(
      res,
      error,
      "Assign trainer branch"
    );
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// --------------------------------------------------
// REMOVE TRAINER FROM BRANCH
// POST /api/trainers/:trainerId/branches/:branchId/remove
//
// This is a soft removal: the assignment row is retained.
// An active trainer must retain at least one active branch.
// --------------------------------------------------

const removeTrainerBranch = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = Number(
      req.gymStaff.organizationId
    );

    const userId = Number(req.gymStaff.userId);
    const trainerId = parsePositiveId(req.params.trainerId);
    const branchId = parsePositiveId(req.params.branchId);

    if (!trainerId || !branchId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER_BRANCH",
        message: "Invalid trainer ID or branch ID.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const trainerRow = await getTrainerForActor(
      connection,
      req,
      trainerId,
      true
    );

    if (!trainerRow) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "TRAINER_NOT_FOUND",
        "Trainer not found or not accessible."
      );
    }

    const branch = await getBranchForActor(
      connection,
      req,
      branchId,
      true
    );

    if (!branch) {
      return await rollbackAndReturn(
        connection,
        res,
        403,
        "TRAINER_BRANCH_ACCESS_DENIED",
        "The target branch is not available to this account."
      );
    }

    const [assignmentRows] = await connection.query(
      `SELECT status
       FROM trainer_branch_access
       WHERE organization_id = ?
         AND trainer_id = ?
         AND branch_id = ?
       LIMIT 1
       FOR UPDATE`,
      [organizationId, trainerId, branchId]
    );

    if (
      assignmentRows.length === 0 ||
      assignmentRows[0].status !== "active"
    ) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "TRAINER_BRANCH_ASSIGNMENT_NOT_FOUND",
        "Active trainer branch assignment not found."
      );
    }

    const [countRows] = await connection.query(
      `SELECT COUNT(*) AS active_count
       FROM trainer_branch_access
       WHERE organization_id = ?
         AND trainer_id = ?
         AND status = 'active'`,
      [organizationId, trainerId]
    );

    const activeCount = Number(countRows[0].active_count);

    if (
      trainerRow.status === "active" &&
      activeCount <= 1
    ) {
      return await rollbackAndReturn(
        connection,
        res,
        409,
        "TRAINER_LAST_ACTIVE_BRANCH",
        "An active trainer must have at least one active branch assignment."
      );
    }

    await connection.query(
      `UPDATE trainer_branch_access
       SET status = 'inactive',
           updated_by_user_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ?
         AND trainer_id = ?
         AND branch_id = ?`,
      [userId, organizationId, trainerId, branchId]
    );

    await writeAuditLog(connection, req, {
      action: "TRAINER_BRANCH_REMOVED",
      trainerId,
      message: `Removed trainer ${trainerRow.trainer_code} from branch ${branch.name} (${branch.branch_code})`,
      oldValues: {
        branch_id: branch.id,
        branch_name: branch.name,
        assignment_status: "active",
      },
      newValues: {
        branch_id: branch.id,
        branch_name: branch.name,
        assignment_status: "inactive",
      },
    });

    await connection.commit();
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Trainer removed from branch successfully.",
      trainer_id: trainerId,
      branch,
      assignment_status: "inactive",
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Trainer branch removal rollback failed:",
          rollbackError.message
        );
      }
    }

    return handleDatabaseError(
      res,
      error,
      "Remove trainer branch"
    );
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// --------------------------------------------------
// TRAINER PROFILE PHOTO
// Authenticated photo access with organization and
// active-branch authorization.
// --------------------------------------------------

const getTrainerPhoto = async (req, res) => {
  try {
    const trainerId = parsePositiveId(req.params.trainerId);

    if (!trainerId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER_ID",
        message: "Invalid trainer ID.",
      });
    }

    const organizationId = Number(req.gymStaff.organizationId);
    const trainer = await getTrainerForActor(db, req, trainerId);

    if (!trainer) {
      return res.status(404).json({
        success: false,
        code: "TRAINER_NOT_FOUND",
        message: "Trainer not found or not accessible.",
      });
    }

    if (!trainer.profile_photo_path) {
      return res.status(404).json({
        success: false,
        code: "TRAINER_PHOTO_NOT_FOUND",
        message: "This trainer does not have a profile photo.",
      });
    }

    const imageBuffer = await localStorage.readTrainerPhoto(
      organizationId,
      trainerId,
      trainer.profile_photo_path
    );

    return res.status(200).set({
      "Content-Type": "image/webp",
      "Content-Length": String(imageBuffer.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    }).send(imageBuffer);
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({
        success: false,
        code: "TRAINER_PHOTO_FILE_NOT_FOUND",
        message: "The trainer photo file is unavailable.",
      });
    }

    console.error("Get trainer photo error:", error);

    return res.status(500).json({
      success: false,
      code: "TRAINER_PHOTO_READ_FAILED",
      message: "Unable to retrieve the trainer photo.",
    });
  }
};

const uploadTrainerPhoto = async (req, res) => {
  let connection;
  let transactionStarted = false;
  let newPhotoPath = null;

  const trainerId = parsePositiveId(req.params.trainerId);
  const organizationId = Number(req.gymStaff.organizationId);

  try {
    if (!trainerId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER_ID",
        message: "Invalid trainer ID.",
      });
    }

    if (!req.file || !Buffer.isBuffer(req.file.buffer)) {
      return res.status(400).json({
        success: false,
        code: "TRAINER_PHOTO_REQUIRED",
        message: "Please select a trainer photo.",
      });
    }

    let processedPhoto;

    try {
      processedPhoto = await optimizeTrainerPhoto(req.file.buffer);
    } catch (error) {
      if (error instanceof TrainerPhotoValidationError) {
        return res.status(error.statusCode || 400).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const trainerRow = await getTrainerForActor(
      connection,
      req,
      trainerId,
      true
    );

    if (!trainerRow) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "TRAINER_NOT_FOUND",
        "Trainer not found or not accessible."
      );
    }

    const oldPhotoPath = trainerRow.profile_photo_path || null;

    // Save a new unique file before changing the database reference.
    newPhotoPath = await localStorage.saveTrainerPhoto(
      organizationId,
      trainerId,
      processedPhoto.buffer
    );

    const userId = Number(req.gymStaff.userId);

    await connection.query(
      [
        "UPDATE trainers",
        "SET profile_photo_path = ?, updated_by_user_id = ?",
        "WHERE organization_id = ? AND id = ?",
      ].join(" "),
      [newPhotoPath, userId, organizationId, trainerId]
    );

    const [updatedRows] = await connection.query(
      TRAINER_SELECT + " WHERE t.organization_id = ? AND t.id = ? LIMIT 1",
      [organizationId, trainerId]
    );

    if (updatedRows.length === 0) {
      throw new Error("Trainer photo update could not be verified.");
    }

    const updatedTrainer = getTrainerResponse(updatedRows[0]);

    await writeAuditLog(connection, req, {
      action: "TRAINER_PHOTO_UPDATED",
      trainerId,
      message: "Updated profile photo for trainer " + updatedTrainer.trainer_code,
      oldValues: {
        profile_photo_path: oldPhotoPath,
      },
      newValues: {
        profile_photo_path: newPhotoPath,
        format: processedPhoto.format,
        size_bytes: processedPhoto.sizeBytes,
        original_format: processedPhoto.originalFormat,
      },
    });

    await connection.commit();
    transactionStarted = false;

    // Delete the previous file only after the database commit succeeds.
    if (oldPhotoPath && oldPhotoPath !== newPhotoPath) {
      try {
        await localStorage.deleteTrainerPhoto(
          organizationId,
          trainerId,
          oldPhotoPath
        );
      } catch (cleanupError) {
        console.error("Old trainer photo cleanup failed:", cleanupError.message);
      }
    }

    return res.json({
      success: true,
      message: "Trainer photo uploaded successfully.",
      trainer: updatedTrainer,
      photo: {
        format: processedPhoto.format,
        size_bytes: processedPhoto.sizeBytes,
        width: processedPhoto.width,
        height: processedPhoto.height,
      },
    });
  } catch (error) {
    let rollbackCompleted = false;

    if (connection && transactionStarted) {
      try {
        await connection.rollback();
        rollbackCompleted = true;
      } catch (rollbackError) {
        console.error("Trainer photo upload rollback failed:", rollbackError.message);
      }
    }

    // Keep the new file if rollback cannot be confirmed, to avoid
    // deleting a file that may still be referenced by the database.
    if (newPhotoPath && rollbackCompleted) {
      try {
        await localStorage.deleteTrainerPhoto(
          organizationId,
          trainerId,
          newPhotoPath
        );
      } catch (cleanupError) {
        console.error("New trainer photo cleanup failed:", cleanupError.message);
      }
    }

    return handleDatabaseError(res, error, "Upload trainer photo");
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

const removeTrainerPhoto = async (req, res) => {
  let connection;
  let transactionStarted = false;

  const trainerId = parsePositiveId(req.params.trainerId);
  const organizationId = Number(req.gymStaff.organizationId);

  try {
    if (!trainerId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRAINER_ID",
        message: "Invalid trainer ID.",
      });
    }

    const userId = Number(req.gymStaff.userId);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const trainerRow = await getTrainerForActor(
      connection,
      req,
      trainerId,
      true
    );

    if (!trainerRow) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "TRAINER_NOT_FOUND",
        "Trainer not found or not accessible."
      );
    }

    const oldPhotoPath = trainerRow.profile_photo_path || null;

    if (!oldPhotoPath) {
      return await rollbackAndReturn(
        connection,
        res,
        404,
        "TRAINER_PHOTO_NOT_FOUND",
        "This trainer does not have a profile photo."
      );
    }

    await connection.query(
      [
        "UPDATE trainers",
        "SET profile_photo_path = NULL, updated_by_user_id = ?",
        "WHERE organization_id = ? AND id = ?",
      ].join(" "),
      [userId, organizationId, trainerId]
    );

    const [updatedRows] = await connection.query(
      TRAINER_SELECT + " WHERE t.organization_id = ? AND t.id = ? LIMIT 1",
      [organizationId, trainerId]
    );

    if (updatedRows.length === 0) {
      throw new Error("Trainer photo removal could not be verified.");
    }

    const updatedTrainer = getTrainerResponse(updatedRows[0]);

    await writeAuditLog(connection, req, {
      action: "TRAINER_PHOTO_REMOVED",
      trainerId,
      message: "Removed profile photo for trainer " + updatedTrainer.trainer_code,
      oldValues: {
        profile_photo_path: oldPhotoPath,
      },
      newValues: {
        profile_photo_path: null,
      },
    });

    await connection.commit();
    transactionStarted = false;

    // The database no longer references the old file.
    try {
      await localStorage.deleteTrainerPhoto(
        organizationId,
        trainerId,
        oldPhotoPath
      );
    } catch (cleanupError) {
      console.error("Trainer photo removal cleanup failed:", cleanupError.message);
    }

    return res.json({
      success: true,
      message: "Trainer photo removed successfully.",
      trainer: updatedTrainer,
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Trainer photo removal rollback failed:", rollbackError.message);
      }
    }

    return handleDatabaseError(res, error, "Remove trainer photo");
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  getTrainers,
  getTrainer,
  getTrainerPhoto,
  uploadTrainerPhoto,
  removeTrainerPhoto,
  createTrainer,
  updateTrainer,
  deactivateTrainer,
  reactivateTrainer,
  getTrainerBranches,
  assignTrainerBranch,
  removeTrainerBranch,
};