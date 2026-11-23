'use strict';

const sharp = require('sharp');

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_INPUT_PIXELS = 24_000_000;
const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

class GymProfileLogoValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GymProfileLogoValidationError';
  }
}

const optimizeGymProfileLogo = async (inputBuffer) => {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new GymProfileLogoValidationError(
      'Please select a valid gym logo.'
    );
  }

  if (inputBuffer.length > MAX_UPLOAD_BYTES) {
    throw new GymProfileLogoValidationError(
      'Gym logo must not exceed 3 MB.'
    );
  }

  try {
    const image = sharp(inputBuffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    });

    const metadata = await image.metadata();

    if (!SUPPORTED_FORMATS.has(metadata.format)) {
      throw new GymProfileLogoValidationError(
        'Only JPEG, PNG and WebP logos are supported.'
      );
    }

    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_INPUT_PIXELS
    ) {
      throw new GymProfileLogoValidationError(
        'The logo dimensions are invalid or too large.'
      );
    }

    return await sharp(inputBuffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: 1600,
        height: 1200,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality: 86,
        alphaQuality: 90,
        effort: 5,
      })
      .toBuffer();
  } catch (error) {
    if (error instanceof GymProfileLogoValidationError) {
      throw error;
    }

    throw new GymProfileLogoValidationError(
      'The selected file is not a valid supported image.'
    );
  }
};

module.exports = {
  MAX_UPLOAD_BYTES,
  GymProfileLogoValidationError,
  optimizeGymProfileLogo,
};
