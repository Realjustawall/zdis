import { createGame, applyGameAction, GAME_NAMES } from './voiceGames.js';

export function registerVoiceActivities(socket, { getDb, channelForSocket, hasPermission, broadcast }) {
  const { userId } = socket.data;
  socket.on('voice:activity', async (payload, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    try {
      const channelId = channelForSocket(socket.id);
      if (!channelId || !(await hasPermission(userId, channelId, 'useEmbeddedActivities'))) throw new Error('Join a voice channel with Activities permission first.');
      const now = Date.now();
      const rate = socket.data.activityRate ?? { at: now, count: 0 };
      if (now - rate.at > 1000) { rate.at = now; rate.count = 0; }
      socket.data.activityRate = rate;
      if (++rate.count > 30) throw new Error('Too many activity actions. Try again shortly.');
      const db = getDb();
      const row = await db.get('SELECT * FROM voice_activities WHERE channel_id = ?', [channelId]);
      if (channelForSocket(socket.id) !== channelId) throw new Error('You have left this voice channel.');
      let activity;
      if (payload?.action === 'start') {
        if (row) throw new Error('End the current activity before starting another game.');
        if (!GAME_NAMES.includes(payload.activity)) throw new Error('Choose Chess, Tic-tac-toe, or Backgammon.');
        const state = createGame(payload.activity, userId);
        const inserted = await db.run(`INSERT INTO voice_activities (channel_id, activity, started_by, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (channel_id) DO NOTHING`, [channelId, payload.activity, userId, JSON.stringify(state), now, now]);
        if (!inserted.changes) throw new Error('Another activity has just started. Refresh the activity.');
        activity = { name: payload.activity, startedBy: userId, state, createdAt: now, updatedAt: now };
      } else {
        if (!row) throw new Error('This activity has ended.');
        const previous = JSON.parse(row.state || '{}');
        if (payload?.gameId !== previous.id || payload?.revision !== previous.revision) throw new Error('The game has changed. Wait for its latest state and try again.');
        if (payload.action === 'end') {
          if (row.started_by !== userId && !(await hasPermission(userId, channelId, 'manageChannels'))) throw new Error('Only the activity host can end this activity.');
          const removed = await db.run('DELETE FROM voice_activities WHERE channel_id = ? AND state = ?', [channelId, row.state]);
          if (!removed.changes) throw new Error('The game changed. Try again.');
          activity = null;
        } else {
          if (payload.action !== 'play' || !payload.move || typeof payload.move !== 'object') throw new Error('Invalid activity action.');
          const state = applyGameAction(row.activity, previous, userId, payload.move);
          const saved = await db.run('UPDATE voice_activities SET state = ?, updated_at = ? WHERE channel_id = ? AND state = ?', [JSON.stringify(state), now, channelId, row.state]);
          if (!saved.changes) throw new Error('Another move arrived first. Wait for its latest state.');
          activity = { name: row.activity, startedBy: row.started_by, state, createdAt: Number(row.created_at), updatedAt: now };
        }
      }
      broadcast(channelId, activity);
      reply({ ok: true, activity });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : 'Could not update the activity.' });
    }
  });
}
