const V1_MARKER = new TextEncoder().encode('ZDISENC1');
const V2_MARKER = new TextEncoder().encode('ZDISENC2');
const V2_HEADER_BYTES = 20;
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const GCM_TAG_BYTES = 16;
const MEDIA_CACHE_DB = 'zdis-decrypted-media';
const MEDIA_CACHE_STORE = 'attachments';

interface CachedAttachment {
  id: string;
  blob: Blob;
  cachedAt: number;
}

export type DecryptedAttachmentStage = 'checking' | 'decrypting' | 'saving';

export interface DecryptedAttachmentResult {
  blob: Blob;
  persisted: boolean;
  fromCache: boolean;
}

const decryptionJobs = new Map<string, Promise<DecryptedAttachmentResult>>();

export interface EncryptedFileMetadata {
  name: string;
  mime: string;
  key: string;
  iv: string;
  version?: 1 | 2;
  size?: number;
  chunkSize?: number;
}

function mediaCacheKey(attachmentId: string, metadata: EncryptedFileMetadata) {
  return `${attachmentId}:${metadata.version ?? 1}:${metadata.key}:${metadata.iv}`;
}

function openMediaCache() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Browser storage is unavailable.'));
      return;
    }
    const request = indexedDB.open(MEDIA_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MEDIA_CACHE_STORE)) {
        request.result.createObjectStore(MEDIA_CACHE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open browser media storage.'));
  });
}

async function readCachedAttachment(id: string) {
  let db: IDBDatabase | null = null;
  try {
    db = await openMediaCache();
    return await new Promise<Blob | null>((resolve, reject) => {
      const transaction = db!.transaction(MEDIA_CACHE_STORE, 'readonly');
      const request = transaction.objectStore(MEDIA_CACHE_STORE).get(id);
      request.onsuccess = () => {
        const record = request.result as CachedAttachment | undefined;
        resolve(record?.blob instanceof Blob ? record.blob : null);
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function writeCachedAttachment(id: string, blob: Blob) {
  let db: IDBDatabase | null = null;
  try {
    db = await openMediaCache();
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction(MEDIA_CACHE_STORE, 'readwrite');
      transaction.objectStore(MEDIA_CACHE_STORE).put({ id, blob, cachedAt: Date.now() } satisfies CachedAttachment);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return true;
  } catch {
    // Private browsing and exhausted storage quotas must not prevent playback.
    return false;
  } finally {
    db?.close();
  }
}

function base64url(bytes: ArrayBuffer | Uint8Array) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeBase64url(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function chunkIv(base: Uint8Array, index: number) {
  const iv = base.slice();
  new DataView(iv.buffer, iv.byteOffset, iv.byteLength).setUint32(8, index, false);
  return iv;
}

function v2Header(chunkSize: number, size: number) {
  const header = new Uint8Array(V2_HEADER_BYTES);
  header.set(V2_MARKER);
  const view = new DataView(header.buffer);
  view.setUint32(8, chunkSize, false);
  view.setBigUint64(12, BigInt(size), false);
  return header;
}

function markerEquals(value: Uint8Array, marker: Uint8Array) {
  return marker.every((byte, index) => value[index] === byte);
}

/** Chunked AES-GCM keeps peak memory bounded and gives every chunk a unique IV. */
export async function encryptUploadFile(
  file: File,
  onProgress?: (progress: number) => void,
) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const baseIv = crypto.getRandomValues(new Uint8Array(12));
  // The final four bytes are a counter and must begin at zero.
  baseIv.fill(0, 8);
  const chunkSize = DEFAULT_CHUNK_BYTES;
  const parts: BlobPart[] = [v2Header(chunkSize, file.size)];
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const clear = await file.slice(start, Math.min(file.size, start + chunkSize)).arrayBuffer();
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(baseIv, index) }, key, clear);
    parts.push(encrypted);
    onProgress?.((index + 1) / totalChunks);
  }
  return {
    file: new File(parts, `${file.name}.zdis`, { type: 'application/vnd.zdis.encrypted' }),
    metadata: {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      key: base64url(await crypto.subtle.exportKey('raw', key)),
      iv: base64url(baseIv),
      version: 2 as const,
      size: file.size,
      chunkSize,
    },
  };
}

async function fetchBytes(url: string, start?: number, end?: number, signal?: AbortSignal) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: start === undefined ? undefined : { Range: `bytes=${start}-${end ?? ''}` },
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Decrypts v2 files a chunk at a time. Only legacy v1 files require the old
 * full-buffer fallback because a single GCM authentication tag covers them.
 */
export async function decryptAttachment(
  url: string,
  metadata: EncryptedFileMetadata,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
) {
  const header = await fetchBytes(url, 0, V2_HEADER_BYTES - 1, signal);
  const key = await crypto.subtle.importKey('raw', decodeBase64url(metadata.key), 'AES-GCM', false, ['decrypt']);

  if (markerEquals(header, V2_MARKER)) {
    if (header.byteLength < V2_HEADER_BYTES) throw new Error('Invalid encrypted file header.');
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const chunkSize = view.getUint32(8, false);
    const clearSize = Number(view.getBigUint64(12, false));
    if (!chunkSize || !Number.isSafeInteger(clearSize) || clearSize < 0) throw new Error('Invalid encrypted file metadata.');
    const totalChunks = Math.max(1, Math.ceil(clearSize / chunkSize));
    const baseIv = decodeBase64url(metadata.iv);
    const clearParts: BlobPart[] = [];
    for (let index = 0; index < totalChunks; index += 1) {
      const clearLength = Math.min(chunkSize, clearSize - index * chunkSize);
      const start = V2_HEADER_BYTES + index * (chunkSize + GCM_TAG_BYTES);
      const cipher = await fetchBytes(url, start, start + clearLength + GCM_TAG_BYTES - 1, signal);
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(baseIv, index) }, key, cipher);
      clearParts.push(clear);
      onProgress?.((index + 1) / totalChunks);
    }
    return new Blob(clearParts, { type: metadata.mime });
  }

  if (!markerEquals(header, V1_MARKER)) throw new Error('Invalid encrypted file.');
  const stored = await fetchBytes(url, undefined, undefined, signal);
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64url(metadata.iv) },
    key,
    stored.subarray(V1_MARKER.byteLength),
  );
  onProgress?.(1);
  return new Blob([clear], { type: metadata.mime });
}

/**
 * Restores a decrypted attachment from this browser or decrypts and persists
 * it once. The shared job prevents an optimistic sender row and its realtime
 * replacement from downloading/decrypting the same media twice.
 */
export async function decryptAndCacheAttachment(
  attachmentId: string,
  url: string,
  metadata: EncryptedFileMetadata,
  onState?: (stage: DecryptedAttachmentStage, progress: number) => void,
): Promise<DecryptedAttachmentResult> {
  const id = mediaCacheKey(attachmentId, metadata);
  onState?.('checking', 0);
  const cached = await readCachedAttachment(id);
  if (cached) {
    onState?.('saving', 1);
    return { blob: cached, persisted: true, fromCache: true };
  }

  let job = decryptionJobs.get(id);
  if (!job) {
    job = (async () => {
      onState?.('decrypting', 0);
      const blob = await decryptAttachment(url, metadata, (progress) => onState?.('decrypting', progress));
      onState?.('saving', 1);
      const persisted = await writeCachedAttachment(id, blob);
      return { blob, persisted, fromCache: false };
    })();
    decryptionJobs.set(id, job);
    void job.finally(() => decryptionJobs.delete(id)).catch(() => undefined);
  } else {
    onState?.('decrypting', 0);
  }
  return job;
}
