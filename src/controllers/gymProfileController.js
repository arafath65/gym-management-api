'use strict';

const db = require('../config/db');

const { writeAuditLog } = require('../services/gymAuditService');

const {
  saveGymProfileLogo,
  readGymProfileLogo,
  deleteGymProfileLogo,
} = require('../services/storage/gymProfileLogoStorage');

const {
  GymProfileLogoValidationError,
  optimizeGymProfileLogo,
} = require('../services/storage/gymProfileLogoProcessor');

class GymProfileValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GymProfileValidationError';
  }
}

const getOrganizationId = (req) => {
  const id = Number(req.gymStaff?.organizationId);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Valid Gym Staff organization context is required.');
  }

  return id;
};

const getAuditContext = (req, organizationId) => ({
  organizationId,
  branchId: req.gymStaff?.branchId,
  userId: req.gymStaff?.userId,
});

const toProfileResponse = (row) => ({
  organizationId: Number(row.id),
  name: row.name || '',
  address: row.address || '',
  phone: row.phone || '',
  whatsappPhone: row.whatsapp_phone || '',
  email: row.email || '',
  website: row.website || '',
  hasLogo: Boolean(row.logo_storage_key),
  updatedAt: row.updated_at || null,
});

const getProfileRow = async (connection, organizationId, lock = false) => {
  const [rows] = await connection.query(
    `SELECT
       id,
       name,
       address,
       phone,
       email,
       website,
       whatsapp_phone,
       logo_storage_key,
       updated_at
     FROM organizations
     WHERE id = ?
      LIMIT 1
      ${lock ? 'FOR UPDATE' : ''}`,
    [organizationId]
  );

  return rows[0] || null;
};

const normalizeText = (value, fallback, fieldName, maxLength) => {
  const input = value === undefined ? fallback : value;

  if (input === null || input === undefined) {
    return null;
  }

  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new GymProfileValidationError(
      `${fieldName} must be text.`
    );
  }

  const normalized = String(input).trim();

  if (!normalized) return null;

  if (normalized.length > maxLength) {
    throw new GymProfileValidationError(
      `${fieldName} cannot exceed ${maxLength} characters.`
    );
  }

  return normalized;
};

const normalizeWebsite = (value, fallback) => {
  const website = normalizeText(
    value,
    fallback,
    'Website',
    255
  );

  if (!website) return null;

  const candidate = /^https?:\/\//i.test(website)
    ? website
    : `https://${website}`;

  let parsed;

  try {
    parsed = new URL(candidate);
  } catch {
    throw new GymProfileValidationError(
      'Please enter a valid website address.'
    );
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname
  ) {
    throw new GymProfileValidationError(
      'Website must use a valid HTTP or HTTPS address.'
    );
  }

  return candidate;
};

const normalizeProfileInput = (body, existing) => {
  const name = normalizeText(
    body.name,
    existing.name,
    'Gym name',
    255
  );

  if (!name) {
    throw new GymProfileValidationError(
      'Gym name is required.'
    );
  }

  const address = normalizeText(
    body.address,
    existing.address,
    'Address',
    5000
  );

  const phone = normalizeText(
    body.phone,
    existing.phone,
    'Contact number',
    30
  );

  const whatsappPhone = normalizeText(
    body.whatsapp_phone ?? body.whatsappPhone,
    existing.whatsapp_phone,
    'WhatsApp number',
    30
  );

  const email = normalizeText(
    body.email,
    existing.email,
    'Email',
    255
  );

  if (
    email &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new GymProfileValidationError(
      'Please enter a valid email address.'
    );
  }

  const website = normalizeWebsite(
    body.website,
    existing.website
  );

  return {
    name,
    address,
    phone,
    whatsapp_phone: whatsappPhone,
    email,
    website,
  };
};

