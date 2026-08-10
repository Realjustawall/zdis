import { create } from 'zustand';
import { useRealtime } from './realtime';
import { useSession } from './session';
import { toast } from './toast';
import { api } from '../lib/api';

/**
 * Full-mesh WebRTC. Each participant keeps one RTCPeerConnection per peer and
 * the server only carries signalling, so no media ever passes through it.
 *
 * Glare (both sides offering at once) is avoided by a fixed rule: the peer who
 * joined later always creates the offer. The server tells a newcomer who is
 * already present, and tells everyone present that a newcomer arrived — the
 * newcomer offers, the incumbents answer.
 */

interface PeerEntry {
  connection: RTCPeerConnection;
  stream: MediaStream;
  /** Buffered until the remote description exists. */
  pendingCandidates: RTCIceCandidateInit[];
}

interface VoiceState {
  channelId: string | null;
  connecting: boolean;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  muted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  stageAudience: boolean;
  speaking: Record<string, boolean>;
  joinedAt: number | null;

  join: (channelId: string, options?: { withVideo?: boolean }) => Promise<void>;
  leave: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
}

const peers = new Map<string, PeerEntry>();
let sfuRoom: import('livekit-client').Room | null = null;
let detachSignalling: (() => void) | null = null;
let speakingMonitor: number | null = null;
let audioContext: AudioContext | null = null;

function iceConfig(): RTCConfiguration {
  return {
    iceServers: useSession.getState().iceServers,
    iceCandidatePoolSize: 2,
  };
}

function attachLocalTracks(connection: RTCPeerConnection) {
  const { localStream, screenStream } = useVoice.getState();
  if (localStream) {
    for (const track of localStream.getTracks()) connection.addTrack(track, localStream);
  }
  if (screenStream) {
    for (const track of screenStream.getTracks()) connection.addTrack(track, screenStream);
  }
}

function createPeer(peerId: string, initiator: boolean): PeerEntry {
  const existing = peers.get(peerId);
  if (existing) return existing;

  const connection = new RTCPeerConnection(iceConfig());
  const stream = new MediaStream();
  const entry: PeerEntry = { connection, stream, pendingCandidates: [] };
  peers.set(peerId, entry);

  attachLocalTracks(connection);

  connection.ontrack = (event) => {
    for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
    }
    useVoice.setState((state) => ({
      remoteStreams: { ...state.remoteStreams, [peerId]: stream },
    }));
  };

  connection.onicecandidate = (event) => {
    if (!event.candidate) return;
    useRealtime.getState().emit('voice:ice', { to: peerId, payload: event.candidate.toJSON() });
  };

  connection.onconnectionstatechange = () => {
    if (connection.connectionState === 'failed') {
      // A failed connection is usually a NAT problem; a restart is cheap and
      // often recovers without the user noticing.
      connection.restartIce();
    }
    if (connection.connectionState === 'closed') dropPeer(peerId);
  };

  if (initiator) {
    connection.onnegotiationneeded = async () => {
      try {
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        useRealtime.getState().emit('voice:offer', { to: peerId, payload: connection.localDescription });
      } catch {
        /* renegotiation races are recovered by the next state change */
      }
    };
  }

  return entry;
}

function dropPeer(peerId: string) {
  const entry = peers.get(peerId);
  if (!entry) return;
  entry.connection.onicecandidate = null;
  entry.connection.ontrack = null;
  entry.connection.onnegotiationneeded = null;
  entry.connection.close();
  peers.delete(peerId);
  useVoice.setState((state) => {
    const next = { ...state.remoteStreams };
    delete next[peerId];
    const speaking = { ...state.speaking };
    delete speaking[peerId];
    return { remoteStreams: next, speaking };
  });
}

function teardown() {
  for (const peerId of [...peers.keys()]) dropPeer(peerId);
  detachSignalling?.();
  detachSignalling = null;
  if (speakingMonitor !== null) {
    cancelAnimationFrame(speakingMonitor);
    speakingMonitor = null;
  }
  audioContext?.close().catch(() => {});
  audioContext = null;
}

/** Lightweight local speaking detection so the UI can highlight the talker. */
function startSpeakingDetection(stream: MediaStream, selfId: string) {
  try {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking = false;
    let lastEmit = 0;

    const tick = () => {
      analyser.getByteFrequencyData(buffer);
      let sum = 0;
      for (const value of buffer) sum += value;
      const average = sum / buffer.length;
      const speaking = average > 14 && !useVoice.getState().muted;

      if (speaking !== wasSpeaking && Date.now() - lastEmit > 220) {
        wasSpeaking = speaking;
        lastEmit = Date.now();
        useVoice.setState((state) => ({ speaking: { ...state.speaking, [selfId]: speaking } }));
        useRealtime.getState().emit('voice:update', { speaking });
      }
      speakingMonitor = requestAnimationFrame(tick);
    };
    speakingMonitor = requestAnimationFrame(tick);
  } catch {
    /* speaking indicators are cosmetic */
  }
}

