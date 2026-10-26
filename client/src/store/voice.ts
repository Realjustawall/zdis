import { create } from 'zustand';
import { useRealtime } from './realtime';
import { useSession } from './session';
import { toast } from './toast';
import { api } from '../lib/api';
import { captureMicrophone, releaseMicrophone } from '../lib/microphone';
import { registerSfuVideo, setScreenTrack } from '../lib/useMediaPlayback';

/**
 * Full-mesh WebRTC. Each participant keeps one RTCPeerConnection per peer and
 * the server only carries signalling, so no media ever passes through it.
 *
 * Both peers can renegotiate when camera or screen tracks change. The
 * incumbent is polite and rolls back a colliding offer; the newcomer ignores
 * collisions. This keeps simultaneous media changes from deadlocking.
 */

interface PeerEntry {
  connection: RTCPeerConnection;
  stream: MediaStream;
  /** Buffered until the remote description exists. */
  pendingCandidates: RTCIceCandidateInit[];
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  remoteScreenStreamId: string | null;
  trackStreams: Map<MediaStreamTrack, string>;
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
  listenOnly: boolean;
  microphoneBusy: boolean;
  speaking: Record<string, boolean>;
  joinedAt: number | null;

  join: (channelId: string, options?: { withVideo?: boolean; listenOnly?: boolean }) => Promise<void>;
  leave: () => void;
  changeInputDevice: () => Promise<void>;
  toggleMute: () => Promise<void>;
  recoverSignalling: () => Promise<void>;
  toggleDeafen: () => void;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
}

const peers = new Map<string, PeerEntry>();
let sfuRoom: import('livekit-client').Room | null = null;
let sfuPermissions={speak:true,video:true,screenShare:true};
let detachSignalling: (() => void) | null = null;
let speakingMonitor: number | null = null;
let audioContext: AudioContext | null = null;
let mutedBeforeDeafen = false;

function registerVoice(channelId: string, sfu = false, videoRequested = false) {
  const { muted, deafened, cameraOn } = useVoice.getState();
  return new Promise<{ok: boolean; error?: string; peers?: {userId: string}[]}>((resolve) => {
    const timer = setTimeout(() => resolve({ok: false, error: 'The server did not respond.'}), 8000);
    useRealtime.getState().emit('voice:join', {channelId, muted, deafened, video: cameraOn, requestedVideo: videoRequested || cameraOn, sfu}, (reply: {ok: boolean; error?: string; peers?: {userId: string}[]}) => { clearTimeout(timer); resolve(reply); });
  });
}

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
  if (!localStream?.getAudioTracks().length) connection.addTransceiver('audio', { direction: 'recvonly' });
  if (!localStream?.getVideoTracks().length) connection.addTransceiver('video', { direction: 'recvonly' });
  if (screenStream) {
    for (const track of screenStream.getTracks()) connection.addTrack(track, screenStream);
  }
}

