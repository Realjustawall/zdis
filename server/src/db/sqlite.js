import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * node:sqlite only accepts null | number | bigint | string | Uint8Array as a
 * bound value, so booleans/undefined/Date have to be normalised first.
 */
function bind(params) {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.getTime();
    return value;
  });
}

export function createSqlite() {
  const handle = new DatabaseSync(config.sqliteFile);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA synchronous = NORMAL');

  logger.info('database: sqlite', { file: config.sqliteFile });

  const api = {
    dialect: 'sqlite',
    async all(sql, params = []) {
      return handle.prepare(sql).all(...bind(params));
    },
    async get(sql, params = []) {
      return handle.prepare(sql).get(...bind(params)) ?? null;
    },
    async run(sql, params = []) {
      const result = handle.prepare(sql).run(...bind(params));
      return { changes: Number(result.changes ?? 0) };
    },
    async exec(sql) {
      handle.exec(sql);
    },
    /** SQLite is synchronous here, so a plain BEGIN/COMMIT is safe. */
    async tx(fn) {
      handle.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(api);
        handle.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          handle.exec('ROLLBACK');
        } catch {
          /* rollback of an already-closed tx is not actionable */
        }
        throw error;
      }
    },
    async close() {
      handle.close();
    },
  };

  return api;
}
