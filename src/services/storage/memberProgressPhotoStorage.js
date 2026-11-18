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

const validateId = (value, label) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return String(id);
};

const getPhotoPrefix = (organizationId, memberId, progressId) => {
  const organization = validateId(organizationId, 'organization ID');
  const member = validateId(memberId, 'member ID');
  const progress = validateId(progressId, 'fitness assessment ID');
  return `organizations/${organization}/members/${member}/fitness/${progress}/`;
};

const resolvePhotoPath = (organizationId, memberId, progressId, relativePath) => {
  const prefix = getPhotoPrefix(organizationId, memberId, progressId);

  if (typeof relativePath !== 'string' || !relativePath.startsWith(prefix)) {
    throw new Error('Invalid member progress photo storage key.');
  }

  const fileName = relativePath.slice(prefix.length);
  if (!/^(front|side|back)-[0-9a-f-]+\.webp$/i.test(fileName)) {
    throw new Error('Invalid member progress photo filename.');
  }

  const root = getStorageRoot();
  const absolutePath = path.resolve(root, ...relativePath.split('/'));
  const relativeFromRoot = path.relative(root, absolutePath);

  if (
    !relativeFromRoot ||
    relativeFromRoot === '..' ||
    relativeFromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error('Invalid member progress photo path.');
  }

  return absolutePath;
};

const saveMemberProgressPhoto = async (
  organizationId,
  memberId,
  progressId,
  photoType,
  imageBuffer
) => {
  if (!['front', 'side', 'back'].includes(photoType)) {
    throw new Error('Invalid member progress photo type.');
  }
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error('A valid image buffer is required.');
  }

  const prefix = getPhotoPrefix(organizationId, memberId, progressId);
  const relativePath = `${prefix}${photoType}-${randomUUID()}.webp`;
  const absolutePath = resolvePhotoPath(
    organizationId,
    memberId,
    progressId,
    relativePath
  );

  await fs.mkdir(path.dirname(absolutePath), {
    recursive: true,
    mode: 0o750,
  });

  await fs.writeFile(absolutePath, imageBuffer, {
    flag: 'wx',
    mode: 0o640,
  });

  return relativePath;
};

const readMemberProgressPhoto = async (
  organizationId,
  memberId,
  progressId,
  relativePath
) => {
  const absolutePath = resolvePhotoPath(
    organizationId,
    memberId,
    progressId,
    relativePath
  );
  return fs.readFile(absolutePath);
};

const deleteMemberProgressPhoto = async (
  organizationId,
  memberId,
  progressId,
  relativePath
) => {
  if (!relativePath) return false;

  const absolutePath = resolvePhotoPath(
    organizationId,
    memberId,
    progressId,
    relativePath
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
  saveMemberProgressPhoto,
  readMemberProgressPhoto,
  deleteMemberProgressPhoto,
};