import { config } from '../config.js';
import { AppError, badRequest } from '../lib/errors.js';

const API_BASE = 'https://api.fish.audio';
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export function fishAudioStatus() {
  return {
    configured: Boolean(config.fishAudio.apiKey && config.fishAudio.referenceId),
    keyConfigured: Boolean(config.fishAudio.apiKey),
    model: config.fishAudio.model,
    referenceId: config.fishAudio.referenceId,
  };
}

async function fishRequest(path, options = {}) {
  if (!config.fishAudio.apiKey) throw badRequest('Fish Audio API key is not configured.');
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.fishAudio.apiKey}`,
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
  } catch (error) {
    throw new AppError(502, 'fish_audio_unavailable', `Fish Audio could not be reached: ${error.message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let message = `Fish Audio rejected the request (${response.status}).`;
    try { message = JSON.parse(body)?.message || message; } catch { /* non-JSON error */ }
    throw new AppError(response.status === 401 ? 422 : 502, 'fish_audio_error', message);
  }
  return response;
}

export async function listFishAudioModels() {
  const response = await fishRequest('/model?page_size=100&page_number=1&self=true&sort_by=created_at', { method: 'GET', timeoutMs: 20_000 });
  const body = await response.json();
  return (body.items ?? [])
    .filter((item) => item.type === 'tts')
    .map((item) => ({ id: item._id, title: item.title, languages: item.languages ?? [], visibility: item.visibility }))
    .slice(0, 100);
}

export async function synthesizeFishAudio(text) {
  const clean = String(text ?? '').trim();
  if (!clean || clean.length > 2_000) throw badRequest('TTS text must be between 1 and 2,000 characters.');
  if (!fishAudioStatus().configured) throw badRequest('Fish Audio TTS is not fully configured.');
  const response = await fishRequest('/v1/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', model: config.fishAudio.model },
    body: JSON.stringify({
      text: clean,
      reference_id: config.fishAudio.referenceId,
      format: 'mp3',
      sample_rate: 44100,
      mp3_bitrate: 128,
      normalize: true,
      latency: 'normal',
    }),
  });
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_AUDIO_BYTES) throw new AppError(502, 'fish_audio_response_too_large', 'Fish Audio returned an unexpectedly large file.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new AppError(502, 'fish_audio_invalid_response', 'Fish Audio returned invalid audio.');
  return bytes;
}

