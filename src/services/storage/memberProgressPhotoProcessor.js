'use strict';

const sharp = require('sharp');

// Full-body comparison images need to retain their complete frame. Unlike
// profile avatars, these images are contained, not center-cropped.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const OUTPUT_WIDTH = 1200;
const OUTPUT_HEIGHT = 1600;
const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

class MemberProgressPhotoValidationError extends Error {
  constructor(message, code = 'INVALID_MEMBER_PROGRESS_PHOTO') {
    super(message);
    this.name = 'MemberProgressPhotoValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

const optimizeMemberProgressPhoto = async (inputBuffer) => {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new MemberProgressPhotoValidationError('Please select a valid assessment photo.');
  }

  if (inputBuffer.length > MAX_UPLOAD_BYTES) {
    throw new MemberProgressPhotoValidationError(
      'Assessment photo must not exceed 8 MB.',
      'MEMBER_PROGRESS_PHOTO_TOO_LARGE'
    );
  }

  let metadata;
  try {
    metadata = await sharp(inputBuffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
  } catch (_) {
    throw new MemberProgressPhotoValidationError('The selected file is not a valid image.');
  }

  if (!SUPPORTED_FORMATS.has(metadata.format)) {
    throw new MemberProgressPhotoValidationError(
      'Only JPEG, PNG and WebP images are supported.',
      'UNSUPPORTED_MEMBER_PROGRESS_PHOTO_FORMAT'
    );
  }

  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_INPUT_PIXELS
  ) {
    throw new MemberProgressPhotoValidationError(
      'The selected image dimensions are not supported.',
      'INVALID_MEMBER_PROGRESS_PHOTO_DIMENSIONS'
    );
  }

  if (metadata.pages && metadata.pages > 1) {
    throw new MemberProgressPhotoValidationError('Animated images are not supported.');
  }

  try {
    const result = await sharp(inputBuffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 84, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: result.data,
      format: 'webp',
      mimeType: 'image/webp',
      width: result.info.width,
      height: result.info.height,
      sizeBytes: result.data.length,
      originalFormat: metadata.format,
    };
  } catch (_) {
    throw new MemberProgressPhotoValidationError(
      'Unable to process this assessment photo. Please select another image.'
    );
  }
};

module.exports = {
  MAX_UPLOAD_BYTES,
  MemberProgressPhotoValidationError,
  optimizeMemberProgressPhoto,
};