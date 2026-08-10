import crypto from 'node:crypto';
import express from 'express';
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  TrackSource,
} from 'livekit-server-sdk';
import { asyncRoute, badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { parse, idSchema, z } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { activeServerTimeout, groupContext } from '../services/permissions.js';
import { channelPermission } from '../services/channelPermissions.js';
import { audit } from '../services/audit.js';
import { emitToChannel } from '../realtime/index.js';

export const voiceRouter = express.Router();

// Speech-to-text workers post signed transcript segments here. This endpoint
// intentionally uses a service secret instead of a browser session.
voiceRouter.post(
  '/transcript-webhook',
  asyncRoute(async (req, res) => {
    if (!config.livekit.transcriptWebhookSecret) throw notFound();
    const presented = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const actual = Buffer.from(presented);
    const expected = Buffer.from(config.livekit.transcriptWebhookSecret);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw unauthorized('Invalid transcript service credential.');
    }
    const body = parse(
      z.object({
        channelId: idSchema,
        participantId: idSchema.optional().nullable(),
        text: z.string().trim().min(1).max(5000),
        language: z.string().trim().max(20).optional().nullable(),
        startedAt: z.number().int().optional().nullable(),
        endedAt: z.number().int().optional().nullable(),
        confidence: z.number().min(0).max(1).optional().nullable(),
      }),
      req.body,
    );
    const id = newId();
    await getDb().run(
      `INSERT INTO call_transcript_segments
         (id, channel_id, participant_id, text, language, started_at,
          ended_at, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.channelId,
        body.participantId,
        body.text,
        body.language,
        body.startedAt,
        body.endedAt,
        body.confidence,
        Date.now(),
      ],
    );
    return res.status(201).json({ id });
  }),
);

voiceRouter.use(requireAuth);

voiceRouter.get(
  '/:channelId',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const { channel, context } = await voiceAccess(req, channelId);
    const room = await ensureCallRoom(channelId, req.user.id);
    const lobby =
      room.host_id === req.user.id
        ? await getDb().all(
            `SELECT l.*, u.username, u.display_name, u.avatar_url
             FROM call_lobby l JOIN users u ON u.id = l.user_id
             WHERE l.channel_id = ? AND l.status = 'pending' ORDER BY l.requested_at`,
            [channelId],
          )
        : [];
    const consent = await getDb().get(
      'SELECT recording, transcript, updated_at FROM call_consents WHERE channel_id = ? AND user_id = ?',
      [channelId, req.user.id],
    );
    const recordings = await getDb().all(
      `SELECT id, egress_id, status, storage_key, started_at, ended_at
       FROM call_recordings WHERE channel_id = ? ORDER BY started_at DESC LIMIT 50`,
      [channelId],
    );
    const activity = await getDb().get(
      'SELECT activity, started_by, state, created_at, updated_at FROM voice_activities WHERE channel_id = ?',
      [channelId],
    );
    const stageMembers =
      channel.type === 'stage'
        ? await getDb().all(
            `SELECT s.user_id, s.role, s.requested_at, u.username, u.display_name, u.avatar_url
             FROM stage_members s JOIN users u ON u.id = s.user_id
             WHERE s.channel_id = ? ORDER BY
               CASE s.role WHEN 'speaker' THEN 0 ELSE 1 END, s.requested_at`,
            [channelId],
          )
        : [];
    return res.json({
      channelStatus: channel.voice_status ?? null,
      permissions: {
        useSoundboard: await channelPermission(channel, context, 'useSoundboard'),
        useEmbeddedActivities: await channelPermission(
          channel,
          context,
          'useEmbeddedActivities',
        ),
        setVoiceChannelStatus: await channelPermission(
          channel,
          context,
          'setVoiceChannelStatus',
        ),
        useVoiceActivity: await channelPermission(
          channel,
          context,
          'useVoiceActivity',
        ),
        prioritySpeaker: await channelPermission(
          channel,
          context,
          'prioritySpeaker',
        ),
        useExternalSounds: await channelPermission(
          channel,
          context,
          'useExternalSounds',
        ),
      },
      room: toCallRoom(room),
      lobby: lobby.map(toLobby),
      recordings: recordings.map(toRecording),
      consent: {
        recording: Boolean(consent?.recording),
        transcript: Boolean(consent?.transcript),
        updatedAt: consent?.updated_at ? Number(consent.updated_at) : null,
      },
      stage: {
        enabled: channel.type === 'stage',
        members: stageMembers.map((member) => ({
          userId: member.user_id,
          role: member.role,
          requestedAt: member.requested_at ? Number(member.requested_at) : null,
          username: member.username,
          displayName: member.display_name,
          avatarUrl: member.avatar_url ?? null,
        })),
      },
      activity: activity
        ? {
            name: activity.activity,
            startedBy: activity.started_by,
            state: JSON.parse(activity.state || '{}'),
            createdAt: Number(activity.created_at),
            updatedAt: Number(activity.updated_at),
          }
        : null,
    });
  }),
);

voiceRouter.patch(
  '/:channelId/status',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const { channel, context } = await voiceAccess(req, channelId);
    if (!(await channelPermission(channel, context, 'setVoiceChannelStatus'))) {
      throw forbidden('Set Voice Channel Status permission is required.');
    }
    const body = parse(
      z.object({ status: z.string().trim().max(80).nullable() }),
      req.body,
    );
    const status = body.status || null;
    await getDb().run(
      'UPDATE channels SET voice_status = ?, updated_at = ? WHERE id = ?',
      [status, Date.now(), channelId],
    );
    emitToChannel(channelId, 'voice:status', { channelId, status });
    await audit({
      actorId: req.user.id,
      action: 'voice.status_update',
      targetType: 'channel',
      targetId: channelId,
      meta: { groupId: channel.group_id, status },
    });
    return res.json({ status });
  }),
);

voiceRouter.patch(
  '/:channelId/settings',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const { context } = await voiceAccess(req, channelId);
    if (!context.can('manageChannels')) throw forbidden('Manage Channels permission is required.');
    const body = parse(
      z.object({
        lobbyEnabled: z.boolean().optional(),
        recordingConsentRequired: z.boolean().optional(),
        preferredRegion: z.string().trim().max(40).optional().nullable(),
      }),
      req.body,
    );
    if (
      body.preferredRegion &&
      !config.livekit.regions.some((region) => region.name === body.preferredRegion)
    ) {
      throw badRequest('Unknown LiveKit region.');
    }
    const room = await ensureCallRoom(channelId, req.user.id);
    await getDb().run(
      `UPDATE call_rooms SET
       lobby_enabled = ?, recording_consent_required = ?, preferred_region = ?, updated_at = ?
       WHERE channel_id = ?`,
      [
        body.lobbyEnabled ?? Boolean(room.lobby_enabled),
        body.recordingConsentRequired ?? Boolean(room.recording_consent_required),
        body.preferredRegion === undefined ? room.preferred_region : body.preferredRegion,
        Date.now(),
        channelId,
      ],
    );
    return res.json({ room: toCallRoom(await ensureCallRoom(channelId, req.user.id)) });
  }),
);

voiceRouter.post(
  '/:channelId/lobby',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    await voiceAccess(req, channelId);
    const room = await ensureCallRoom(channelId, req.user.id);
    if (!room.lobby_enabled || room.host_id === req.user.id) {
      return res.json({ approved: true });
    }
    await getDb().run(
      `INSERT INTO call_lobby (channel_id, user_id, status, requested_at)
       VALUES (?, ?, 'pending', ?)
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET status = 'pending', requested_at = excluded.requested_at,
                     decided_at = NULL, decided_by = NULL`,
      [channelId, req.user.id, Date.now()],
    );
    return res.status(202).json({ approved: false, pending: true });
  }),
);

voiceRouter.patch(
  '/:channelId/lobby/:userId',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const userId = parse(idSchema, req.params.userId);
    await requireHost(req, channelId);
    const body = parse(z.object({ approved: z.boolean() }), req.body);
    const result = await getDb().run(
      `UPDATE call_lobby SET status = ?, decided_at = ?, decided_by = ?
       WHERE channel_id = ? AND user_id = ? AND status = 'pending'`,
      [body.approved ? 'approved' : 'denied', Date.now(), req.user.id, channelId, userId],
    );
    if (!result.changes) throw notFound('Lobby request not found.');
    return res.json({ approved: body.approved });
  }),
);

voiceRouter.put(
  '/:channelId/consent',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    await voiceAccess(req, channelId);
    const body = parse(
      z.object({ recording: z.boolean(), transcript: z.boolean().default(false) }),
      req.body,
    );
    await getDb().run(
      `INSERT INTO call_consents (channel_id, user_id, recording, transcript, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET recording = excluded.recording, transcript = excluded.transcript,
                     updated_at = excluded.updated_at`,
      [channelId, req.user.id, body.recording, body.transcript, Date.now()],
    );
    return res.json({ consent: body });
  }),
);

voiceRouter.post(
  '/:channelId/token',
  asyncRoute(async (req, res) => {
    if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
      throw notFound('SFU voice is not configured.');
    }
    const channelId = parse(idSchema, req.params.channelId);
    const { channel, context } = await voiceAccess(req, channelId);
    const callRoom = await ensureCallRoom(channelId, req.user.id);
    if (callRoom.lobby_enabled && callRoom.host_id !== req.user.id) {
      const lobby = await getDb().get(
        'SELECT status FROM call_lobby WHERE channel_id = ? AND user_id = ?',
        [channelId, req.user.id],
      );
      if (lobby?.status !== 'approved') {
        return res.status(202).json({ lobby: true, pending: lobby?.status === 'pending' });
      }
    }
    const requestedRegion = parse(
      z.object({ region: z.string().trim().max(40).optional() }),
      req.body ?? {},
    ).region;
    const region = selectRegion(requestedRegion ?? callRoom.preferred_region);
    const room = `channel-${channelId}`;
    let canPublish = await channelPermission(channel, context, 'speak');
    if (channel.type === 'stage' && callRoom.host_id !== req.user.id) {
      const stageMember = await getDb().get(
        'SELECT role FROM stage_members WHERE channel_id = ? AND user_id = ?',
        [channelId, req.user.id],
      );
      canPublish = canPublish && stageMember?.role === 'speaker';
    }
    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: req.user.id,
      name: req.user.display_name,
      ttl: '10m',
      metadata: JSON.stringify({
        username: req.user.username,
        channelId,
        host: callRoom.host_id === req.user.id,
        region: region.name,
      }),
    });
    const canUseVideo = await channelPermission(channel, context, 'video');
    const canPublishSources = canPublish
      ? [
          TrackSource.MICROPHONE,
          ...(canUseVideo
            ? [
                TrackSource.CAMERA,
                TrackSource.SCREEN_SHARE,
                TrackSource.SCREEN_SHARE_AUDIO,
              ]
            : []),
        ]
      : [];
    token.addGrant({
      roomJoin: true,
      room,
      canPublish,
      canPublishSources,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    });
    const service = roomClient(region);
    await service.createRoom({
      name: room,
      emptyTimeout: 5 * 60,
      departureTimeout: 30,
      maxParticipants: config.livekit.maxParticipants,
      metadata: JSON.stringify({ channelId, hostId: callRoom.host_id, region: region.name }),
    });
    return res.json({
      url: region.url,
      token: await token.toJwt(),
      room,
      region: region.name,
      host: callRoom.host_id === req.user.id,
      stage: channel.type === 'stage',
      canPublish,
      maxParticipants: config.livekit.maxParticipants,
    });
  }),
);

voiceRouter.post(
  '/:channelId/stage/request',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const { channel, context } = await voiceAccess(req, channelId);
    if (channel.type !== 'stage') throw badRequest('This is not a stage channel.');
    if (!(await channelPermission(channel, context, 'requestToSpeak'))) {
      throw forbidden('You do not have permission to request to speak on this stage.');
    }
    const { requested } = parse(z.object({ requested: z.boolean().default(true) }), req.body ?? {});
    await getDb().run(
      `INSERT INTO stage_members (channel_id, user_id, role, requested_at, updated_by, updated_at)
       VALUES (?, ?, 'audience', ?, ?, ?)
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET requested_at = excluded.requested_at, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      [channelId, req.user.id, requested ? Date.now() : null, req.user.id, Date.now()],
    );
    return res.json({ requested });
  }),
);

voiceRouter.patch(
  '/:channelId/stage/:userId',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const userId = parse(idSchema, req.params.userId);
    const { room, channel, context } = await requireVoiceControl(req, channelId, 'muteMembers');
    if (!(await context.outranksMember(userId))) {
      throw forbidden('You can only manage stage members below your highest role.');
    }
    const { role } = parse(z.object({ role: z.enum(['speaker', 'audience']) }), req.body);
    await getDb().run(
      `INSERT INTO stage_members (channel_id, user_id, role, requested_at, updated_by, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET role = excluded.role, requested_at = NULL,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [channelId, userId, role, req.user.id, Date.now()],
    );
    const client = roomClient(selectRegion(room.preferred_region));
    const grant = await participantPublishGrant(channel, userId, role === 'speaker');
    await client
      .updateParticipant(`channel-${channelId}`, userId, undefined, {
        ...grant,
        canSubscribe: true,
        canPublishData: true,
      })
      .catch(() => {});
    return res.json({ role });
  }),
);

voiceRouter.post(
  '/:channelId/participants/:userId/action',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const userId = parse(idSchema, req.params.userId);
    const body = parse(
      z.object({
        action: z.enum(['remove', 'audience', 'speaker', 'mute', 'deafen']),
        trackSid: z.string().max(100).optional(),
      }),
      req.body,
    );
    const permission =
      body.action === 'remove'
        ? 'moveMembers'
        : body.action === 'deafen'
          ? 'deafenMembers'
          : 'muteMembers';
    const { room, channel, context } = await requireVoiceControl(req, channelId, permission);
    if (!(await context.outranksMember(userId))) {
      throw forbidden('You can only manage voice participants below your highest role.');
    }
    const client = roomClient(selectRegion(room.preferred_region));
    const roomName = `channel-${channelId}`;
    if (body.action === 'remove') await client.removeParticipant(roomName, userId);
    else if (body.action === 'mute') {
      if (!body.trackSid) throw badRequest('trackSid is required to mute a participant.');
      await client.mutePublishedTrack(roomName, userId, body.trackSid, true);
    } else if (body.action === 'deafen') {
      const grant = await participantPublishGrant(channel, userId, true);
      await client.updateParticipant(roomName, userId, undefined, {
        ...grant,
        canSubscribe: false,
        canPublishData: true,
      });
    } else {
      const grant = await participantPublishGrant(
        channel,
        userId,
        body.action === 'speaker',
      );
      await client.updateParticipant(roomName, userId, undefined, {
        ...grant,
        canSubscribe: true,
        canPublishData: true,
      });
    }
    return res.json({ ok: true });
  }),
);

voiceRouter.post(
  '/:channelId/recordings',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const room = await requireHost(req, channelId);
    if (!config.livekit.egressEnabled || config.storageDriver !== 's3') {
      throw notFound('LiveKit Egress recording is not configured.');
    }
    const region = selectRegion(room.preferred_region);
    if (room.recording_consent_required) {
      const participants = await roomClient(region).listParticipants(`channel-${channelId}`);
      const identities = participants.map((participant) => participant.identity);
      if (!identities.includes(req.user.id)) identities.push(req.user.id);
      const consented = await getDb().all(
        `SELECT user_id FROM call_consents
         WHERE channel_id = ? AND recording = 1
           AND user_id IN (${identities.map(() => '?').join(', ')})`,
        [channelId, ...identities],
      );
      if (consented.length !== identities.length) {
        throw forbidden('Every participant must consent before recording starts.');
      }
    }
    const id = newId();
    const filepath = `recordings/${channelId}/${id}.mp4`;
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: config.s3.accessKeyId,
          secret: config.s3.secretAccessKey,
          region: config.s3.region,
          endpoint: config.s3.endpoint,
          bucket: config.s3.bucket,
          forcePathStyle: config.s3.forcePathStyle,
        }),
      },
    });
    const info = await egressClient(region).startRoomCompositeEgress(
      `channel-${channelId}`,
      output,
      { layout: 'grid' },
    );
    await getDb().run(
      `INSERT INTO call_recordings
         (id, channel_id, egress_id, started_by, status, storage_key, started_at)
       VALUES (?, ?, ?, ?, 'recording', ?, ?)`,
      [id, channelId, info.egressId, req.user.id, filepath, Date.now()],
    );
    await audit({
      actorId: req.user.id,
      action: 'call.recording_started',
      targetType: 'channel',
      targetId: channelId,
      meta: { recordingId: id, egressId: info.egressId },
    });
    return res.status(201).json({ recording: toRecording(await getRecording(id)) });
  }),
);

voiceRouter.delete(
  '/:channelId/recordings/:recordingId',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    const recordingId = parse(idSchema, req.params.recordingId);
    const room = await requireHost(req, channelId);
    const recording = await getRecording(recordingId);
    if (!recording || recording.channel_id !== channelId) throw notFound('Recording not found.');
    await egressClient(selectRegion(room.preferred_region)).stopEgress(recording.egress_id);
    await getDb().run(
      "UPDATE call_recordings SET status = 'stopping', ended_at = ? WHERE id = ?",
      [Date.now(), recordingId],
    );
    return res.json({ ok: true });
  }),
);

voiceRouter.get(
  '/:channelId/transcript',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    await voiceAccess(req, channelId);
    const rows = await getDb().all(
      `SELECT * FROM call_transcript_segments
       WHERE channel_id = ? ORDER BY created_at ASC LIMIT 5000`,
      [channelId],
    );
    return res.json({
      segments: rows.map((row) => ({
        id: row.id,
        participantId: row.participant_id,
        text: row.text,
        language: row.language,
        startedAt: row.started_at ? Number(row.started_at) : null,
        endedAt: row.ended_at ? Number(row.ended_at) : null,
        confidence: row.confidence === null ? null : Number(row.confidence),
      })),
    });
  }),
);

voiceRouter.post(
  '/:channelId/quality',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    await voiceAccess(req, channelId);
    const body = parse(
      z.object({
        quality: z.enum(['excellent', 'good', 'poor', 'lost', 'unknown']),
        rttMs: z.number().min(0).max(60000).optional().nullable(),
        jitterMs: z.number().min(0).max(60000).optional().nullable(),
        packetLoss: z.number().min(0).max(100).optional().nullable(),
        bitrateKbps: z.number().min(0).max(1000000).optional().nullable(),
        region: z.string().max(40).optional().nullable(),
      }),
      req.body,
    );
    await getDb().run(
      `INSERT INTO call_quality_samples
         (id, channel_id, user_id, quality, rtt_ms, jitter_ms,
          packet_loss, bitrate_kbps, region, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        channelId,
        req.user.id,
        body.quality,
        body.rttMs,
        body.jitterMs,
        body.packetLoss,
        body.bitrateKbps,
        body.region,
        Date.now(),
      ],
    );
    return res.status(201).json({ ok: true });
  }),
);

