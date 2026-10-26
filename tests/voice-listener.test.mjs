import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../client/package.json', import.meta.url));
const ts = require('typescript');
const { create } = require('zustand');
const source = ts.transpileModule(fs.readFileSync(new URL('../client/src/store/voice.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

// Exercise the production store with SDK/device boundaries controlled. These
// tests verify capture, permission and cleanup behavior; they do not claim RTP
// delivery. Actual media assertions remain in the Playwright LiveKit suites.
function harness(transport = 'sfu') {
  let nextId = 0, mode = 'available', captures = 0;
  const rooms = [], events = [], notices = [], handlers = new Set();
  class Track {
    constructor(kind = 'audio') { this.kind = kind; this.id = 'track-' + ++nextId; this.readyState = 'live'; this.enabled = true; }
    stop() { this.readyState = 'ended'; }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; this.id = 'stream-' + ++nextId; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
  }
  const connections = [];
  class Peer {
    constructor() { this.senders = []; this.transceivers = []; connections.push(this); }
    addTrack(track) { const sender = {track, replaceTrack: async next => { sender.track = next; }}; this.senders.push(sender); return sender; }
    getSenders() { return this.senders; }
    addTransceiver(kind, options) { this.transceivers.push({kind, ...options}); }
    close() { this.connectionState = 'closed'; }
  }
  class Room {
    constructor() {
      this.events = new Map(); this.remoteParticipants = new Map(); rooms.push(this);
      this.localParticipant = {
        trackPublications: new Map(),
        publishTrack: async (mediaStreamTrack, options) => {
          if (mode === 'publish-failed') throw Error('publish failed');
          this.localParticipant.trackPublications.set(mediaStreamTrack.id, {source: options.source, track: {mediaStreamTrack}});
        },
        unpublishTrack: async track => {
          for (const [id, publication] of this.localParticipant.trackPublications) if (publication.track === track) this.localParticipant.trackPublications.delete(id);
        },
        setMicrophoneEnabled: async enabled => {
          const publication = [...this.localParticipant.trackPublications.values()].find(item => item.source === 'microphone');
          assert(publication, 'SDK must never initiate implicit microphone capture');
          publication.track.mediaStreamTrack.enabled = enabled;
        },
        setCameraEnabled: async enabled => {
          if (enabled && mode === 'camera-denied') throw Error('camera unavailable');
          if (enabled) await this.localParticipant.publishTrack(new Track('video'), {source: 'camera'});
        },
      };
    }
    on(name, handler) { this.events.set(name, handler); }
    async connect() { this.connected = true; }
    disconnect() { this.connected = false; this.events.get('Disconnected')?.(); }
  }
  const session = {user: {id: 'self'}, voiceMode: transport, iceServers: []};
  const realtime = {
    connected: true,
    emit(name, ...args) { events.push({name, payload: args[0]}); if (name === 'voice:join') args.at(-1)({ok: true, peers: transport === 'mesh' ? [{userId: 'peer'}] : []}); },
    on(name) { const id = {name}; handlers.add(id); return () => handlers.delete(id); },
  };
  const modules = {
    zustand: {create},
    './realtime': {useRealtime: {getState: () => realtime}},
    './session': {useSession: {getState: () => session}},
    './toast': {toast: {info: text => notices.push(text), error: text => notices.push(text)}},
    '../lib/api': {api: {post: async () => ({url: 'ws://test', token: 'test', canPublish: true, canSpeak: true, canUseVideo: true, canScreenShare: true})}},
    '../lib/microphone': {
      captureMicrophone: async () => { captures++; if (['missing','denied'].includes(mode)) throw new DOMException('No input', mode === 'missing' ? 'NotFoundError' : 'NotAllowedError'); return new Stream([new Track()]); },
      releaseMicrophone: stream => stream?.getAudioTracks().forEach(track => track.stop()),
    },
    '../lib/useMediaPlayback': {registerSfuVideo() {}, setScreenTrack() {}},
    'livekit-client': {Room, RoomEvent: Object.fromEntries(['TrackSubscribed','TrackUnsubscribed','ParticipantDisconnected','ActiveSpeakersChanged','Disconnected','ParticipantPermissionsChanged'].map(name => [name, name])), Track: {Source: {Microphone: 'microphone'}}},
  };
  const exports = {};
  vm.runInNewContext(source, {exports, require: name => { assert(name in modules, 'Unexpected import ' + name); return modules[name]; }, MediaStream: Stream, RTCPeerConnection: Peer,
    AudioContext: class { constructor() { throw Error('No audio analyzer in unit fixture'); } }, DOMException, Error, Map, Set, Date, Promise, console,
    setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {}}, {filename: 'production-voice-store.cjs'});
  return {store: exports.useVoice, rooms, events, notices, handlers, connections, mode: value => { mode = value; }, captures: () => captures};
}

for (const transport of ['mesh', 'sfu']) {
  const h = harness(transport), state = () => h.store.getState();
  h.mode('denied');
  await state().join('room', {listenOnly: true});
  assert.equal(state().channelId, 'room'); assert.equal(state().muted, true); assert.equal(state().listenOnly, true); assert.equal(h.captures(), 0);
  state().toggleDeafen(); state().toggleDeafen(); assert.equal(h.captures(), 0); assert.equal(state().muted, true);
  await state().toggleMute(); assert.equal(h.captures(), 1); assert.equal(state().muted, true); assert.equal(state().channelId, 'room');
  h.mode('available'); await state().toggleMute(); assert.equal(state().muted, false); assert.equal(state().listenOnly, false);
  const microphone = state().localStream.getAudioTracks()[0]; assert.equal(microphone.enabled, true);
  await state().toggleMute(); state().toggleDeafen(); state().toggleDeafen(); assert.equal(state().muted, true); assert.equal(microphone.enabled, false);
  const captures = h.captures(); await state().recoverSignalling(); assert.equal(h.captures(), captures); assert.equal(state().channelId, 'room');
  if (transport === 'mesh') assert(h.connections.some(peer => peer.transceivers.some(item => item.kind === 'audio' && item.direction === 'recvonly')), 'Listener needs an audio receive section');
  state().leave(); assert.equal(state().channelId, null); assert.equal(h.handlers.size, 0); assert.equal(microphone.readyState, 'ended');
  console.log('PASS', transport, 'explicit listener, capture denial/retry, promotion, mute/deafen, reconnect without recapture, cleanup');
}
for (const mode of ['missing', 'denied', 'publish-failed', 'camera-denied']) {
  const h = harness(); h.mode(mode); await h.store.getState().join('room', {withVideo: mode === 'camera-denied'});
  const state = h.store.getState(); assert.equal(state.channelId, 'room'); assert.equal(state.connecting, false);
  assert.equal(state.muted, mode !== 'camera-denied'); assert.equal(state.cameraOn, false);
  h.store.getState().leave(); assert.equal(h.handlers.size, 0);
  console.log('PASS SFU', mode, 'does not eject a listener or an audio-only participant');
}
const revoked = harness(); await revoked.store.getState().join('room');
const captured = revoked.store.getState().localStream.getAudioTracks()[0];
revoked.rooms[0].events.get('ParticipantPermissionsChanged')(null, {identity: 'self', permissions: {canPublish: false, canPublishSources: []}});
assert.equal(revoked.store.getState().muted, true); assert.equal(captured.readyState, 'ended');
const attempts = revoked.captures(); await revoked.store.getState().toggleMute(); assert.equal(revoked.captures(), attempts);
revoked.store.getState().leave();
console.log('PASS SFU live speaking revocation stops local capture and forbids recapture');
