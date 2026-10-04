import { create } from 'zustand';
import { storageGet, storageSet } from '../lib/storage';
interface Preferences { inputDevice: string; outputDevice: string; inputVolume: number; outputVolume: number; }
const defaults: Preferences = { inputDevice:'', outputDevice:'', inputVolume:100, outputVolume:100 };
let saved: Partial<Preferences> = {};
try { const value = JSON.parse(storageGet('zdis.voice-devices') ?? '{}'); if (value && typeof value === 'object') saved = value; } catch { /* use defaults */ }
export const useVoicePreferences = create<Preferences & { update: (patch: Partial<Preferences>) => void }>((set, get) => ({
  ...defaults,
  inputDevice: typeof saved.inputDevice === 'string' ? saved.inputDevice : '',
  outputDevice: typeof saved.outputDevice === 'string' ? saved.outputDevice : '',
  inputVolume: Number.isFinite(saved.inputVolume) ? Math.max(0, Math.min(200, saved.inputVolume!)) : 100,
  outputVolume: Number.isFinite(saved.outputVolume) ? Math.max(0, Math.min(100, saved.outputVolume!)) : 100,
  update(patch) { set(patch); const { inputDevice, outputDevice, inputVolume, outputVolume } = get(); storageSet('zdis.voice-devices', JSON.stringify({inputDevice,outputDevice,inputVolume,outputVolume})); },
}));

export async function setAudioOutput(element: HTMLMediaElement, deviceId: string) {
  const target = element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (!target.setSinkId) { if (deviceId) throw new Error('This browser uses your Windows default speaker.'); return; }
  await target.setSinkId(deviceId);
}