voiceRouter.get(
  '/:channelId/quality',
  asyncRoute(async (req, res) => {
    const channelId = parse(idSchema, req.params.channelId);
    await requireHost(req, channelId);
    const row = await getDb().get(
      `SELECT COUNT(*) AS samples, AVG(rtt_ms) AS avg_rtt_ms,
              AVG(jitter_ms) AS avg_jitter_ms, AVG(packet_loss) AS avg_packet_loss,
              AVG(bitrate_kbps) AS avg_bitrate_kbps
       FROM call_quality_samples WHERE channel_id = ? AND created_at > ?`,
      [channelId, Date.now() - 24 * 3600_000],
    );
    return res.json({
      samples: Number(row.samples),
      avgRttMs: row.avg_rtt_ms === null ? null : Number(row.avg_rtt_ms),
      avgJitterMs: row.avg_jitter_ms === null ? null : Number(row.avg_jitter_ms),
      avgPacketLoss: row.avg_packet_loss === null ? null : Number(row.avg_packet_loss),
      avgBitrateKbps: row.avg_bitrate_kbps === null ? null : Number(row.avg_bitrate_kbps),
    });
  }),
);

async function voiceAccess(req, channelId) {
  const channel = await getDb().get(
    `SELECT c.* FROM channels c
     JOIN group_members gm ON gm.group_id = c.group_id AND gm.user_id = ?
     WHERE c.id = ? AND c.type IN ('voice', 'stage')`,
    [req.user.id, channelId],
  );
  if (!channel) throw notFound('Voice channel not found.');
  const context = await groupContext(channel.group_id, req.user);
  if (await activeServerTimeout(channel.group_id, req.user.id)) {
    throw forbidden('You cannot join voice channels while timed out.');
  }
  if (!(await channelPermission(channel, context, 'connectVoice'))) {
    throw forbidden('You do not have permission to connect to this voice channel.');
  }
  if (channel.is_private) {
    const seat = await getDb().get(
      'SELECT 1 AS ok FROM channel_members WHERE channel_id = ? AND user_id = ?',
      [channelId, req.user.id],
    );
    if (!seat && !context.can('manageChannels')) {
      throw forbidden('You cannot join this voice channel.');
    }
  }
  return { channel, context };
}

