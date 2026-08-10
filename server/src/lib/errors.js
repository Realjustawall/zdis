export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required.') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that.', details) =>
  new AppError(403, 'forbidden', message, details);
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
export const conflict = (message, details) => new AppError(409, 'conflict', message, details);
export const tooLarge = (message = 'File is too large.') =>
  new AppError(413, 'payload_too_large', message);
export const tooMany = (message = 'Too many requests. Slow down.') =>
  new AppError(429, 'rate_limited', message);

/** Wraps an async route handler so rejections reach the error middleware. */
export const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
