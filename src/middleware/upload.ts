import type { RequestHandler, Response } from 'express';
import multer from 'multer';
import { AppError, ErrorCode, errors } from '../utils/AppError';
import { type ImageType, detectImageType } from '../utils/imageType';

/**
 * Accepts one photo, sent as multipart form data in a field called "image":
 *
 *   const form = new FormData();
 *   form.append('image', file);
 *   fetch(url, { method: 'POST', body: form, headers: { Authorization: ... } });
 *
 * The photo is kept in memory (never written to the server's disk), must be
 * 2 MB or less, and must really be a JPEG, PNG or WebP image.
 */

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type UploadedImage = ImageType & { buffer: Buffer };

const parseImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
}).single('image');

function toAppError(error: unknown): AppError {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new AppError(
        413,
        ErrorCode.PAYLOAD_TOO_LARGE,
        'That photo is too large. Please choose one under 2 MB.',
      );
    }
    return errors.badRequest('Please send one photo, in a field called "image".');
  }
  return errors.badRequest("We couldn't read that upload. Please try again.");
}

export const imageUpload: RequestHandler = (req, res, next) => {
  parseImage(req, res, (error?: unknown) => {
    if (error) {
      next(toAppError(error));
      return;
    }
    const file = req.file;
    if (!file || file.size === 0) {
      next(errors.badRequest('Please choose a photo to upload.'));
      return;
    }
    const type = detectImageType(file.buffer);
    if (!type) {
      next(
        new AppError(
          415,
          ErrorCode.UNSUPPORTED_MEDIA_TYPE,
          'Please upload a JPEG, PNG or WebP photo.',
        ),
      );
      return;
    }
    res.locals.image = { ...type, buffer: file.buffer } satisfies UploadedImage;
    next();
  });
};

/** The photo checked by imageUpload. */
export function uploadedImage(res: Response): UploadedImage {
  const image = res.locals.image as UploadedImage | undefined;
  if (!image) throw errors.badRequest('Please choose a photo to upload.');
  return image;
}
