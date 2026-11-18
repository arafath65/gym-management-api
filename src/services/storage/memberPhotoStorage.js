'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const getStorageRoot = () => path.resolve(
  process.env.UPLOAD_ROOT || path.join(process.cwd(), 'uploads')
);

const resolveMemberPhotoPath = (organizationId, memberId, relativePath) => {
  const parts = String(relativePath || '').replace(/\\/g, '/').split('/');
  const expectedFile = /^profile-[0-9a-f-]+\.webp$/i;

  if (
    parts.length !== 5 ||
    parts[0] !== 'organizations' ||
    parts[1] !== String(organizationId) ||
    parts[2] !== 'members' ||
    parts[3] !== String(memberId) ||
    !expectedFile.test(parts[4])
  ) {
    throw new Error('Invalid member photo storage key.');
  }

  const root = getStorageRoot();
  const absolutePath = path.resolve(root, ...parts);
  const relative = path.relative(root, absolutePath);

  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Invalid member photo path.');
  }

  return absolutePath;
};

const saveMemberPhoto = async (organizationId, memberId, buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('A valid member photo buffer is required.');
  }

  const root = getStorageRoot();
  const directory = path.join(
    root,
    'organizations',
    String(organizationId),
    'members',
    String(memberId)
  );
  const fileName = `profile-${randomUUID()}.webp`;
  const absolutePath = path.join(directory, fileName);
  const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');

  // Validate the exact generated key before writing it.
  resolveMemberPhotoPath(organizationId, memberId, relativePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o750 });
  await fs.writeFile(absolutePath, buffer, { flag: 'wx', mode: 0o640 });

  return relativePath;
};

const readMemberPhoto = async (organizationId, memberId, relativePath) => {
  const absolutePath = resolveMemberPhotoPath(organizationId, memberId, relativePath);
  return fs.readFile(absolutePath);
};

const deleteMemberPhoto = async (organizationId, memberId, relativePath) => {
  if (!relativePath) return false;
  const absolutePath = resolveMemberPhotoPath(organizationId, memberId, relativePath);
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
  saveMemberPhoto,
  readMemberPhoto,
  deleteMemberPhoto,
};