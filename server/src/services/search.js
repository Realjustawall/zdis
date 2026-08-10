import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { hydrateMessage } from './messages.js';

function headers() {
  const result = { 'content-type': 'application/json' };
  if (config.openSearch.username) {
    result.authorization = `Basic ${Buffer.from(
      `${config.openSearch.username}:${config.openSearch.password}`,
    ).toString('base64')}`;
  }
  return result;
}

async function request(path, options = {}) {
  if (!config.openSearch.url) throw new Error('OpenSearch is not configured.');
  const response = await fetch(`${config.openSearch.url.replace(/\/$/, '')}${path}`, {
    ...options,
    headers: { ...headers(), ...options.headers },
    signal: AbortSignal.timeout(config.openSearch.timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenSearch returned HTTP ${response.status}.`);
  return response.status === 204 ? null : response.json();
}

export function openSearchEnabled() {
  return Boolean(config.openSearch.url);
}

export async function ensureSearchIndex() {
  if (!openSearchEnabled()) return false;
  const index = encodeURIComponent(config.openSearch.index);
  const exists = await fetch(`${config.openSearch.url.replace(/\/$/, '')}/${index}`, {
    method: 'HEAD',
    headers: headers(),
    signal: AbortSignal.timeout(config.openSearch.timeoutMs),
  });
  if (exists.ok) return true;
  await request(`/${index}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: { index: { number_of_shards: 3, number_of_replicas: 1 } },
      mappings: {
        dynamic: 'strict',
        properties: {
          id: { type: 'keyword' },
          channelId: { type: 'keyword' },
          conversationId: { type: 'keyword' },
          authorId: { type: 'keyword' },
          content: { type: 'text' },
          type: { type: 'keyword' },
          createdAt: { type: 'date', format: 'epoch_millis' },
          expiresAt: { type: 'date', format: 'epoch_millis' },
          deleted: { type: 'boolean' },
        },
      },
    }),
  });
  return true;
}

export async function indexMessage(messageId) {
  if (!openSearchEnabled()) return { skipped: true };
  const message = await hydrateMessage(messageId);
  if (!message) return { skipped: true };
  await ensureSearchIndex();
  await request(
    `/${encodeURIComponent(config.openSearch.index)}/_doc/${encodeURIComponent(message.id)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        id: message.id,
        channelId: message.channelId,
        conversationId: message.conversationId,
        authorId: message.authorId,
        content: message.deleted ? '' : message.content,
        type: message.type,
        createdAt: message.createdAt,
        expiresAt: message.expiresAt,
        deleted: message.deleted,
      }),
    },
  );
  return { indexed: message.id };
}

export async function deleteSearchMessage(messageId) {
  if (!openSearchEnabled()) return { skipped: true };
  try {
    await request(
      `/${encodeURIComponent(config.openSearch.index)}/_doc/${encodeURIComponent(messageId)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (!error.message.includes('404')) throw error;
  }
  return { deleted: messageId };
}

export async function searchOpenSearch({
  term,
  channelIds,
  conversationIds,
  limit = 40,
}) {
  if (!openSearchEnabled()) return null;
  const should = [];
  if (channelIds.length) should.push({ terms: { channelId: channelIds } });
  if (conversationIds.length) should.push({ terms: { conversationId: conversationIds } });
  if (!should.length) return [];
  try {
    const result = await request(`/${encodeURIComponent(config.openSearch.index)}/_search`, {
      method: 'POST',
      body: JSON.stringify({
        size: limit,
        query: {
          bool: {
            must: [{ match: { content: { query: term, operator: 'and' } } }],
            filter: [
              { term: { deleted: false } },
              {
                bool: {
                  should,
                  minimum_should_match: 1,
                },
              },
              {
                bool: {
                  should: [
                    { bool: { must_not: { exists: { field: 'expiresAt' } } } },
                    { range: { expiresAt: { gt: Date.now() } } },
                  ],
                  minimum_should_match: 1,
                },
              },
            ],
          },
        },
        sort: [{ createdAt: 'desc' }],
      }),
    });
    const messages = [];
    for (const hit of result.hits?.hits ?? []) {
      const message = await hydrateMessage(hit._id);
      if (message) messages.push(message);
    }
    return messages;
  } catch (error) {
    logger.warn('OpenSearch query failed; using database fallback', { error: error.message });
    return null;
  }
}

export async function searchHealth() {
  if (!openSearchEnabled()) return { configured: false, ok: true };
  try {
    const health = await request('/_cluster/health');
    return { configured: true, ok: health.status !== 'red', status: health.status };
  } catch (error) {
    return { configured: true, ok: false, error: error.message };
  }
}
