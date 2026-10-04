import { useVoicePreferences } from '../store/voicePreferences';
const captures = new Map<string, { raw: MediaStream; context: AudioContext; gain: GainNode }>();
useVoicePreferences.subscribe(settings => {
  for (const capture of captures.values()) capture.gain.gain.setTargetAtTime(settings.inputVolume / 100, capture.context.currentTime, .02);
});

export async function captureMicrophone(withVideo = false) {
  const settings = useVoicePreferences.getState();
  const raw = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: settings.inputDevice ? { exact: settings.inputDevice } : undefined, echoCancellation:true,noiseSuppression:true,autoGainControl:true },
    video: withVideo ? { width:{ideal:1280},height:{ideal:720} } : false,
  });
  let context: AudioContext | undefined;
  try {
    context = new AudioContext(); await context.resume();
    const gain = context.createGain(); gain.gain.value = settings.inputVolume / 100;
    const destination = context.createMediaStreamDestination();
    context.createMediaStreamSource(raw).connect(gain).connect(destination);
    const audio = destination.stream.getAudioTracks()[0];
    captures.set(audio.id, {raw,context,gain});
    for (const track of raw.getAudioTracks()) track.addEventListener('ended', () => { releaseMicrophone(new MediaStream([audio])); });
    return new MediaStream([audio, ...raw.getVideoTracks()]);
  } catch (error) {
    raw.getTracks().forEach(track => track.stop());
    void context?.close(); throw error;
  }
}

export function releaseMicrophone(stream: MediaStream | null) {
  for (const track of stream?.getAudioTracks() ?? []) {
    const capture = captures.get(track.id);
    captures.delete(track.id); track.stop();
    capture?.raw.getAudioTracks().forEach(source => source.stop());
    void capture?.context.close();
  }
}
