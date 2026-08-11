import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';

const ALLOWED = new Set(['admin', 'moderate', 'debug', 'stream']);

export async function listCustomRoles() {
  const roles = await getDb().all(
    `SELECT r.*, COUNT(ur.user_id) AS user_count
     FROM custom_roles r
     LEFT JOIN user_custom_roles ur ON ur.role_id = r.id
     GROUP BY r.id ORDER BY LOWER(r.name)`,
  );
  for (const role of roles) {
    const rows = await getDb().all(
      'SELECT capability FROM custom_role_capabilities WHERE role_id = ? ORDER BY capability',
      [role.id],
    );
    role.capabilities = rows.map((row) => row.capability);
    role.userCount = Number(role.user_count ?? 0);
  }
  return roles;
}

export async function createCustomRole({ name, description, capabilities, actorId }) {
  validateCapabilities(capabilities);
  const id = newId();
  const now = Date.now();
  await getDb().tx(async (tx) => {
    await tx.run(
      `INSERT INTO custom_roles (id, name, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, description, actorId, now, now],
    );
    for (const capability of new Set(capabilities)) {
      await tx.run(
        'INSERT INTO custom_role_capabilities (role_id, capability) VALUES (?, ?)',
        [id, capability],
      );
    }
  });
  return (await listCustomRoles()).find((role) => role.id === id);
}

export async function updateCustomRole(id, { name, description, capabilities }) {
  const role = await getDb().get('SELECT * FROM custom_roles WHERE id = ?', [id]);
  if (!role) throw notFound('Role not found.');
  if (capabilities) validateCapabilities(capabilities);
  await getDb().tx(async (tx) => {
    await tx.run(
      'UPDATE custom_roles SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      [name ?? role.name, description === undefined ? role.description : description, Date.now(), id],
    );
    if (capabilities) {
      await tx.run('DELETE FROM custom_role_capabilities WHERE role_id = ?', [id]);
      for (const capability of new Set(capabilities)) {
        await tx.run(
          'INSERT INTO custom_role_capabilities (role_id, capability) VALUES (?, ?)',
          [id, capability],
        );
      }
    }
  });
  return (await listCustomRoles()).find((item) => item.id === id);
}

export async function deleteCustomRole(id) {
  await getDb().tx(async (tx) => {
    await tx.run('DELETE FROM user_custom_roles WHERE role_id = ?', [id]);
    await tx.run('DELETE FROM custom_role_capabilities WHERE role_id = ?', [id]);
    const result = await tx.run('DELETE FROM custom_roles WHERE id = ?', [id]);
    if (!result.changes) throw notFound('Role not found.');
  });
}

export async function assignCustomRole({ userId, roleId, actorId, granted }) {
  if (granted) {
    const role = await getDb().get('SELECT id FROM custom_roles WHERE id = ?', [roleId]);
    if (!role) throw notFound('Role not found.');
    await getDb().run(
      `INSERT INTO user_custom_roles (user_id, role_id, granted_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, role_id) DO UPDATE SET granted_by = excluded.granted_by`,
      [userId, roleId, actorId, Date.now()],
    );
  } else {
    await getDb().run('DELETE FROM user_custom_roles WHERE user_id = ? AND role_id = ?', [
      userId,
      roleId,
    ]);
  }
}

function validateCapabilities(capabilities) {
  if (capabilities.some((capability) => !ALLOWED.has(capability))) {
    throw badRequest('Role contains an unknown capability.');
  }
}
