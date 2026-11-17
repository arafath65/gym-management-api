const sharp = require("sharp");

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 20_000_000;
const OUTPUT_SIZE = 512;

const SUPPORTED_FORMATS = new Set([
  "jpeg",
  "png",
  "webp",
]);

class TrainerPhotoValidationError extends Error {
  constructor(message, code = "INVALID_TRAINER_PHOTO") {
    super(message);
    this.name = "TrainerPhotoValidationError";
    this.code = code;
    this.statusCode = 400;
  }
}

const optimizeTrainerPhoto = async (inputBuffer) => {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new TrainerPhotoValidationError(
      "Please select a valid trainer photo."
    );
  }

  if (inputBuffer.length > MAX_UPLOAD_BYTES) {
    throw new TrainerPhotoValidationError(
      "Trainer photo must not exceed 2 MB.",
      "TRAINER_PHOTO_TOO_LARGE"
    );
  }

  let metadata;

  try {
    metadata = await sharp(inputBuffer, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
  } catch (_) {
    throw new TrainerPhotoValidationError(
      "The selected file is not a valid image."
    );
  }

  if (!SUPPORTED_FORMATS.has(metadata.format)) {
    throw new TrainerPhotoValidationError(
      "Only JPEG, PNG and WebP images are supported.",
      "UNSUPPORTED_TRAINER_PHOTO_FORMAT"
    );
  }

  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_INPUT_PIXELS
  ) {
    throw new TrainerPhotoValidationError(
      "The selected image dimensions are not supported.",
      "INVALID_TRAINER_PHOTO_DIMENSIONS"
    );
  }

  if (metadata.pages && metadata.pages > 1) {
    throw new TrainerPhotoValidationError(
      "Animated images are not supported for trainer profiles."
    );
  }

  try {
    const optimizedBuffer = await sharp(inputBuffer, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: OUTPUT_SIZE,
        height: OUTPUT_SIZE,
        fit: "cover",
        position: "centre",
        withoutEnlargement: true,
      })
      .webp({
        quality: 82,
        effort: 4,
      })
      .toBuffer();

    return {
      buffer: optimizedBuffer,
      format: "webp",
      mimeType: "image/webp",
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      sizeBytes: optimizedBuffer.length,
      originalFormat: metadata.format,
    };
  } catch (_) {
    throw new TrainerPhotoValidationError(
      "Unable to process this image. Please select another photo."
    );
  }
};

module.exports = {
  MAX_UPLOAD_BYTES,
  OUTPUT_SIZE,
  TrainerPhotoValidationError,
  optimizeTrainerPhoto,
};