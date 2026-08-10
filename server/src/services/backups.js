import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as tar from 'tar';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { readBackupArchive, saveBackupArchive } from './storage.js';

export async function runBackup() {
  const id = newId();
  const startedAt = Date.now();
  await getDb().run(
    `INSERT INTO backup_runs (id, provider, status, started_at)
     VALUES (?, ?, 'running', ?)`,
    [id, config.storageDriver === 's3' ? 's3' : 'local', startedAt],
  );
  const staging = path.join(config.backupDir, `.staging-${id}`);
  const filename = `youtbelimo-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${id}.tar.gz`;
  const archive = path.join(config.backupDir, filename);
  try {
    await fsp.mkdir(staging, { recursive: true });
    let databaseFile;
    if (getDb().dialect === 'sqlite') {
      databaseFile = 'database.sqlite';
      const target = path.join(staging, databaseFile);
      const escaped = target.replace(/'/g, "''");
      await getDb().exec(`VACUUM INTO '${escaped}'`);
    } else {
      databaseFile = 'database.dump';
      await runProcess('pg_dump', [
        '--dbname',
        config.databaseUrl,
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--file',
        path.join(staging, databaseFile),
      ]);
    }
    if (config.storageDriver === 'local') {
      await fsp.cp(config.uploadDir, path.join(staging, 'uploads'), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
    const manifest = {
      version: 1,
      createdAt: startedAt,
      database: getDb().dialect,
      databaseFile,
      includesLocalUploads: config.storageDriver === 'local',
      storageDriver: config.storageDriver,
    };
    await fsp.writeFile(
      path.join(staging, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    await tar.c({ gzip: true, cwd: staging, file: archive, portable: true }, ['.']);
    const bytes = await fsp.readFile(archive);
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    const remote = await saveBackupArchive(filename, bytes, checksum);
    const location = remote ?? archive;
    await getDb().run(
      `UPDATE backup_runs SET status = 'completed', location = ?, checksum = ?,
       bytes = ?, finished_at = ? WHERE id = ?`,
      [location, checksum, bytes.length, Date.now(), id],
    );
    await enforceLocalRetention();
    logger.info('backup completed', { id, location, bytes: bytes.length });
    return { id, location, checksum, bytes: bytes.length };
  } catch (error) {
    await getDb().run(
      `UPDATE backup_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      [error.message.slice(0, 1000), Date.now(), id],
    ).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

export async function verifyBackup(archive) {
  const staging = path.join(config.backupDir, `.verify-${newId()}`);
  await fsp.mkdir(staging, { recursive: true });
  try {
    const target = await materializeArchive(archive, staging);
    await tar.x({ cwd: staging, file: target, strict: true });
    const manifest = JSON.parse(await fsp.readFile(path.join(staging, 'manifest.json'), 'utf8'));
    const databaseFile = path.join(staging, manifest.databaseFile);
    if (manifest.database === 'sqlite') {
      const database = new DatabaseSync(databaseFile, { readOnly: true });
      const result = database.prepare('PRAGMA integrity_check').get();
      database.close();
      if (result.integrity_check !== 'ok') throw new Error(`SQLite integrity check: ${result.integrity_check}`);
    } else {
      await runProcess('pg_restore', ['--list', databaseFile]);
    }
    return { ok: true, manifest };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Restore a verified archive. This is intentionally exposed only as an
 * offline CLI operation: application and worker processes must be stopped
 * before it is invoked.
 */
export async function restoreBackup(archive, { confirmed = false } = {}) {
  if (!confirmed) throw new Error('Restore requires explicit confirmation.');
  await verifyBackup(archive);
  const staging = path.join(config.backupDir, `.restore-${newId()}`);
  await fsp.mkdir(staging, { recursive: true });
  try {
    const target = await materializeArchive(archive, staging);
    await tar.x({ cwd: staging, file: target, strict: true });
    const manifest = JSON.parse(await fsp.readFile(path.join(staging, 'manifest.json'), 'utf8'));
    const databaseFile = path.join(staging, manifest.databaseFile);
    if (manifest.database !== getDb().dialect) {
      throw new Error(
        `Backup database is ${manifest.database}, but the configured database is ${getDb().dialect}.`,
      );
    }

    if (manifest.database === 'sqlite') {
      await getDb().close?.();
      const previous = `${config.sqliteFile}.pre-restore-${Date.now()}`;
      await fsp.rename(config.sqliteFile, previous).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      try {
        await fsp.copyFile(databaseFile, config.sqliteFile);
      } catch (error) {
        await fsp.rename(previous, config.sqliteFile).catch(() => {});
        throw error;
      }
    } else {
      await runProcess('pg_restore', [
        '--dbname',
        config.databaseUrl,
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        databaseFile,
      ]);
    }

    if (manifest.includesLocalUploads) {
      const restoredUploads = path.join(staging, 'uploads');
      const previousUploads = `${config.uploadDir}.pre-restore-${Date.now()}`;
      await fsp.rename(config.uploadDir, previousUploads).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      try {
        await fsp.cp(restoredUploads, config.uploadDir, { recursive: true });
      } catch (error) {
        await fsp.rm(config.uploadDir, { recursive: true, force: true });
        await fsp.rename(previousUploads, config.uploadDir).catch(() => {});
        throw error;
      }
    }
    logger.info('backup restored', { archive: target, database: manifest.database });
    return { ok: true, manifest };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

async function materializeArchive(archive, staging) {
  if (!String(archive).startsWith('s3://')) return path.resolve(archive);
  const target = path.join(staging, 'remote-backup.tar.gz');
  await fsp.writeFile(target, await readBackupArchive(String(archive)), { mode: 0o600 });
  return target;
}

async function enforceLocalRetention() {
  const cutoff = Date.now() - config.backupRetentionDays * 24 * 3600_000;
  const files = await fsp.readdir(config.backupDir, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.tar.gz')) continue;
    const target = path.join(config.backupDir, file.name);
    const stat = await fsp.stat(target);
    if (stat.mtimeMs < cutoff) await fsp.unlink(target);
  }
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errorText = '';
    child.stderr.on('data', (chunk) => {
      errorText += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${errorText.slice(-2000)}`));
    });
  });
}
