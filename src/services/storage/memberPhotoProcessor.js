'use strict';

const sharp = require('sharp');

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 20_000_000;
const OUTPUT_SIZE = 512;
const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

class MemberPhotoValidationError extends Error {
  constructor(message, code = 'INVALID_MEMBER_PHOTO') {
    super(message);
    this.name = 'MemberPhotoValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

const optimizeMemberPhoto = async (inputBuffer) => {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new MemberPhotoValidationError('Please select a valid member photo.');
  }
  if (inputBuffer.length > MAX_UPLOAD_BYTES) {
    throw new MemberPhotoValidationError(
      'Member photo must not exceed 2 MB.',
      'MEMBER_PHOTO_TOO_LARGE'
    );
  }

  let metadata;
  try {
    metadata = await sharp(inputBuffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
  } catch (_) {
    throw new MemberPhotoValidationError('The selected file is not a valid image.');
  }

  if (!SUPPORTED_FORMATS.has(metadata.format)) {
    throw new MemberPhotoValidationError(
      'Only JPEG, PNG and WebP images are supported.',
      'UNSUPPORTED_MEMBER_PHOTO_FORMAT'
    );
  }
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_INPUT_PIXELS
  ) {
    throw new MemberPhotoValidationError(
      'The selected image dimensions are not supported.',
      'INVALID_MEMBER_PHOTO_DIMENSIONS'
    );
  }
  if (metadata.pages && metadata.pages > 1) {
    throw new MemberPhotoValidationError('Animated images are not supported for member profiles.');
  }

  try {
    const buffer = await sharp(inputBuffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: OUTPUT_SIZE,
        height: OUTPUT_SIZE,
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();

    return {
      buffer,
      format: 'webp',
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      sizeBytes: buffer.length,
      originalFormat: metadata.format,
    };
  } catch (_) {
    throw new MemberPhotoValidationError(
      'Unable to process this image. Please select another photo.'
    );
  }
};

module.exports = {
  MAX_UPLOAD_BYTES,
  MemberPhotoValidationError,
  optimizeMemberPhoto,
};