export const useVoice = create<VoiceState>((set, get) => ({
  channelId: null,
  connecting: false,
  localStream: null,
  screenStream: null,
  remoteStreams: {},
  muted: false,
  deafened: false,
  cameraOn: false,
  screenSharing: false,
  stageAudience: false,
  speaking: {},
  joinedAt: null,

  async join(channelId, options = {}) {
    if (get().channelId === channelId) return;
    if (get().channelId) get().leave();

    set({ connecting: true });
    const realtime = useRealtime.getState();
    const selfId = useSession.getState().user?.id ?? '';

    // Direct-message calls use the existing end-to-end WebRTC mesh. Channel
    // calls may use the configured SFU, but DM room ids are intentionally not
    // sent to the channel-only voice REST API.
    if (useSession.getState().voiceMode === 'sfu' && !channelId.startsWith('dm:')) {
      try {
        const credentials = await api.post<{
          url?: string;
          token?: string;
          room?: string;
          maxParticipants?: number;
          lobby?: boolean;
          pending?: boolean;
          stage?: boolean;
          canPublish?: boolean;
        }>(`/api/voice/${channelId}/token`);
        if (credentials.lobby) {
          if (!credentials.pending) {
            await api.post(`/api/voice/${channelId}/lobby`);
          }
          set({ connecting: false });
          toast.info('Your request is waiting for the call host. Try joining again after approval.');
          return;
        }
        if (!credentials.url || !credentials.token) {
          throw new Error('The SFU did not return valid connection credentials.');
        }
        const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          realtime.emit('voice:join', { channelId, muted: false, video: Boolean(options.withVideo), sfu: true }, resolve);
          setTimeout(() => resolve({ ok: false, error: 'The server did not respond.' }), 8000);
        });
        if (!ack.ok) throw new Error(ack.error ?? 'Could not join the voice channel.');

        // LiveKit is the largest client dependency. Load it only for SFU calls
        // so normal chat sessions keep a small initial bundle and memory map.
        const { Room, RoomEvent } = await import('livekit-client');
        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          disconnectOnPageLeave: true,
        });
        sfuRoom = room;
        room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
          const mediaTrack = track.mediaStreamTrack;
          set((state) => {
            const stream = state.remoteStreams[participant.identity] ?? new MediaStream();
            if (!stream.getTracks().includes(mediaTrack)) stream.addTrack(mediaTrack);
            return {
              remoteStreams: { ...state.remoteStreams, [participant.identity]: stream },
            };
          });
        });
        room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
          set((state) => {
            const next = { ...state.remoteStreams };
            const stream = next[participant.identity];
            stream?.removeTrack(track.mediaStreamTrack);
            if (!stream?.getTracks().length) delete next[participant.identity];
            return { remoteStreams: next };
          });
        });
        room.on(RoomEvent.ParticipantDisconnected, (participant) => {
          set((state) => {
            const next = { ...state.remoteStreams };
            delete next[participant.identity];
            return { remoteStreams: next };
          });
        });
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const speaking = Object.fromEntries(speakers.map((participant) => [participant.identity, true]));
          set({ speaking });
        });
        room.on(RoomEvent.Disconnected, () => {
          if (sfuRoom !== room) return;
          sfuRoom = null;
          set({
            channelId: null,
            connecting: false,
            localStream: null,
            screenStream: null,
            remoteStreams: {},
            cameraOn: false,
            screenSharing: false,
            stageAudience: false,
            speaking: {},
            joinedAt: null,
          });
        });
        await room.connect(credentials.url, credentials.token, {
          rtcConfig: {
            iceServers: useSession.getState().iceServers,
          },
        });
        const canPublish = credentials.canPublish !== false;
        if (canPublish) await room.localParticipant.setMicrophoneEnabled(true);
        if (options.withVideo && canPublish) await room.localParticipant.setCameraEnabled(true);
        const localTracks = [...room.localParticipant.trackPublications.values()]
          .map((publication) => publication.track?.mediaStreamTrack)
          .filter((track): track is MediaStreamTrack => Boolean(track));
        const localStream = new MediaStream(localTracks);
        set({
          channelId,
          connecting: false,
          localStream,
          muted: !canPublish,
          deafened: false,
          cameraOn: Boolean(options.withVideo && canPublish),
          stageAudience: Boolean(credentials.stage && !canPublish),
          joinedAt: Date.now(),
        });
        return;
      } catch (error) {
        sfuRoom?.disconnect();
        sfuRoom = null;
        realtime.emit('voice:leave');
        set({ connecting: false, channelId: null, localStream: null, stageAudience: false });
        toast.error(error instanceof Error ? error.message : 'Could not join the SFU voice channel.');
        return;
      }
    }

    let localStream: MediaStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: options.withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (error) {
      set({ connecting: false });
      const name = (error as DOMException)?.name;
      toast.error(
        name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow it in your browser to join voice.'
          : 'No microphone was found.',
      );
      return;
    }

    set({
      localStream,
      cameraOn: Boolean(options.withVideo),
      muted: false,
      deafened: false,
    });

    const ack = await new Promise<{ ok: boolean; error?: string; peers?: { userId: string }[] }>(
      (resolve) => {
        realtime.emit('voice:join', { channelId, muted: false, video: Boolean(options.withVideo) }, resolve);
        setTimeout(() => resolve({ ok: false, error: 'The server did not respond.' }), 8000);
      },
    );

    if (!ack.ok) {
      for (const track of localStream.getTracks()) track.stop();
      set({ connecting: false, localStream: null, cameraOn: false });
      toast.error(ack.error ?? 'Could not join the voice channel.');
      return;
    }

    set({ channelId, connecting: false, joinedAt: Date.now(), stageAudience: false });
    startSpeakingDetection(localStream, selfId);

    // We joined last, so we offer to everyone already here.
    for (const peer of ack.peers ?? []) createPeer(peer.userId, true);

    const offs = [
      realtime.on('voice:peer-joined', (async (payload: { userId: string }) => {
        // They arrived after us: they will offer, we just prepare to answer.
        createPeer(payload.userId, false);
      }) as never),

      realtime.on('voice:offer', (async (payload: { from: string; payload: RTCSessionDescriptionInit }) => {
        const entry = createPeer(payload.from, false);
        try {
          await entry.connection.setRemoteDescription(new RTCSessionDescription(payload.payload));
          for (const candidate of entry.pendingCandidates.splice(0)) {
            await entry.connection.addIceCandidate(candidate).catch(() => {});
          }
          const answer = await entry.connection.createAnswer();
          await entry.connection.setLocalDescription(answer);
          realtime.emit('voice:answer', { to: payload.from, payload: entry.connection.localDescription });
        } catch {
          toast.error('A peer connection could not be established.');
        }
      }) as never),

      realtime.on('voice:answer', (async (payload: { from: string; payload: RTCSessionDescriptionInit }) => {
        const entry = peers.get(payload.from);
        if (!entry) return;
        try {
          await entry.connection.setRemoteDescription(new RTCSessionDescription(payload.payload));
          for (const candidate of entry.pendingCandidates.splice(0)) {
            await entry.connection.addIceCandidate(candidate).catch(() => {});
          }
        } catch {
          /* a late answer for a closed connection is harmless */
        }
      }) as never),

      realtime.on('voice:ice', (async (payload: { from: string; payload: RTCIceCandidateInit }) => {
        const entry = peers.get(payload.from);
        if (!entry) return;
        if (!entry.connection.remoteDescription) {
          entry.pendingCandidates.push(payload.payload);
          return;
        }
        await entry.connection.addIceCandidate(payload.payload).catch(() => {});
      }) as never),

      realtime.on('voice:peer-left', ((payload: { userId: string }) => {
        dropPeer(payload.userId);
      }) as never),

      realtime.on('voice:closed', (() => {
        get().leave();
      }) as never),
    ];

    detachSignalling = () => offs.forEach((off) => off());
  },

  leave() {
    const { localStream, screenStream, channelId } = get();
    if (!channelId) return;

    if (sfuRoom) {
      const room = sfuRoom;
      sfuRoom = null;
      room.disconnect();
      useRealtime.getState().emit('voice:leave');
      set({
        channelId: null,
        localStream: null,
        screenStream: null,
        remoteStreams: {},
        muted: false,
        deafened: false,
        cameraOn: false,
        screenSharing: false,
        stageAudience: false,
        speaking: {},
        joinedAt: null,
        connecting: false,
      });
      return;
    }

    teardown();
    for (const track of localStream?.getTracks() ?? []) track.stop();
    for (const track of screenStream?.getTracks() ?? []) track.stop();
    useRealtime.getState().emit('voice:leave');

    set({
      channelId: null,
      localStream: null,
      screenStream: null,
      remoteStreams: {},
      muted: false,
      deafened: false,
      cameraOn: false,
      screenSharing: false,
      stageAudience: false,
      speaking: {},
      joinedAt: null,
      connecting: false,
    });
  },

  toggleMute() {
    const { localStream, muted, deafened, stageAudience } = get();
    if (stageAudience) {
      toast.info('The stage host must invite you to speak first.');
      return;
    }
    const next = !muted;
    if (sfuRoom) {
      void sfuRoom.localParticipant.setMicrophoneEnabled(!next);
      set({ muted: next, deafened: next ? deafened : false });
      useRealtime.getState().emit('voice:update', { muted: next });
      return;
    }
    for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !next;
    // Un-muting while deafened would be confusing; lift both together.
    const nextDeafened = next ? deafened : false;
    set({ muted: next, deafened: nextDeafened });
    useRealtime.getState().emit('voice:update', { muted: next, deafened: nextDeafened });
  },

  toggleDeafen() {
    const { deafened, localStream } = get();
    const next = !deafened;
    if (sfuRoom) {
      for (const participant of sfuRoom.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          publication.setEnabled(!next);
        }
      }
      void sfuRoom.localParticipant.setMicrophoneEnabled(!next);
      set({ deafened: next, muted: next ? true : get().muted });
      useRealtime.getState().emit('voice:update', { deafened: next, muted: next ? true : get().muted });
      return;
    }
    // Deafening also mutes, matching what people expect from Discord.
    for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !next;
    set({ deafened: next, muted: next ? true : get().muted });
    useRealtime.getState().emit('voice:update', { deafened: next, muted: next ? true : get().muted });
  },

  async toggleCamera() {
    const { localStream, cameraOn, stageAudience } = get();
    if (stageAudience) {
      toast.info('Only stage speakers can use their camera.');
      return;
    }
    if (!localStream) return;
    if (sfuRoom) {
      const next = !cameraOn;
      try {
        await sfuRoom.localParticipant.setCameraEnabled(next);
        const tracks = [...sfuRoom.localParticipant.trackPublications.values()]
          .map((publication) => publication.track?.mediaStreamTrack)
          .filter((track): track is MediaStreamTrack => Boolean(track));
        set({ cameraOn: next, localStream: new MediaStream(tracks) });
        useRealtime.getState().emit('voice:update', { video: next });
      } catch {
        toast.error('Could not change the camera state.');
      }
      return;
    }

    if (cameraOn) {
      for (const track of localStream.getVideoTracks()) {
        track.stop();
        localStream.removeTrack(track);
        for (const { connection } of peers.values()) {
          const sender = connection.getSenders().find((s) => s.track === track);
          if (sender) connection.removeTrack(sender);
        }
      }
      set({ cameraOn: false });
      useRealtime.getState().emit('voice:update', { video: false });
      return;
    }

    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const [track] = camera.getVideoTracks();
      localStream.addTrack(track);
      for (const { connection } of peers.values()) connection.addTrack(track, localStream);
      set({ cameraOn: true });
      useRealtime.getState().emit('voice:update', { video: true });
    } catch {
      toast.error('Could not start the camera.');
    }
  },

  async toggleScreenShare() {
    const { screenStream, screenSharing, localStream, stageAudience } = get();
    if (stageAudience) {
      toast.info('Only stage speakers can share their screen.');
      return;
    }
    if (sfuRoom) {
      const next = !screenSharing;
      try {
        await sfuRoom.localParticipant.setScreenShareEnabled(next, { audio: true });
        const publication = [...sfuRoom.localParticipant.trackPublications.values()].find(
          (item) => item.source === 'screen_share',
        );
        const track = publication?.track?.mediaStreamTrack;
        set({
          screenSharing: next,
          screenStream: next && track ? new MediaStream([track]) : null,
        });
        useRealtime.getState().emit('voice:update', { screen: next });
      } catch {
        if (next) toast.error('Could not start screen sharing.');
      }
      return;
    }

    if (screenSharing) {
      for (const track of screenStream?.getTracks() ?? []) {
        track.stop();
        for (const { connection } of peers.values()) {
          const sender = connection.getSenders().find((s) => s.track === track);
          if (sender) connection.removeTrack(sender);
        }
      }
      set({ screenStream: null, screenSharing: false });
      useRealtime.getState().emit('voice:update', { screen: false });
      return;
    }

    try {
      const capture = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
      const [videoTrack] = capture.getVideoTracks();
      // The browser's own "stop sharing" bar must switch our state too.
      videoTrack.addEventListener('ended', () => {
        void get().toggleScreenShare();
      });

      for (const track of capture.getTracks()) {
        for (const { connection } of peers.values()) {
          connection.addTrack(track, localStream ?? capture);
        }
      }
      set({ screenStream: capture, screenSharing: true });
      useRealtime.getState().emit('voice:update', { screen: true });
    } catch {
      // The user cancelling the picker is not an error worth reporting.
    }
  },
}));
