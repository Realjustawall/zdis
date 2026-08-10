import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { findUserById, getPublicUser } from './users.js';
import { isBlocked } from './permissions.js';
import { isStreamer } from './capabilities.js';
import { createGroup, addMember, toGroup } from './groups.js';

const FRIEND_STATUSES = new Set(['pending', 'accepted', 'rejected']);
const REQUEST_STATUSES = new Set(['pending', 'accepted', 'rejected']);
const LINKED_PLATFORMS = new Set([
  'youtube',
  'twitch',
  'kick',
  'instagram',
  'tiktok',
  'x',
  'website',
  'github',
]);

function friendship(row, viewerId, user) {
  return {
    id: row.id,
    status: FRIEND_STATUSES.has(row.status) ? row.status : 'pending',
    direction: row.requester_id === viewerId ? 'outgoing' : 'incoming',
    user,
    createdAt: Number(row.created_at),
    respondedAt: row.responded_at ? Number(row.responded_at) : null,
  };
}

export async function listFriendships(userId) {
  const rows = await getDb().all(
    `SELECT * FROM friendships
     WHERE requester_id = ? OR addressee_id = ?
     ORDER BY created_at DESC`,
    [userId, userId],
  );
  return Promise.all(
    rows.map(async (row) => {
      const otherId = row.requester_id === userId ? row.addressee_id : row.requester_id;
      return friendship(row, userId, await getPublicUser(otherId));
    }),
  ).then((items) => items.filter((item) => item.user));
}

