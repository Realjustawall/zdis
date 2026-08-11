import net from 'node:net';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { forbidden } from '../lib/errors.js';

export async function scanBuffer(buffer) {
  if (!config.clamav.host) {
    if (config.clamav.required) {
      throw forbidden('File scanning is temporarily unavailable.');
    }
    return { status: 'skipped', engine: null };
  }

  try {
    const response = await clamInstream(buffer);
    if (response.includes('FOUND')) {
      const signature = response.split(':').slice(1).join(':').replace('FOUND', '').trim();
      logger.warn('malware upload blocked', { signature });
      throw forbidden('The upload was rejected by malware scanning.');
    }
    if (!response.includes('OK')) throw new Error(`Unexpected ClamAV response: ${response}`);
    return { status: 'clean', engine: 'clamav' };
  } catch (error) {
    if (error?.status === 403) throw error;
    logger.warn('clamav scan unavailable', { error: error.message });
    if (config.clamav.required) {
      throw forbidden('File scanning is temporarily unavailable. Try again later.');
    }
    return { status: 'skipped', engine: 'clamav' };
  }
}

export function antivirusHealth() {
  if (!config.clamav.host) {
    return Promise.resolve({ configured: false, ok: !config.clamav.required });
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: config.clamav.host,
      port: config.clamav.port,
    });
    const timer = setTimeout(() => socket.destroy(), Math.min(config.clamav.timeoutMs, 3000));
    let response = '';
    socket.on('connect', () => socket.end('zPING\0'));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve({ configured: true, ok: response.includes('PONG') });
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      resolve({ configured: true, ok: false, error: error.message });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!response) resolve({ configured: true, ok: false });
    });
  });
}

function clamInstream(buffer) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: config.clamav.host,
      port: config.clamav.port,
    });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy(new Error('ClamAV scan timed out'));
    }, config.clamav.timeoutMs);

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(response.replace(/\0/g, '').trim());
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
