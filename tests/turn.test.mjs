import crypto from 'node:crypto';

Object.assign(process.env, {
  DATA_DIR: `${process.cwd()}\\.tmp\\turn-${process.pid}`,
  APP_SECRET: 'turn-test-application-secret-longer-than-thirty-two-characters',
  STUN_URLS: 'stun:stun.example.com:3478',
  TURN_URL: 'turns:turn.example.com:5349',
  TURN_SHARED_SECRET: 'turn-shared-secret-for-automated-testing',
  TURN_CREDENTIAL_TTL_SECONDS: '3600',
});

const { iceServers } = await import('../server/src/routes/auth.js');
const servers = iceServers('user-123');
const turn = servers.find((entry) => String(entry.urls).startsWith('turns:'));
if (!turn) throw new Error('TURN server was not returned');
const [expiry, userId] = turn.username.split(':');
if (userId !== 'user-123' || Number(expiry) < Math.floor(Date.now() / 1000) + 3500) {
  throw new Error('TURN username is not user-bound and time-limited');
}
const expected = crypto
  .createHmac('sha1', process.env.TURN_SHARED_SECRET)
  .update(turn.username)
  .digest('base64');
if (turn.credential !== expected) throw new Error('TURN HMAC credential is invalid');
console.log('  PASS  expiring coturn HMAC credentials');