export async function requestFriendship(requesterId, addresseeId) {
  if (requesterId === addresseeId) throw badRequest('You cannot add yourself as a friend.');
  const target = await findUserById(addresseeId);
  if (!target || !target.is_active) throw notFound('User not found.');
  if (await isBlocked(requesterId, addresseeId)) {
    throw forbidden('A friend request cannot be sent between these accounts.');
  }

  const db = getDb();
  const existing = await db.get(
    `SELECT * FROM friendships
     WHERE (requester_id = ? AND addressee_id = ?)
        OR (requester_id = ? AND addressee_id = ?)`,
    [requesterId, addresseeId, addresseeId, requesterId],
  );
  if (existing?.status === 'accepted') throw conflict('You are already friends.');
  if (existing?.status === 'pending') {
    // Sending a request back is an explicit acceptance of the incoming one.
    if (existing.addressee_id === requesterId) {
      await db.run(
        "UPDATE friendships SET status = 'accepted', responded_at = ? WHERE id = ?",
        [Date.now(), existing.id],
      );
      return db.get('SELECT * FROM friendships WHERE id = ?', [existing.id]);
    }
    throw conflict('A friend request is already pending.');
  }
  if (existing) {
    await db.run(
      `UPDATE friendships SET requester_id = ?, addressee_id = ?, status = 'pending',
       created_at = ?, responded_at = NULL WHERE id = ?`,
      [requesterId, addresseeId, Date.now(), existing.id],
    );
    return db.get('SELECT * FROM friendships WHERE id = ?', [existing.id]);
  }

  const id = newId();
  await db.run(
    `INSERT INTO friendships (id, requester_id, addressee_id, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
    [id, requesterId, addresseeId, Date.now()],
  );
  return db.get('SELECT * FROM friendships WHERE id = ?', [id]);
}

export async function respondToFriendship(id, userId, status) {
  if (!['accepted', 'rejected'].includes(status)) throw badRequest('Invalid response.');
  const row = await getDb().get('SELECT * FROM friendships WHERE id = ?', [id]);
  if (!row) throw notFound('Friend request not found.');
  if (row.addressee_id !== userId) throw forbidden('Only the recipient can answer this request.');
  if (row.status !== 'pending') throw conflict('This request has already been answered.');
  if (status === 'accepted' && (await isBlocked(row.requester_id, row.addressee_id))) {
    throw forbidden('This request can no longer be accepted.');
  }
  await getDb().run('UPDATE friendships SET status = ?, responded_at = ? WHERE id = ?', [
    status,
    Date.now(),
    id,
  ]);
  return getDb().get('SELECT * FROM friendships WHERE id = ?', [id]);
}

export async function removeFriendship(id, userId) {
  const row = await getDb().get('SELECT * FROM friendships WHERE id = ?', [id]);
  if (!row) throw notFound('Friendship not found.');
  if (row.requester_id !== userId && row.addressee_id !== userId) {
    throw forbidden('That friendship does not belong to you.');
  }
  await getDb().run('DELETE FROM friendships WHERE id = ?', [id]);
  return row;
}

function collab(row, users) {
  return {
    id: row.id,
    initiator: users.get(row.initiator_id) ?? null,
    partner: users.get(row.partner_id) ?? null,
    status: row.status,
    title: row.title ?? null,
    note: row.note ?? null,
    groupId: row.group_id ?? null,
    createdAt: Number(row.created_at),
    respondedAt: row.responded_at ? Number(row.responded_at) : null,
  };
}

export async function listCollabs(userId) {
  const rows = await getDb().all(
    `SELECT * FROM collabs WHERE initiator_id = ? OR partner_id = ?
     ORDER BY created_at DESC`,
    [userId, userId],
  );
  const ids = new Set(rows.flatMap((row) => [row.initiator_id, row.partner_id]));
  const users = new Map(
    await Promise.all([...ids].map(async (id) => [id, await getPublicUser(id)])),
  );
  return rows.map((row) => collab(row, users));
}

export async function createCollab({ initiator, partnerId, title = null, note = null }) {
  if (!(await isStreamer(initiator))) throw forbidden('Only streamers can start collaborations.');
  if (partnerId === initiator.id) throw badRequest('Choose another streamer.');
  const partner = await findUserById(partnerId);
  if (!partner || !partner.is_active || !(await isStreamer(partner))) {
    throw notFound('Streamer not found.');
  }
  const existing = await getDb().get(
    `SELECT id FROM collabs WHERE status = 'pending' AND
     ((initiator_id = ? AND partner_id = ?) OR (initiator_id = ? AND partner_id = ?))`,
    [initiator.id, partnerId, partnerId, initiator.id],
  );
  if (existing) throw conflict('A collaboration request is already pending.');

  const id = newId();
  await getDb().run(
    `INSERT INTO collabs
      (id, initiator_id, partner_id, status, title, note, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    [id, initiator.id, partnerId, title, note, Date.now()],
  );
  return getDb().get('SELECT * FROM collabs WHERE id = ?', [id]);
}

export async function respondToCollab(id, user, status) {
  if (!['accepted', 'rejected'].includes(status)) throw badRequest('Invalid response.');
  const row = await getDb().get('SELECT * FROM collabs WHERE id = ?', [id]);
  if (!row) throw notFound('Collaboration request not found.');
  if (row.partner_id !== user.id) throw forbidden('Only the invited streamer can respond.');
  if (row.status !== 'pending') throw conflict('This collaboration has already been answered.');

  let group = null;
  if (status === 'accepted') {
    const initiator = await findUserById(row.initiator_id);
    if (!initiator?.is_active || !(await isStreamer(initiator)) || !(await isStreamer(user))) {
      throw badRequest('Both accounts must still be active streamers.');
    }
    const name = row.title?.trim() || `${initiator.display_name} + ${user.display_name}`;
    group = await createGroup({
      name,
      description: row.note ?? 'Shared collaboration space.',
      ownerId: row.initiator_id,
    });
    await addMember({
      groupId: group.id,
      userId: row.partner_id,
      role: 'admin',
      invitedBy: row.initiator_id,
    });
  }

  await getDb().run(
    'UPDATE collabs SET status = ?, group_id = ?, responded_at = ? WHERE id = ?',
    [status, group?.id ?? null, Date.now(), id],
  );
  return {
    collab: await getDb().get('SELECT * FROM collabs WHERE id = ?', [id]),
    group: group ? toGroup(group, { memberRole: 'admin' }) : null,
  };
}

export async function cancelCollab(id, userId) {
  const row = await getDb().get('SELECT * FROM collabs WHERE id = ?', [id]);
  if (!row) throw notFound('Collaboration request not found.');
  if (row.initiator_id !== userId || row.status !== 'pending') {
    throw forbidden('Only the sender can cancel a pending collaboration.');
  }
  await getDb().run('DELETE FROM collabs WHERE id = ?', [id]);
  return row;
}

function accessRequest(row, streamer, user) {
  return {
    id: row.id,
    streamer,
    user,
    status: row.status,
    message: row.message ?? null,
    createdAt: Number(row.created_at),
    respondedAt: row.responded_at ? Number(row.responded_at) : null,
  };
}

export async function listAccessRequests(userId) {
  const rows = await getDb().all(
    `SELECT * FROM access_requests WHERE streamer_id = ? OR user_id = ?
     ORDER BY created_at DESC`,
    [userId, userId],
  );
  return Promise.all(
    rows.map(async (row) =>
      accessRequest(
        row,
        await getPublicUser(row.streamer_id),
        await getPublicUser(row.user_id),
      ),
    ),
  );
}

export async function createAccessRequest({ streamer, userId, message = null }) {
  if (!(await isStreamer(streamer))) throw forbidden('Only streamers can request roster access.');
  if (streamer.id === userId) throw badRequest('You already control your own spaces.');
  const user = await findUserById(userId);
  if (!user || !user.is_active) throw notFound('User not found.');
  if (!user.owner_streamer_id) {
    throw badRequest('That account is not scoped to a streamer roster.');
  }
  if (user.owner_streamer_id === streamer.id) {
    throw conflict('That account is already on your roster.');
  }

  const existing = await getDb().get(
    'SELECT * FROM access_requests WHERE streamer_id = ? AND user_id = ?',
    [streamer.id, userId],
  );
  if (existing?.status === 'accepted') throw conflict('Access has already been granted.');
  if (existing?.status === 'pending') throw conflict('An access request is already pending.');
  if (existing) {
    await getDb().run(
      `UPDATE access_requests SET status = 'pending', message = ?, created_at = ?,
       responded_at = NULL WHERE id = ?`,
      [message, Date.now(), existing.id],
    );
    return getDb().get('SELECT * FROM access_requests WHERE id = ?', [existing.id]);
  }
  const id = newId();
  await getDb().run(
    `INSERT INTO access_requests
      (id, streamer_id, user_id, status, message, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    [id, streamer.id, userId, message, Date.now()],
  );
  return getDb().get('SELECT * FROM access_requests WHERE id = ?', [id]);
}

export async function respondToAccessRequest(id, userId, status) {
  if (!REQUEST_STATUSES.has(status) || status === 'pending') throw badRequest('Invalid response.');
  const row = await getDb().get('SELECT * FROM access_requests WHERE id = ?', [id]);
  if (!row) throw notFound('Access request not found.');
  if (row.user_id !== userId) throw forbidden('Only the requested member can respond.');
  if (row.status !== 'pending') throw conflict('This request has already been answered.');
  await getDb().run('UPDATE access_requests SET status = ?, responded_at = ? WHERE id = ?', [
    status,
    Date.now(),
    id,
  ]);
  return getDb().get('SELECT * FROM access_requests WHERE id = ?', [id]);
}

export async function revokeAccessRequest(id, actorId) {
  const row = await getDb().get('SELECT * FROM access_requests WHERE id = ?', [id]);
  if (!row) throw notFound('Access request not found.');
  if (row.streamer_id !== actorId && row.user_id !== actorId) {
    throw forbidden('That access record does not belong to you.');
  }
  await getDb().run('DELETE FROM access_requests WHERE id = ?', [id]);
  return row;
}

export function toLinkedAccount(row) {
  return {
    id: row.id,
    userId: row.user_id,
    platform: row.platform,
    handle: row.handle,
    url: row.url ?? null,
    verified: Boolean(row.verified),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function listLinkedAccounts(userId) {
  const rows = await getDb().all(
    'SELECT * FROM linked_accounts WHERE user_id = ? ORDER BY created_at ASC',
    [userId],
  );
  return rows.map(toLinkedAccount);
}

export async function createLinkedAccount({ userId, platform, handle, url = null }) {
  if (!LINKED_PLATFORMS.has(platform)) throw badRequest('Unsupported platform.');
  const duplicate = await getDb().get(
    'SELECT id FROM linked_accounts WHERE user_id = ? AND platform = ?',
    [userId, platform],
  );
  if (duplicate) throw conflict('That platform is already linked.');
  const id = newId();
  const now = Date.now();
  await getDb().run(
    `INSERT INTO linked_accounts
      (id, user_id, platform, handle, url, verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, userId, platform, handle, url, now, now],
  );
  return toLinkedAccount(await getDb().get('SELECT * FROM linked_accounts WHERE id = ?', [id]));
}

export async function updateLinkedAccount({ id, userId, handle, url }) {
  const row = await getDb().get('SELECT * FROM linked_accounts WHERE id = ?', [id]);
  if (!row || row.user_id !== userId) throw notFound('Linked account not found.');
  await getDb().run(
    `UPDATE linked_accounts SET handle = ?, url = ?, verified = 0,
     verified_by = NULL, updated_at = ? WHERE id = ?`,
    [handle, url, Date.now(), id],
  );
  return toLinkedAccount(await getDb().get('SELECT * FROM linked_accounts WHERE id = ?', [id]));
}

export async function deleteLinkedAccount(id, userId) {
  const row = await getDb().get('SELECT * FROM linked_accounts WHERE id = ?', [id]);
  if (!row || row.user_id !== userId) throw notFound('Linked account not found.');
  await getDb().run('DELETE FROM linked_accounts WHERE id = ?', [id]);
  return row;
}

export async function verifyLinkedAccount(id, verifiedBy, verified) {
  const row = await getDb().get('SELECT * FROM linked_accounts WHERE id = ?', [id]);
  if (!row) throw notFound('Linked account not found.');
  await getDb().run(
    'UPDATE linked_accounts SET verified = ?, verified_by = ?, updated_at = ? WHERE id = ?',
    [verified ? 1 : 0, verified ? verifiedBy : null, Date.now(), id],
  );
  return toLinkedAccount(await getDb().get('SELECT * FROM linked_accounts WHERE id = ?', [id]));
}

export { LINKED_PLATFORMS };