// GET /api/gym-profile
const getGymProfile = async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const row = await getProfileRow(db, organizationId);

    if (!row) {
      return res.status(404).json({
        success: false,
        message: 'Gym organization was not found.',
      });
    }

    return res.json({
      success: true,
      profile: toProfileResponse(row),
    });
  } catch (error) {
    console.error('Get gym profile error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to load gym profile.',
    });
  }
};

// PUT /api/gym-profile
const updateGymProfile = async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const organizationId = getOrganizationId(req);
    const body = req.body || {};

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const existing = await getProfileRow(
      connection,
      organizationId,
      true
    );

    if (!existing) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: 'Gym organization was not found.',
      });
    }

    const nextValues = normalizeProfileInput(body, existing);

    await connection.query(
      `UPDATE organizations
       SET
         name = ?,
         address = ?,
         phone = ?,
         email = ?,
         website = ?,
         whatsapp_phone = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        nextValues.name,
        nextValues.address,
        nextValues.phone,
        nextValues.email,
        nextValues.website,
        nextValues.whatsapp_phone,
        organizationId,
      ]
    );

    await writeAuditLog(
      connection,
      req,
      getAuditContext(req, organizationId),
      {
        action: 'gym_profile.updated',
        entityType: 'gym_profile',
        entityId: organizationId,
        description: 'Gym profile details updated.',
        oldValues: {
          name: existing.name,
          address: existing.address,
          phone: existing.phone,
          whatsapp_phone: existing.whatsapp_phone,
          email: existing.email,
          website: existing.website,
        },
        newValues: nextValues,
      }
    );

    await connection.commit();
    transactionStarted = false;

    const [updatedRows] = await db.query(
      `SELECT
         id,
         name,
         address,
         phone,
         email,
         website,
         whatsapp_phone,
         logo_storage_key,
         updated_at
       FROM organizations
       WHERE id = ?
       LIMIT 1`,
      [organizationId]
    );

    return res.json({
      success: true,
      message: 'Gym profile updated successfully.',
      profile: toProfileResponse(updatedRows[0]),
    });
  } catch (error) {
    if (transactionStarted && connection) {
      await connection.rollback().catch(() => {});
    }

    if (error instanceof GymProfileValidationError) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    console.error('Update gym profile error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update gym profile.',
      ...(process.env.NODE_ENV !== 'production'
        ? {
            debug: {
              name: error.name,
              message: error.message,
              code: error.code ?? null,
              sqlMessage: error.sqlMessage ?? null,
              sqlState: error.sqlState ?? null,
              stack: error.stack ?? null,
            },
          }
        : {}),
    });
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/gym-profile/logo
const getGymProfileLogo = async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    const [rows] = await db.query(
      `SELECT logo_storage_key
       FROM organizations
       WHERE id = ?
       LIMIT 1`,
      [organizationId]
    );

    if (!rows.length || !rows[0].logo_storage_key) {
      return res.status(404).json({
        success: false,
        message: 'Gym logo has not been uploaded.',
      });
    }

    const imageBuffer = await readGymProfileLogo(
      organizationId,
      rows[0].logo_storage_key
    );

    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');

    return res.send(imageBuffer);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({
        success: false,
        message: 'Gym logo file was not found.',
      });
    }

    console.error('Get gym profile logo error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve gym logo.',
    });
  }
};

// POST /api/gym-profile/logo
const uploadGymProfileLogo = async (req, res) => {
  let connection;
  let transactionStarted = false;
  let newStorageKey = null;
  let oldStorageKey = null;

  try {
    const organizationId = getOrganizationId(req);

    if (!req.file?.buffer) {
      return res.status(400).json({
        success: false,
        message: 'Please select a logo image to upload.',
      });
    }

    const optimizedBuffer = await optimizeGymProfileLogo(
      req.file.buffer
    );

    // Write the new private file before changing the database reference.
    newStorageKey = await saveGymProfileLogo(
      organizationId,
      optimizedBuffer
    );

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const existing = await getProfileRow(
      connection,
      organizationId,
      true
    );

    if (!existing) {
      await connection.rollback();
      transactionStarted = false;

      await deleteGymProfileLogo(
        organizationId,
        newStorageKey
      );

      return res.status(404).json({
        success: false,
        message: 'Gym organization was not found.',
      });
    }

    oldStorageKey = existing.logo_storage_key || null;

    await connection.query(
      `UPDATE organizations
       SET
         logo_storage_key = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newStorageKey, organizationId]
    );

    await writeAuditLog(
      connection,
      req,
      getAuditContext(req, organizationId),
      {
        action: 'gym_profile.logo_uploaded',
        entityType: 'gym_profile',
        entityId: organizationId,
        description: 'Gym profile logo uploaded or replaced.',
        oldValues: {
          has_logo: Boolean(oldStorageKey),
        },
        newValues: {
          has_logo: true,
        },
      }
    );

    await connection.commit();
    transactionStarted = false;

    // Delete the previous file only after the database commit succeeds.
    if (oldStorageKey && oldStorageKey !== newStorageKey) {
      try {
        await deleteGymProfileLogo(
          organizationId,
          oldStorageKey
        );
      } catch (cleanupError) {
        console.error(
          'Old gym logo cleanup warning:',
          cleanupError.message
        );
      }
    }

    return res.json({
      success: true,
      message: 'Gym logo uploaded successfully.',
      hasLogo: true,
    });
  } catch (error) {
    if (transactionStarted && connection) {
      await connection.rollback().catch(() => {});
    }

    if (newStorageKey) {
      await deleteGymProfileLogo(
        Number(req.gymStaff?.organizationId),
        newStorageKey
      ).catch(() => {});
    }

    if (
      error instanceof GymProfileLogoValidationError
    ) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    console.error('Upload gym profile logo error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to upload gym logo.',
      ...(process.env.NODE_ENV !== 'production'
        ? {
            debug: {
              name: error.name,
              message: error.message,
              code: error.code ?? null,
              sqlMessage: error.sqlMessage ?? null,
              sqlState: error.sqlState ?? null,
              stack: error.stack ?? null,
            },
          }
        : {}),
    });
  } finally {
    if (connection) connection.release();
  }
};