async function ensureCallRoom(channelId, requesterId) {
  const owner = await getDb().get(
    `SELECT gm.user_id FROM channels c
     JOIN group_members gm ON gm.group_id = c.group_id
     WHERE c.id = ? AND gm.role = 'owner' LIMIT 1`,
    [channelId],
  );
  const now = Date.now();
  await getDb().run(
    `INSERT INTO call_rooms (channel_id, host_id, created_at, updated_at)
     VALUES (?, ?, ?, ?) ON CONFLICT (channel_id) DO NOTHING`,
    [channelId, owner?.user_id ?? requesterId, now, now],
  );
  return getDb().get('SELECT * FROM call_rooms WHERE channel_id = ?', [channelId]);
}

async function requireHost(req, channelId) {
  const { context } = await voiceAccess(req, channelId);
  const room = await ensureCallRoom(channelId, req.user.id);
  if (room.host_id !== req.user.id && !context.can('manageChannels')) {
    throw forbidden('Only the call host can perform this action.');
  }
  return room;
}

async function requireVoiceControl(req, channelId, permission) {
  const { channel, context } = await voiceAccess(req, channelId);
  const room = await ensureCallRoom(channelId, req.user.id);
  if (
    room.host_id !== req.user.id &&
    !(await channelPermission(channel, context, permission)) &&
    !(await channelPermission(channel, context, 'manageChannels'))
  ) {
    throw forbidden(`The ${permission} permission is required.`);
  }
  return { room, channel, context };
}

