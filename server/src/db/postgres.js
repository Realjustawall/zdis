import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Rewrites the portable `?` placeholders used across the codebase into the
 * `$1, $2, ...` form PostgreSQL expects. Quoted literals are skipped so a
 * question mark inside a string is never mistaken for a placeholder.
 */
export function toPgPlaceholders(sql) {
  let out = '';
  let index = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      out += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '?') {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return out;
}

function normalize(params) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

function wrap(runner, dialectExtras = {}) {
  return {
    dialect: 'postgres',
    async all(sql, params = []) {
      const result = await runner(toPgPlaceholders(sql), normalize(params));
      return result.rows;
    },
    async get(sql, params = []) {
      const result = await runner(toPgPlaceholders(sql), normalize(params));
      return result.rows[0] ?? null;
    },
    async run(sql, params = []) {
      const result = await runner(toPgPlaceholders(sql), normalize(params));
      return { changes: result.rowCount ?? 0 };
    },
    async exec(sql) {
      await runner(sql, []);
    },
    ...dialectExtras,
  };
}

export async function createPostgres(connectionString = config.databaseUrl, label = 'postgres') {
  const { default: pgLib } = await import('pg');
  const { Pool, types } = pgLib;

  // int8 (BIGINT) arrives as a string by default; every bigint we store is an
  // epoch-ms timestamp or a byte count, both comfortably inside Number range.
  types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

  const pool = new Pool({
    connectionString: connectionString || undefined,
    max: config.postgresPoolMax,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });

  // Fail fast so the caller can fall back to SQLite.
  const probe = await pool.connect();
  probe.release();

  pool.on('error', (error) => logger.error('postgres pool error', { error: error.message }));

  const api = wrap((text, values) => pool.query(text, values), {
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const scoped = wrap((text, values) => client.query(text, values), {
          tx: (inner) => inner(scoped),
        });
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection already broken */
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  });

  logger.info(`database: ${label}`);
  return api;
}