function createPeer(peerId: string, initiator: boolean): PeerEntry {
  const existing = peers.get(peerId);
  if (existing) return existing;

  const connection = new RTCPeerConnection(iceConfig());
  const stream = new MediaStream();
  const entry: PeerEntry = { connection, stream, pendingCandidates: [], polite: !initiator, makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false, remoteScreenStreamId: null, trackStreams: new Map() };
  peers.set(peerId, entry);

  attachLocalTracks(connection);

  connection.ontrack = (event) => {
    for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
      const streamId = event.streams[0]?.id ?? '';
      entry.trackStreams.set(track, streamId);
      setScreenTrack(track, streamId === entry.remoteScreenStreamId);
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

  connection.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await connection.setLocalDescription();
        useRealtime.getState().emit('voice:offer', { to: peerId, payload: { ...connection.localDescription?.toJSON(), screenStreamId: useVoice.getState().screenStream?.id ?? null } });
      } catch {
        /* renegotiation races are recovered by the next state change */
      } finally {
        entry.makingOffer = false;
      }
    };

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
  if (speakingMonitor !== null) cancelAnimationFrame(speakingMonitor);
  void audioContext?.close().catch(() => {});
  if (!stream.getAudioTracks().length) { audioContext = null; speakingMonitor = null; return; }
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
  listenOnly: false,
  microphoneBusy: false,
  speaking: {},
  joinedAt: null,

  async join(channelId, options = {}) {
    if (get().channelId === channelId || get().connecting) return;
    if (get().channelId) get().leave();

    mutedBeforeDeafen = false;
    set({ connecting: true, muted: true, deafened: false, cameraOn: false, listenOnly: Boolean(options.listenOnly) });
    const realtime = useRealtime.getState();
    const selfId = useSession.getState().user?.id ?? '';

    // Direct-message calls use the existing end-to-end WebRTC mesh. Channel
    // calls may use the configured SFU, but DM room ids are intentionally not
    // sent to the channel-only voice REST API.
    if (useSession.getState().voiceMode === 'sfu') {
      let pendingMicrophone: MediaStream | null = null;
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
          canSpeak?: boolean;
          canUseVideo?: boolean;
          canScreenShare?: boolean;
        }>(channelId.startsWith('dm:') ? `/api/voice/direct/${channelId.slice(3)}/token` : `/api/voice/${channelId}/token`);
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
        const ack = await registerVoice(channelId, true, Boolean(options.withVideo && !options.listenOnly));
        if (!ack.ok) throw new Error(ack.error ?? 'Could not join the voice channel.');

        // LiveKit is the largest client dependency. Load it only for SFU calls
        // so normal chat sessions keep a small initial bundle and memory map.
        const { Room, RoomEvent, Track } = await import('livekit-client');
        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          disconnectOnPageLeave: true,
        });
        sfuRoom = room;
        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          const mediaTrack = track.mediaStreamTrack;
          if (track.kind === 'video') registerSfuVideo(mediaTrack, track);
          setScreenTrack(mediaTrack, publication.source === 'screen_share');
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
          teardown();
          realtime.emit('voice:leave');
          releaseMicrophone(get().localStream);
          releaseMicrophone(pendingMicrophone);
          set({
            channelId: null,
            connecting: false,
            localStream: null,
            screenStream: null,
            remoteStreams: {},
            cameraOn: false,
            screenSharing: false,
            stageAudience: false,
            listenOnly: false,
            microphoneBusy: false,
            speaking: {},
            joinedAt: null,
          });
        });
        await room.connect(credentials.url, credentials.token, {
          rtcConfig: {
            iceServers: useSession.getState().iceServers,
          },
        });
        room.on(RoomEvent.ParticipantPermissionsChanged,(_previous,participant)=>{
          if(participant.identity!==selfId)return;
          const permission=participant.permissions;
          const allows=(source:number)=>Boolean(permission?.canPublish && (!permission.canPublishSources.length||permission.canPublishSources.includes(source)));
          sfuPermissions={speak:allows(2),video:allows(1),screenShare:allows(3)};
          if (!sfuPermissions.speak) { releaseMicrophone(get().localStream); set({muted: true, listenOnly: true}); }
          set({stageAudience: Boolean(credentials.stage && !permission?.canPublish)});
          if(!sfuPermissions.video)set({cameraOn:false});
          if(!sfuPermissions.screenShare)set({screenSharing:false,screenStream:null});
        });
        const callEnded = (payload:{channelId:string}) => { if(payload.channelId===get().channelId)get().leave(); };
        const callOffs = [realtime.on('voice:closed',callEnded as never), realtime.on('voice:ended',callEnded as never), realtime.on('voice:peer-left',((payload:{channelId:string})=>{if(payload.channelId===get().channelId && payload.channelId.startsWith('dm:') && room.remoteParticipants.size<=1)get().leave();}) as never)];
        detachSignalling=()=>callOffs.forEach(off=>off());
        const canPublish = credentials.canPublish !== false;
        sfuPermissions={speak:credentials.canSpeak??canPublish,video:credentials.canUseVideo??canPublish,screenShare:credentials.canScreenShare??canPublish};
        if (sfuPermissions.speak && !options.listenOnly) {
          try {
            pendingMicrophone = await captureMicrophone();
            await room.localParticipant.publishTrack(pendingMicrophone.getAudioTracks()[0], { source: Track.Source.Microphone });
          } catch {
            releaseMicrophone(pendingMicrophone); pendingMicrophone = null;
            toast.info('Microphone unavailable. You joined as a listener.');
          }
        }
        if (options.withVideo && !options.listenOnly && sfuPermissions.video) {
          try { await room.localParticipant.setCameraEnabled(true); }
          catch { toast.info('Camera unavailable. You can stay in the call without video.'); }
        }
        const localTracks = [...room.localParticipant.trackPublications.values()]
          .map((publication) => publication.track?.mediaStreamTrack)
          .filter((track): track is MediaStreamTrack => Boolean(track && track.readyState === 'live'));
        const localStream = new MediaStream(localTracks);
        set({
          channelId,
          connecting: false,
          localStream,
          muted: !localStream.getAudioTracks().length,
          listenOnly: !localStream.getAudioTracks().length,
          deafened: false,
          cameraOn: localStream.getVideoTracks().length > 0,
          stageAudience: Boolean(credentials.stage && !canPublish),
          joinedAt: Date.now(),
        });
        realtime.emit('voice:update', { muted: get().muted, video: get().cameraOn });
        return;
      } catch (error) {
        releaseMicrophone(pendingMicrophone);
        sfuRoom?.disconnect();
        sfuRoom = null;
        realtime.emit('voice:leave');
        set({ connecting: false, channelId: null, localStream: null, stageAudience: false });
        toast.error(error instanceof Error ? error.message : 'Could not join the SFU voice channel.');
        return;
      }
    }

    let localStream = new MediaStream();
    if (!options.listenOnly) {
      try { localStream = await captureMicrophone(); }
      catch { toast.info('Microphone unavailable. You joined as a listener.'); }
    }
    set({ localStream, cameraOn: false, muted: !localStream.getAudioTracks().length,
      listenOnly: !localStream.getAudioTracks().length, deafened: false });
    const ack = await registerVoice(channelId, false, Boolean(options.withVideo && !options.listenOnly));

    if (!ack.ok) {
      releaseMicrophone(localStream);
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

      realtime.on('voice:offer', (async (payload: { from: string; payload: RTCSessionDescriptionInit & { screenStreamId?: string | null } }) => {
        const entry = createPeer(payload.from, false);
        try {
          const ready = !entry.makingOffer && (entry.connection.signalingState === 'stable' || entry.settingRemoteAnswer);
          entry.ignoreOffer = !entry.polite && !ready;
          if (entry.ignoreOffer) return;
          entry.remoteScreenStreamId = payload.payload.screenStreamId ?? null;
          for (const [track, streamId] of entry.trackStreams) setScreenTrack(track, streamId === entry.remoteScreenStreamId);
          await entry.connection.setRemoteDescription(new RTCSessionDescription(payload.payload));
          for (const candidate of entry.pendingCandidates.splice(0)) {
            await entry.connection.addIceCandidate(candidate).catch(() => {});
          }
          const answer = await entry.connection.createAnswer();
          await entry.connection.setLocalDescription(answer);
          realtime.emit('voice:answer', { to: payload.from, payload: { ...entry.connection.localDescription?.toJSON(), screenStreamId: get().screenStream?.id ?? null } });
        } catch {
          toast.error('A peer connection could not be established.');
        }
      }) as never),

      realtime.on('voice:answer', (async (payload: { from: string; payload: RTCSessionDescriptionInit & { screenStreamId?: string | null } }) => {
        const entry = peers.get(payload.from);
        if (!entry) return;
        try {
          entry.settingRemoteAnswer = true;
          entry.ignoreOffer = false;
          entry.remoteScreenStreamId = payload.payload.screenStreamId ?? null;
          for (const [track, streamId] of entry.trackStreams) setScreenTrack(track, streamId === entry.remoteScreenStreamId);
          await entry.connection.setRemoteDescription(new RTCSessionDescription(payload.payload));
          for (const candidate of entry.pendingCandidates.splice(0)) {
            await entry.connection.addIceCandidate(candidate).catch(() => {});
          }
        } catch {
          /* a late answer for a closed connection is harmless */
        } finally {
          entry.settingRemoteAnswer = false;
        }
      }) as never),

      realtime.on('voice:ice', (async (payload: { from: string; payload: RTCIceCandidateInit }) => {
        const entry = peers.get(payload.from);
        if (!entry) return;
        if (entry.ignoreOffer) return;
        if (!entry.connection.remoteDescription) {
          entry.pendingCandidates.push(payload.payload);
          return;
        }
        await entry.connection.addIceCandidate(payload.payload).catch(() => {});
      }) as never),

      realtime.on('voice:peer-left', ((payload: { userId: string }) => {
        dropPeer(payload.userId);
        const active = get().channelId;
        if (active?.startsWith('dm:') && peers.size === 0) get().leave();
      }) as never),

      realtime.on('voice:closed', (() => {
        get().leave();
      }) as never),
    ];

    detachSignalling = () => offs.forEach((off) => off());
    if (options.withVideo && !options.listenOnly) await get().toggleCamera();
  },

  async recoverSignalling() {
    const { channelId, connecting } = get();
    if (!channelId || connecting) return;
    const ack = await registerVoice(channelId, Boolean(sfuRoom));
    if (get().channelId !== channelId) return;
    if (!ack.ok) {
      if (useRealtime.getState().connected) { get().leave(); toast.error(ack.error ?? 'Could not restore the voice connection.'); }
      return;
    }
    if (!sfuRoom) {
      // Other clients discarded the old connection on peer-left. Reuse our
      // local media without requesting capture again, and negotiate fresh peers.
      for (const id of [...peers.keys()]) dropPeer(id);
      for (const peer of ack.peers ?? []) createPeer(peer.userId, true);
    }
  },

  leave() {
    const { localStream, screenStream, channelId } = get();
    if (!channelId) return;

    if (sfuRoom) {
      const room = sfuRoom;
      teardown();
      releaseMicrophone(localStream);
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
        listenOnly: false,
        microphoneBusy: false,
        speaking: {},
        joinedAt: null,
        connecting: false,
      });
      return;
    }

    teardown();
    releaseMicrophone(localStream);
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
      listenOnly: false,
      microphoneBusy: false,
      speaking: {},
      joinedAt: null,
      connecting: false,
    });
  },

  async changeInputDevice() {
    const { localStream, channelId, muted, deafened, stageAudience } = get();
    if (!localStream || !channelId || stageAudience) return;
    if (sfuRoom && !sfuPermissions.speak) throw new Error('Speaking is disabled by your permissions.');
    const replacement = await captureMicrophone();
    const track = replacement.getAudioTracks()[0];
    track.enabled = !muted && !deafened;
    const oldTrack = localStream.getAudioTracks()[0];
    try {
      if (get().channelId !== channelId) throw new Error('The call ended while changing microphone.');
      if (sfuRoom) {
        const room = sfuRoom;
        const { Track } = await import('livekit-client');
        const publication = [...room.localParticipant.trackPublications.values()].find(item => item.source === Track.Source.Microphone);
        if (publication?.track) await room.localParticipant.unpublishTrack(publication.track, false);
        try { await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone }); }
        catch (error) { if (oldTrack?.readyState === 'live') await room.localParticipant.publishTrack(oldTrack, { source: Track.Source.Microphone }); throw error; }
      } else {
        const senders = [...peers.values()].flatMap(peer => peer.connection.getSenders()).filter(sender => sender.track?.kind === 'audio');
        try {
          await Promise.all(senders.map(sender => sender.replaceTrack(track)));
          for (const peer of peers.values()) { if (!peer.connection.getSenders().some(sender => sender.track?.kind === 'audio')) peer.connection.addTrack(track, replacement); }
        }
        catch (error) { await Promise.allSettled(senders.map(sender => sender.replaceTrack(oldTrack))); throw error; }
      }
      if (get().channelId !== channelId) throw new Error('The call ended while changing microphone.');
      releaseMicrophone(localStream);
      const updated = new MediaStream([track, ...localStream.getVideoTracks()]);
      set({ localStream: updated, listenOnly: false });
      if (!sfuRoom) startSpeakingDetection(updated, useSession.getState().user?.id ?? '');
    } catch (error) { releaseMicrophone(replacement); throw error; }
  },

  async toggleMute() {
    const { channelId, muted, deafened, stageAudience, microphoneBusy } = get();
    if (!channelId || microphoneBusy) return;
    if (stageAudience) { toast.info('The stage host must invite you to speak first.'); return; }
    const next = !muted;
    if (!next && sfuRoom && !sfuPermissions.speak) { toast.info('Speaking is disabled by your permissions.'); return; }
    set({ microphoneBusy: true });
    try {
      if (!next && !get().localStream?.getAudioTracks().some(track => track.readyState === 'live')) await get().changeInputDevice();
      if (get().channelId !== channelId) return;
      if (sfuRoom) {
        await sfuRoom.localParticipant.setMicrophoneEnabled(!next);
        if (!next && deafened) for (const participant of sfuRoom.remoteParticipants.values()) for (const publication of participant.trackPublications.values()) publication.setEnabled(true);
      }
      for (const track of get().localStream?.getAudioTracks() ?? []) track.enabled = !next;
      const nextDeafened = next ? deafened : false;
      set({ muted: next, deafened: nextDeafened });
      useRealtime.getState().emit('voice:update', {muted: next, deafened: nextDeafened});
    } catch { toast.error('Could not enable the microphone. You are still a listener.'); }
    finally { set({ microphoneBusy: false }); }
  },

  toggleDeafen() {
    const { deafened, localStream, muted } = get();
    const next = !deafened;
    if (next) mutedBeforeDeafen = muted;
    const nextMuted = next || mutedBeforeDeafen || !localStream?.getAudioTracks().some(track => track.readyState === 'live');
    if (sfuRoom) {
      for (const participant of sfuRoom.remoteParticipants.values()) for (const publication of participant.trackPublications.values()) publication.setEnabled(!next);
      // Deafen never opens a capture device, and undeafen never unmutes a
      // microphone that was muted before the user stopped listening.
      if (localStream?.getAudioTracks().length) void sfuRoom.localParticipant.setMicrophoneEnabled(!nextMuted).catch(() => {});
    }
    for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !nextMuted;
    set({deafened: next, muted: nextMuted});
    useRealtime.getState().emit('voice:update', {deafened: next, muted: nextMuted});
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
      if(next&&!sfuPermissions.video){toast.info('Camera sharing is disabled by your permissions.');return;}
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
    const { screenStream, screenSharing, stageAudience } = get();
    if (stageAudience) {
      toast.info('Only stage speakers can share their screen.');
      return;
    }
    if (sfuRoom) {
      const next = !screenSharing;
      if(next&&!sfuPermissions.screenShare){toast.info('Screen sharing is disabled by your permissions.');return;}
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
          connection.addTrack(track, capture);
        }
      }
      set({ screenStream: capture, screenSharing: true });
      useRealtime.getState().emit('voice:update', { screen: true });
    } catch {
      // The user cancelling the picker is not an error worth reporting.
    }
  },
}));