// DELETE /api/gym-profile/logo
const removeGymProfileLogo = async (req, res) => {
  let connection;
  let transactionStarted = false;
  let oldStorageKey = null;

  try {
    const organizationId = getOrganizationId(req);

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const existing = await getProfileRow(
      connection,
      organizationId,
      true
    );

    if (!existing) {
      await connection.rollback();
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: 'Gym organization was not found.',
      });
    }

    oldStorageKey = existing.logo_storage_key || null;

    if (!oldStorageKey) {
      await connection.commit();
      transactionStarted = false;

      return res.json({
        success: true,
        message: 'No gym logo was configured.',
        hasLogo: false,
      });
    }

    await connection.query(
      `UPDATE organizations
       SET
         logo_storage_key = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [organizationId]
    );

    await writeAuditLog(
      connection,
      req,
      getAuditContext(req, organizationId),
      {
        action: 'gym_profile.logo_removed',
        entityType: 'gym_profile',
        entityId: organizationId,
        description: 'Gym profile logo removed.',
        oldValues: {
          has_logo: true,
        },
        newValues: {
          has_logo: false,
        },
      }
    );

    await connection.commit();
    transactionStarted = false;

    try {
      await deleteGymProfileLogo(
        organizationId,
        oldStorageKey
      );
    } catch (cleanupError) {
      console.error(
        'Removed gym logo cleanup warning:',
        cleanupError.message
      );
    }

    return res.json({
      success: true,
      message: 'Gym logo removed successfully.',
      hasLogo: false,
    });
  } catch (error) {
    if (transactionStarted && connection) {
      await connection.rollback().catch(() => {});
    }

    console.error('Remove gym profile logo error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to remove gym logo.',
    });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getGymProfile,
  updateGymProfile,
  getGymProfileLogo,
  uploadGymProfileLogo,
  removeGymProfileLogo,
};
