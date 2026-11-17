const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const getStorageRoot = () => {
  const configuredRoot = process.env.UPLOAD_ROOT;

  return path.resolve(
    configuredRoot && configuredRoot.trim()
      ? configuredRoot.trim()
      : path.join(process.cwd(), "storage", "uploads")
  );
};

const validateId = (value, label) => {
  const id = Number(value);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid ${label}.`);
  }

  return String(id);
};

const getTrainerPrefix = (organizationId, trainerId) => {
  const organization = validateId(organizationId, "organization ID");
  const trainer = validateId(trainerId, "trainer ID");

  return `organizations/${organization}/trainers/${trainer}/`;
};

const resolveTrainerPhotoPath = (
  organizationId,
  trainerId,
  relativePath
) => {
  const prefix = getTrainerPrefix(organizationId, trainerId);

  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("Invalid trainer photo path.");
  }

  const normalized = relativePath.replace(/\\/g, "/");

  if (!normalized.startsWith(prefix)) {
    throw new Error("Trainer photo path is outside its organization scope.");
  }

  const parts = normalized.split("/");

  if (
    parts.length !== 5 ||
    parts[0] !== "organizations" ||
    parts[2] !== "trainers" ||
    !/^profile-[0-9a-f-]+\.webp$/i.test(parts[4])
  ) {
    throw new Error("Invalid trainer photo storage key.");
  }

  const root = getStorageRoot();
  const absolutePath = path.resolve(root, ...parts);
  const relativeFromRoot = path.relative(root, absolutePath);

  if (
    !relativeFromRoot ||
    relativeFromRoot === ".." ||
    relativeFromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error("Invalid storage path.");
  }

  return absolutePath;
};

const ensureStorageRoot = async () => {
  const root = getStorageRoot();

  await fs.mkdir(root, {
    recursive: true,
    mode: 0o750,
  });

  return root;
};

const saveTrainerPhoto = async (
  organizationId,
  trainerId,
  imageBuffer
) => {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("A valid image buffer is required.");
  }

  const prefix = getTrainerPrefix(organizationId, trainerId);
  const fileName = `profile-${randomUUID()}.webp`;
  const relativePath = `${prefix}${fileName}`;

  const absolutePath = resolveTrainerPhotoPath(
    organizationId,
    trainerId,
    relativePath
  );

  await fs.mkdir(path.dirname(absolutePath), {
    recursive: true,
    mode: 0o750,
  });

  await fs.writeFile(absolutePath, imageBuffer, {
    flag: "wx",
    mode: 0o640,
  });

  return relativePath;
};

const readTrainerPhoto = async (
  organizationId,
  trainerId,
  relativePath
) => {
  const absolutePath = resolveTrainerPhotoPath(
    organizationId,
    trainerId,
    relativePath
  );

  return fs.readFile(absolutePath);
};

const deleteTrainerPhoto = async (
  organizationId,
  trainerId,
  relativePath
) => {
  if (!relativePath) {
    return false;
  }

  const absolutePath = resolveTrainerPhotoPath(
    organizationId,
    trainerId,
    relativePath
  );

  try {
    await fs.unlink(absolutePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

module.exports = {
  getStorageRoot,
  ensureStorageRoot,
  saveTrainerPhoto,
  readTrainerPhoto,
  deleteTrainerPhoto,
};