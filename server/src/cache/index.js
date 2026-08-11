import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Cache facade. Backed by Redis when REDIS_URL points at a reachable server,
 * otherwise by a bounded in-process map. Callers never need to know which.
 */

let client = null;
let mode = 'memory';

const memory = new Map();
const MEMORY_LIMIT = 5000;

function memorySet(key, value, ttlSeconds) {
  if (memory.size >= MEMORY_LIMIT) {
    // Cheap eviction: drop the oldest insertion.
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
}

function memoryGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expires && entry.expires < Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

export async function initCache() {
  if (!config.redisUrl && !config.redisClusterNodes.length) {
    logger.info('cache: in-memory (set REDIS_URL to enable redis)');
    return { mode };
  }
  try {
    client = await createRedisConnection({ lazyConnect: true, maxRetriesPerRequest: 2 });
    client.on('error', (error) => logger.warn('redis error', { error: error.message }));
    await client.connect();
    await client.ping();
    mode = 'redis';
    logger.info('cache: redis');
  } catch (error) {
    if (config.requireRedis) throw error;
    logger.warn('redis unavailable, using in-memory cache', { error: error.message });
    if (client) {
      client.disconnect();
      client = null;
    }
    mode = 'memory';
  }
  return { mode };
}

export async function createRedisConnection(options = {}) {
  const { default: Redis } = await import('ioredis');
  const common = {
    lazyConnect: options.lazyConnect ?? false,
    maxRetriesPerRequest: Object.prototype.hasOwnProperty.call(options, 'maxRetriesPerRequest') ? options.maxRetriesPerRequest : 2,
    connectTimeout: 3000,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
  };
  if (config.redisClusterNodes.length) {
    const nodes = config.redisClusterNodes.map((entry) => {
      const [host, port = '6379'] = entry.split(':');
      return { host, port: Number(port) };
    });
    const { lazyConnect, ...redisOptions } = common;
    return new Redis.Cluster(nodes, {
      lazyConnect,
      redisOptions,
      clusterRetryStrategy: (times) => Math.min(times * 250, 3000),
      enableReadyCheck: true,
    });
  }
  return new Redis(config.redisUrl, common);
}

/** Raw client for the Socket.IO adapter; null when Redis is not in use. */
export function getRedis() {
  return mode === 'redis' ? client : null;
}

export function cacheMode() {
  return mode;
}

export const cache = {
  async get(key) {
    if (mode === 'redis') {
      const raw = await client.get(key);
      return raw === null ? null : JSON.parse(raw);
    }
    return memoryGet(key);
  },

  async set(key, value, ttlSeconds = 300) {
    if (mode === 'redis') {
      const raw = JSON.stringify(value);
      if (ttlSeconds) await client.set(key, raw, 'EX', ttlSeconds);
      else await client.set(key, raw);
      return;
    }
    memorySet(key, value, ttlSeconds);
  },

  async del(...keys) {
    if (!keys.length) return;
    if (mode === 'redis') {
      await client.del(...keys);
      return;
    }
    for (const key of keys) memory.delete(key);
  },

  /** Invalidate every key sharing a prefix (used when a group/user changes). */
  async delPrefix(prefix) {
    if (mode === 'redis') {
      const stream = client.scanStream({ match: `${prefix}*`, count: 200 });
      const batch = [];
      for await (const keys of stream) batch.push(...keys);
      if (batch.length) await client.del(...batch);
      return;
    }
    for (const key of memory.keys()) {
      if (key.startsWith(prefix)) memory.delete(key);
    }
  },

  /** Read-through helper. */
  async wrap(key, ttlSeconds, producer) {
    const hit = await this.get(key);
    if (hit !== null && hit !== undefined) return hit;
    const value = await producer();
    if (value !== undefined && value !== null) await this.set(key, value, ttlSeconds);
    return value;
  },

  /**
   * Atomic counter with expiry, used by the login throttle. Falls back to the
   * memory map when Redis is absent (single-process semantics still hold).
   */
  async incr(key, ttlSeconds) {
    if (mode === 'redis') {
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, ttlSeconds);
      return count;
    }
    const current = memoryGet(key) ?? 0;
    const next = current + 1;
    memorySet(key, next, ttlSeconds);
    return next;
  },
};

export async function closeCache() {
  if (client) {
    await client.quit().catch(() => client.disconnect());
    client = null;
  }
}
