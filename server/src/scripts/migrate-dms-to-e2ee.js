import { initDb, getDb, closeDatabases } from '../db/index.js';
import { initCache, closeCache } from '../cache/index.js';
import {
  encryptE2eeEnvelope,
  generateE2eeIdentity,
  provisionE2eeIdentity,
  sealE2eeSecret,
  openE2eeSecret,
} from '../services/e2eeKeys.js';
import { indexMessage } from '../services/search.js';
import { updateSettings } from '../services/settings.js';

await initDb();
await initCache();
const db = getDb();

try {
  const encryptedCount = Number((await db.get(
    `SELECT COUNT(*) AS count FROM messages
     WHERE conversation_id IS NOT NULL AND type = 'encrypted'`,
  ))?.count ?? 0);
  const users = await db.all(
    `SELECT u.id, i.user_id AS identity_id, e.user_id AS escrow_id
     FROM users u
     LEFT JOIN e2ee_identities i ON i.user_id = u.id
     LEFT JOIN e2ee_key_escrows e ON e.user_id = u.id
     ORDER BY u.id`,
  );

  let provisioned = 0;
  for (const user of users) {
    if (user.escrow_id) continue;
    if (user.identity_id && encryptedCount > 0) {
      throw new Error(
        `Cannot rotate identity ${user.id}: encrypted messages already exist and no escrow key is available.`,
      );
    }
    const result = await provisionE2eeIdentity(user.id, { force: Boolean(user.identity_id) });
    if (result.created) provisioned += 1;
  }

  const identityRows = await db.all('SELECT user_id, public_key FROM e2ee_identities');
  const publicKeys = new Map(identityRows.map((row) => [row.user_id, JSON.parse(row.public_key)]));
  const participantCache = new Map();
  async function participants(conversationId) {
    if (!participantCache.has(conversationId)) {
      const rows = await db.all(
        'SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY user_id',
        [conversationId],
      );
      const result = rows.map((row) => ({ userId: row.user_id, publicKey: publicKeys.get(row.user_id) }));
      if (!result.length || result.some((participant) => !participant.publicKey)) {
        throw new Error(`Conversation ${conversationId} has a participant without an E2EE identity.`);
      }
      participantCache.set(conversationId, result);
    }
    return participantCache.get(conversationId);
  }

  const migrationIdentity = await generateE2eeIdentity();
  const messages = await db.all(
    `SELECT id, conversation_id, author_id, content, type, suppress_embeds
     FROM messages
     WHERE conversation_id IS NOT NULL AND type <> 'encrypted' AND content <> ''
     ORDER BY conversation_id, id`,
  );
  let migratedMessages = 0;
  let reindexed = 0;

  for (const message of messages) {
    let plaintext = message.content;
    let pollBackup = null;
    if (message.type === 'poll') {
      const poll = await db.get('SELECT * FROM polls WHERE message_id = ?', [message.id]);
      if (poll) {
        const options = await db.all(
          'SELECT id, label, position, is_correct FROM poll_options WHERE poll_id = ? ORDER BY position',
          [poll.id],
        );
        pollBackup = { question: poll.question, options: options.map((option) => ({
          id: option.id, label: option.label, position: Number(option.position), isCorrect: Boolean(option.is_correct),
        })) };
        plaintext = JSON.stringify({
          v: 1,
          kind: 'poll',
          poll: {
            question: poll.question,
            options: options.map((option) => option.label),
            multiple: Boolean(poll.multiple),
            anonymous: Boolean(poll.anonymous),
            examMode: Boolean(poll.exam_mode),
            correctIndex: options.findIndex((option) => Boolean(option.is_correct)),
          },
        });
      }
    }
    const envelope = await encryptE2eeEnvelope({
      conversationId: message.conversation_id,
      senderId: message.author_id,
      plaintext,
      participants: await participants(message.conversation_id),
      identity: migrationIdentity,
    });
    const backup = sealE2eeSecret({
      content: message.content,
      type: message.type,
      suppressEmbeds: Boolean(message.suppress_embeds),
      poll: pollBackup,
    });
    // Verify the encrypted rollback payload before changing the source row.
    if (openE2eeSecret(backup).content !== message.content) {
      throw new Error(`Rollback verification failed for message ${message.id}.`);
    }
    await db.tx(async (tx) => {
      await tx.run(
        `INSERT INTO e2ee_migration_backups (record_type, record_id, encrypted_original, created_at)
         VALUES ('message', ?, ?, ?)
         ON CONFLICT (record_type, record_id) DO NOTHING`,
        [message.id, backup, Date.now()],
      );
      await tx.run(
        `UPDATE messages SET content = ?, type = 'encrypted', suppress_embeds = 1
         WHERE id = ? AND type <> 'encrypted'`,
        [envelope, message.id],
      );
      await tx.run('DELETE FROM mentions WHERE message_id = ?', [message.id]);
      if (pollBackup) {
        await tx.run("UPDATE polls SET question = '🔒' WHERE message_id = ?", [message.id]);
        for (const [index, option] of pollBackup.options.entries()) {
          await tx.run('UPDATE poll_options SET label = ? WHERE id = ?', [`option-${index + 1}`, option.id]);
        }
      }
      const events = await tx.all('SELECT id, payload FROM sync_events WHERE entity_id = ?', [message.id]);
      for (const event of events) {
        let payload;
        try { payload = JSON.parse(event.payload); } catch { payload = null; }
        if (payload?.message) {
          payload.message.content = envelope;
          payload.message.type = 'encrypted';
          await tx.run('UPDATE sync_events SET payload = ? WHERE id = ?', [JSON.stringify(payload), event.id]);
        }
      }
      const notifications = await tx.all(
        "SELECT id, data FROM notifications WHERE type = 'direct_message'",
      );
      for (const notification of notifications) {
        let data;
        try { data = JSON.parse(notification.data || '{}'); } catch { data = {}; }
        if (data.messageId === message.id) {
          await tx.run(
            "UPDATE notifications SET body = 'Sent an end-to-end encrypted message' WHERE id = ?",
            [notification.id],
          );
        }
      }
    });
    migratedMessages += 1;
    try {
      await indexMessage(message.id);
      reindexed += 1;
    } catch (error) {
      throw new Error(`Search reindex failed for message ${message.id}: ${error.message}`);
    }
  }

  const scheduled = await db.all(
    `SELECT id, user_id, target_id, content, encrypted
     FROM scheduled_messages
     WHERE target_type = 'conversation' AND status = 'scheduled' AND encrypted = 0 AND content <> ''`,
  );
  let migratedScheduled = 0;
  for (const item of scheduled) {
    const envelope = await encryptE2eeEnvelope({
      conversationId: item.target_id,
      senderId: item.user_id,
      plaintext: item.content,
      participants: await participants(item.target_id),
      identity: migrationIdentity,
    });
    const backup = sealE2eeSecret({ content: item.content, encrypted: Boolean(item.encrypted) });
    if (openE2eeSecret(backup).content !== item.content) {
      throw new Error(`Rollback verification failed for scheduled message ${item.id}.`);
    }
    await db.tx(async (tx) => {
      await tx.run(
        `INSERT INTO e2ee_migration_backups (record_type, record_id, encrypted_original, created_at)
         VALUES ('scheduled_message', ?, ?, ?)
         ON CONFLICT (record_type, record_id) DO NOTHING`,
        [item.id, backup, Date.now()],
      );
      await tx.run(
        'UPDATE scheduled_messages SET content = ?, encrypted = 1, updated_at = ? WHERE id = ?',
        [envelope, Date.now(), item.id],
      );
    });
    migratedScheduled += 1;
  }

  const remaining = Number((await db.get(
    `SELECT COUNT(*) AS count FROM messages
     WHERE conversation_id IS NOT NULL AND type <> 'encrypted' AND content <> ''`,
  ))?.count ?? 0);
  if (remaining !== 0) throw new Error(`${remaining} plaintext DM messages remain after migration.`);

  await updateSettings({ feature_e2ee: true, e2ee_required_for_dms: true });
  console.log(JSON.stringify({
    users: users.length,
    identitiesProvisioned: provisioned,
    messagesMigrated: migratedMessages,
    scheduledMessagesMigrated: migratedScheduled,
    searchDocumentsReindexed: reindexed,
    plaintextMessagesRemaining: remaining,
    mandatoryE2ee: true,
  }));
} finally {
  await closeCache();
  await closeDatabases();
}
