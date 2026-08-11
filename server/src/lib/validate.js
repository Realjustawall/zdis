import { z } from 'zod';
import { badRequest } from './errors.js';

/** Parses `source` against `schema`, turning zod issues into a 400 with detail. */
export function parse(schema, source) {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw badRequest('Validation failed.', details);
  }
  return result.data;
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Must be a valid email address.');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters.')
  .max(32, 'Username must be at most 32 characters.')
  .regex(/^[a-z0-9._-]+$/, 'Username may only contain letters, digits, dot, underscore and dash.')
  .refine((v) => !/^[._-]|[._-]$/.test(v), 'Username cannot start or end with punctuation.');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name is required.')
  .max(48, 'Display name must be at most 48 characters.');

export const roleSchema = z.enum(['admin', 'youtuber', 'member']);

export const presenceSchema = z.enum(['online', 'idle', 'dnd', 'offline']);

export const groupRoleSchema = z.enum(['owner', 'admin', 'moderator', 'member']);

export const idSchema = z
  .string()
  .trim()
  .min(4)
  .max(64)
  .regex(/^[0-9a-z]+$/, 'Malformed identifier.');

export const messageContentSchema = z
  .string()
  .max(4000, 'Message must be at most 4000 characters.');

export const paginationSchema = z.object({
  before: idSchema.optional(),
  after: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Strips C0/C1 control characters (tab and newline survive) plus the Unicode
// bidi overrides, which are the usual way to fake "this line came from
// somebody else" in a chat transcript.
const CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' +
    '\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
  'g',
);

export function sanitizeText(value, maxLength = 4000) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .slice(0, maxLength);
}

export { z };
