import net from 'node:net';

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.on('end', () => {
    const payload = Buffer.concat(chunks).toString('utf8');
    socket.end(
      payload.includes('zPING')
        ? 'PONG\0'
        : payload.includes('EICAR-SIMULATION')
        ? 'stream: Eicar-Test-Signature FOUND\0'
        : 'stream: OK\0',
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
Object.assign(process.env, {
  CLAMAV_HOST: '127.0.0.1',
  CLAMAV_PORT: String(address.port),
  CLAMAV_REQUIRED: 'true',
  CLAMAV_TIMEOUT_MS: '2000',
  DATA_DIR: `${process.cwd()}\\.tmp\\antivirus-${process.pid}`,
  APP_SECRET: 'antivirus-test-secret-longer-than-thirty-two-characters',
});

const { antivirusHealth, scanBuffer } = await import('../server/src/services/antivirus.js');
if (!(await antivirusHealth()).ok) throw new Error('ClamAV health probe failed');
const clean = await scanBuffer(Buffer.from('safe content'));
if (clean.status !== 'clean') throw new Error('clean file did not pass ClamAV protocol');
let blocked = false;
try {
  await scanBuffer(Buffer.from('EICAR-SIMULATION'));
} catch (error) {
  blocked = error.status === 403;
}
if (!blocked) throw new Error('malware signature was not blocked');
await new Promise((resolve) => server.close(resolve));
console.log('  PASS  ClamAV INSTREAM clean and malware responses');
