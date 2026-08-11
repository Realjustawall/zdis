import multer from 'multer';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found.' } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, _next) {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds the ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB limit.`
        : 'Upload rejected.';
    return res.status(413).json({ error: { code: 'payload_too_large', message } });
  }

  if (error instanceof AppError) {
    if (error.status >= 500) logger.error(error.message, { code: error.code });
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }

  if (error?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: { code: 'payload_too_large', message: 'Request body is too large.' } });
  }

  if (error?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { code: 'bad_request', message: 'Request body is not valid JSON.' } });
  }

  logger.error('unhandled error', {
    message: error?.message,
    stack: config.isProd ? undefined : error?.stack,
    path: req.originalUrl,
  });

  return res.status(500).json({
    error: {
      code: 'internal_error',
      message: config.isProd ? 'Something went wrong.' : String(error?.message ?? error),
    },
  });
}