async function participantPublishGrant(channel, userId, requested) {
  if (!requested) return { canPublish: false, canPublishSources: [] };
  if (await activeServerTimeout(channel.group_id, userId)) {
    return { canPublish: false, canPublishSources: [] };
  }
  const user = await getDb().get('SELECT id, role FROM users WHERE id = ?', [userId]);
  if (!user) return { canPublish: false, canPublishSources: [] };
  const context = await groupContext(channel.group_id, user);
  const canSpeak = await channelPermission(channel, context, 'speak');
  if (!canSpeak) return { canPublish: false, canPublishSources: [] };
  const canUseVideo = await channelPermission(channel, context, 'video');
  return {
    canPublish: true,
    canPublishSources: [
      TrackSource.MICROPHONE,
      ...(canUseVideo
        ? [
            TrackSource.CAMERA,
            TrackSource.SCREEN_SHARE,
            TrackSource.SCREEN_SHARE_AUDIO,
          ]
        : []),
    ],
  };
}

function selectRegion(name) {
  const configured = config.livekit.regions;
  const selected = configured.find((region) => region.name === name) ?? configured[0];
  return (
    selected ?? {
      name: 'default',
      url: config.livekit.url,
      apiUrl: config.livekit.apiUrl || config.livekit.url,
    }
  );
}

function roomClient(region) {
  return new RoomServiceClient(
    region.apiUrl.replace(/^ws/, 'http'),
    config.livekit.apiKey,
    config.livekit.apiSecret,
  );
}

function egressClient(region) {
  return new EgressClient(
    region.apiUrl.replace(/^ws/, 'http'),
    config.livekit.apiKey,
    config.livekit.apiSecret,
  );
}

function toCallRoom(row) {
  return {
    channelId: row.channel_id,
    hostId: row.host_id,
    lobbyEnabled: Boolean(row.lobby_enabled),
    recordingConsentRequired: Boolean(row.recording_consent_required),
    preferredRegion: row.preferred_region,
    status: row.status,
  };
}

function toLobby(row) {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    status: row.status,
    requestedAt: Number(row.requested_at),
  };
}

function toRecording(row) {
  return {
    id: row.id,
    egressId: row.egress_id,
    status: row.status,
    storageKey: row.storage_key,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at ? Number(row.ended_at) : null,
  };
}

function getRecording(id) {
  return getDb().get('SELECT * FROM call_recordings WHERE id = ?', [id]);
}
