'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const getStorageRoot = () => {
  const configuredRoot = process.env.UPLOAD_ROOT;

  return path.resolve(
    configuredRoot && configuredRoot.trim()
      ? configuredRoot.trim()
      : path.join(process.cwd(), 'storage', 'uploads')
  );
};

const validateOrganizationId = (value) => {
  const id = Number(value);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Invalid organization ID.');
  }

  return String(id);
};

const getProfilePrefix = (organizationId) => {
  const organization = validateOrganizationId(organizationId);
  return `organizations/${organization}/profile/`;
};

const resolveGymLogoPath = (organizationId, storageKey) => {
  const prefix = getProfilePrefix(organizationId);

  if (
    typeof storageKey !== 'string' ||
    !storageKey.startsWith(prefix)
  ) {
    throw new Error('Invalid gym logo storage key.');
  }

  const fileName = storageKey.slice(prefix.length);

  if (!/^logo-[0-9a-f-]{36}\.webp$/i.test(fileName)) {
    throw new Error('Invalid gym logo filename.');
  }

  const root = getStorageRoot();
  const absolutePath = path.resolve(root, ...storageKey.split('/'));
  const relativeFromRoot = path.relative(root, absolutePath);

  if (
    !relativeFromRoot ||
    relativeFromRoot === '..' ||
    relativeFromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error('Invalid gym logo storage path.');
  }

  return absolutePath;
};

const saveGymProfileLogo = async (organizationId, imageBuffer) => {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error('A valid gym logo image buffer is required.');
  }

  const prefix = getProfilePrefix(organizationId);
  const storageKey = `${prefix}logo-${randomUUID()}.webp`;

  const absolutePath = resolveGymLogoPath(
    organizationId,
    storageKey
  );

  await fs.mkdir(path.dirname(absolutePath), {
    recursive: true,
    mode: 0o750,
  });

  await fs.writeFile(absolutePath, imageBuffer, {
    flag: 'wx',
    mode: 0o640,
  });

  return storageKey;
};

const readGymProfileLogo = async (organizationId, storageKey) => {
  const absolutePath = resolveGymLogoPath(
    organizationId,
    storageKey
  );

  return fs.readFile(absolutePath);
};

const deleteGymProfileLogo = async (organizationId, storageKey) => {
  if (!storageKey) return false;

  const absolutePath = resolveGymLogoPath(
    organizationId,
    storageKey
  );

  try {
    await fs.unlink(absolutePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

module.exports = {
  getStorageRoot,
  saveGymProfileLogo,
  readGymProfileLogo,
  deleteGymProfileLogo,
};
