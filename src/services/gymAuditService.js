'use strict';

const toPositiveId = (value) => {
  if (value === null || value === undefined || value === '') return null;

  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const jsonValue = (value) => {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
};

const stableValue = (value) => {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value);
};

const dateValue = (row) =>
  row.date_of_birth_text ?? row.date_of_birth ?? null;

/*
 * Actual before/after values are restricted to operational fields.
 * Sensitive personal values are never written to audit snapshots.
 */
const SAFE_PROFILE_VALUE_FIELDS = new Set([
  'preferred_branch_id',
  'registration_source',
  'admission_fee_amount',
  'admission_fee_currency',
  'admission_fee_status',
  'status',
]);

const PROFILE_COMPARATORS = [
  ['nic', (row) => row.nic_lookup_hash],
  ['nic_type', (row) => row.nic_type],
  ['full_name', (row) => row.full_name],
  ['date_of_birth', dateValue],
  ['date_of_birth_source', (row) => row.date_of_birth_source],
  ['date_of_birth_confirmed', (row) => Boolean(row.date_of_birth_confirmed)],
  ['gender', (row) => row.gender],
  ['phone_primary', (row) => row.phone_primary],
  ['phone_secondary', (row) => row.phone_secondary],
  ['email', (row) => row.email],
  ['address', (row) => row.address],
  ['city', (row) => row.city],
  ['emergency_contact_name', (row) => row.emergency_contact_name],
  ['emergency_contact_relationship', (row) => row.emergency_contact_relationship],
  ['emergency_contact_phone', (row) => row.emergency_contact_phone],
  ['registration_source', (row) => row.registration_source],
  ['referred_by', (row) => row.referred_by],
  ['preferred_branch_id', (row) => row.preferred_branch_id],
  ['admission_fee_amount', (row) => row.admission_fee_amount],
  ['admission_fee_currency', (row) => row.admission_fee_currency],
  ['admission_fee_status', (row) => row.admission_fee_status],
  ['status', (row) => row.status],
];

const snapshotValue = (field, value) => {
  if (value === null || value === undefined) return null;

  if (field === 'preferred_branch_id') {
    return toPositiveId(value);
  }

  if (field === 'admission_fee_amount') {
    return String(value);
  }

  return value;
};

const buildMemberProfileSnapshots = (oldRow, newRow) => {
  const changedFields = [];

  for (const [field, getter] of PROFILE_COMPARATORS) {
    if (stableValue(getter(oldRow)) !== stableValue(getter(newRow))) {
      changedFields.push(field);
    }
  }

  const oldValues = {
    changed_fields: changedFields,
  };

  const newValues = {
    changed_fields: changedFields,
  };

  for (const field of changedFields) {
    if (!SAFE_PROFILE_VALUE_FIELDS.has(field)) continue;

    oldValues[field] = snapshotValue(field, oldRow[field]);
    newValues[field] = snapshotValue(field, newRow[field]);
  }

  return {
    oldValues,
    newValues,
    changedFields,
  };
};

const buildMemberAuditMetadata = (member, extra = {}) => ({
  member: {
    id: toPositiveId(member?.id),
    member_code: member?.member_code ?? null,

    registration_branch: {
      id: toPositiveId(member?.registration_branch_id),
      name: member?.registration_branch_name ?? null,
      code: member?.registration_branch_code ?? null,
    },
  },

  ...extra,
});

const writeAuditLog = async (connection, req, context, entry) => {
  if (!connection || typeof connection.query !== 'function') {
    throw new Error('A valid database connection is required for audit logging.');
  }

  const organizationId = toPositiveId(context?.organizationId);
  const branchId = toPositiveId(context?.branchId);
  const userId = toPositiveId(context?.userId);

  if (!organizationId || !branchId || !userId) {
    throw new Error(
      'Valid organization, action branch and Gym Staff user are required.'
    );
  }

  if (!entry?.action || !entry?.entityType) {
    throw new Error('Audit action and entity type are required.');
  }

  const userAgent = typeof req?.get === 'function'
    ? req.get('user-agent')
    : null;

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
        user_agent,
        old_values,
        new_values,
        metadata
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId,
      branchId,
      userId,
      entry.action,
      entry.entityType,
      toPositiveId(entry.entityId),
      entry.description || null,
      req?.ip || null,
      userAgent ? String(userAgent).substring(0, 500) : null,
      jsonValue(entry.oldValues),
      jsonValue(entry.newValues),
      jsonValue(entry.metadata),
    ]
  );
};

module.exports = {
  writeAuditLog,
  buildMemberAuditMetadata,
  buildMemberProfileSnapshots,
};