import express from 'express';
import { asyncRoute, badRequest, notFound } from '../lib/errors.js';
import { parse, z, idSchema } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { isConversationMember } from '../services/permissions.js';
import { getDb } from '../db/index.js';
import { getConversationMembers } from '../services/conversations.js';
import { getSettings } from '../services/settings.js';
import { audit } from '../services/audit.js';
import { getE2eeBootstrap, provisionE2eeIdentities } from '../services/e2eeKeys.js';

export const e2eeRouter = express.Router();
e2eeRouter.use(requireAuth);

const jwkSchema = z.object({
  kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().min(40).max(100),
  y: z.string().min(40).max(100), ext: z.boolean().optional(), key_ops: z.array(z.string()).optional(),
});
const identitySchema = z.object({ encryption: jwkSchema, signing: jwkSchema });

e2eeRouter.get('/identity', asyncRoute(async (req, res) => {
  const row = await getDb().get('SELECT public_key, key_version, updated_at FROM e2ee_identities WHERE user_id = ?', [req.user.id]);
  return res.json({ identity: row ? { publicKey: JSON.parse(row.public_key), version: Number(row.key_version), updatedAt: Number(row.updated_at) } : null });
}));

e2eeRouter.get('/identity/bootstrap', asyncRoute(async (req, res) => {
  const identity = await getE2eeBootstrap(req.user.id);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ identity });
}));

e2eeRouter.put('/identity', asyncRoute(async (req, res) => {
  const publicKey = parse(identitySchema, req.body.publicKey);
  const settings = await getSettings();
  if (!settings.feature_e2ee) throw badRequest('End-to-end encryption is disabled by an administrator.');
  const current = await getDb().get('SELECT public_key, key_version FROM e2ee_identities WHERE user_id = ?', [req.user.id]);
  const serialized = JSON.stringify(publicKey);
  const version = current && current.public_key !== serialized ? Number(current.key_version) + 1 : Number(current?.key_version ?? 1);
  const now = Date.now();
  await getDb().run(`INSERT INTO e2ee_identities (user_id, public_key, key_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET public_key = excluded.public_key,
    key_version = excluded.key_version, updated_at = excluded.updated_at`, [req.user.id, serialized, version, now, now]);
  await audit({ actorId: req.user.id, action: 'e2ee.identity_published', targetType: 'user', targetId: req.user.id, meta: { version } });
  return res.json({ identity: { publicKey, version, updatedAt: now } });
}));

e2eeRouter.get('/conversations/:id/participants', asyncRoute(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  if (!(await isConversationMember(id, req.user.id))) throw notFound('Conversation not found.');
  const members = await getConversationMembers(id);
  await provisionE2eeIdentities(members.map((member) => member.id));
  const rows = await getDb().all(`SELECT user_id, public_key, key_version, updated_at FROM e2ee_identities
    WHERE user_id IN (${members.map(() => '?').join(', ')})`, members.map((member) => member.id));
  const identities = new Map(rows.map((row) => [row.user_id, row]));
  return res.json({ participants: members.map((member) => {
    const identity = identities.get(member.id);
    return { userId: member.id, username: member.username, displayName: member.displayName,
      publicKey: identity ? JSON.parse(identity.public_key) : null,
      version: identity ? Number(identity.key_version) : null, updatedAt: identity ? Number(identity.updated_at) : null };
  }) });
}));
