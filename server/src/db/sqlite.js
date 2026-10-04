import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  fs.mkdirSync(path.dirname(config.sqliteFile), { recursive: true });
  const handle = new DatabaseSync(config.sqliteFile);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA synchronous = NORMAL');

  // Bounded reuse avoids preparing the same queries for each chat event.
  const statements = new Map();
  const transactionContext = new AsyncLocalStorage();
  let transactionTail = Promise.resolve();
  async function outsideTransaction(operation) {
    if (transactionContext.getStore()?.active) return operation();
    for (;;) {
      const barrier = transactionTail;
      await barrier;
      // Run synchronously after checking the barrier; a newer BEGIN cannot
      // slip between a separate async wait helper and the actual SQL call.
      if (barrier === transactionTail) return operation();
    }
  }
  function prepare(sql) {
    let statement = statements.get(sql);
    if (statement) return statement;
    statement = handle.prepare(sql);
    if (config.sqliteStatementCache > 0) {
      if (statements.size >= config.sqliteStatementCache) statements.delete(statements.keys().next().value);
      statements.set(sql, statement);
    }
    return statement;
  }

  logger.info('database: sqlite', { file: config.sqliteFile });

  const api = {
    dialect: 'sqlite',
    async all(sql, params = []) {
      return outsideTransaction(() => prepare(sql).all(...bind(params)));
    },
    async get(sql, params = []) {
      return outsideTransaction(() => prepare(sql).get(...bind(params)) ?? null);
    },
    async run(sql, params = []) {
      return outsideTransaction(() => {
        const result = prepare(sql).run(...bind(params));
        return { changes: Number(result.changes ?? 0) };
      });
    },
    async exec(sql) {
      return outsideTransaction(() => { statements.clear(); handle.exec(sql); });
    },
    /** Keep unrelated asynchronous requests outside another request's transaction. */
    async tx(fn) {
      if (transactionContext.getStore()?.active) return fn(api);
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        const context = { active: true };
        return await transactionContext.run(context, async () => {
          handle.exec('BEGIN IMMEDIATE');
          try {
            const result = await fn(api);
            handle.exec('COMMIT');
            return result;
          } catch (error) {
            try { handle.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
            throw error;
          } finally {
            context.active = false;
          }
        });
      } finally {
        release();
      }
    },
    async close() {
      return outsideTransaction(() => {
        statements.clear();
        try { handle.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
        finally { handle.close(); }
      });
    },
  };

  return api;
}
