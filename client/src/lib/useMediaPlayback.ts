import { useEffect, useState } from 'react';
import { useVoicePreferences, setAudioOutput } from '../store/voicePreferences';
const screenTracks = new WeakSet<MediaStreamTrack>();
interface SfuVideoPlayback {
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element: HTMLMediaElement): HTMLMediaElement;
}
const sfuVideoTracks = new WeakMap<MediaStreamTrack, SfuVideoPlayback>();
export function registerSfuVideo(track: MediaStreamTrack, playback: SfuVideoPlayback) {
  sfuVideoTracks.set(track, playback);
}
export function setScreenTrack(track: MediaStreamTrack, screen: boolean) {
  if (screen) screenTracks.add(track);
  else screenTracks.delete(track);
}

// HTML video plays only one video track. Select the newest live video (screen
// when camera and screen coexist), while keeping all live audio tracks.
export function useMediaPlayback(node: HTMLVideoElement | null, stream: MediaStream | null, volume = 1) {
  const [hasVideo, setHasVideo] = useState(false);
  const outputVolume = useVoicePreferences(state => state.outputVolume);
  const outputDevice = useVoicePreferences(state => state.outputDevice);
  useEffect(() => { if (node) void setAudioOutput(node,outputDevice).catch(() => {}); }, [node,outputDevice]);
  const trackIds = stream?.getTracks().map((track) => track.id).join('|') ?? '';
  useEffect(() => {
    if (!node || !stream) {
      if (node) node.srcObject = null;
      setHasVideo(false);
      return;
    }
    const watched = new Set<MediaStreamTrack>();
    let attached: SfuVideoPlayback | undefined;
    const update = () => {
      for (const track of stream.getTracks()) {
        if (watched.has(track)) continue;
        watched.add(track);
        track.addEventListener('mute', update);
        track.addEventListener('unmute', update);
        track.addEventListener('ended', update);
      }
      // An adaptive SFU track can be muted until its element is attached.
      const videos = stream.getVideoTracks().filter((track) => track.readyState === 'live' && (!track.muted || sfuVideoTracks.has(track)));
      const video = videos.find((track) => screenTracks.has(track)) ?? videos.at(-1);
      const audio = stream.getAudioTracks().filter((track) => track.readyState === 'live');
      const playback = video ? sfuVideoTracks.get(video) : undefined;
      if (attached && attached !== playback) attached.detach(node);
      node.srcObject = new MediaStream([...audio, ...(video ? [video] : [])]);
      playback?.attach(node);
      attached = playback;
      node.volume = Math.min(1, Math.max(0, volume * outputVolume / 100));
      setHasVideo(Boolean(video));
      void node.play().catch(() => undefined);
    };
    update();
    stream.addEventListener('addtrack', update);
    stream.addEventListener('removetrack', update);
    return () => {
      stream.removeEventListener('addtrack', update);
      stream.removeEventListener('removetrack', update);
      for (const track of watched) {
        track.removeEventListener('mute', update);
        track.removeEventListener('unmute', update);
        track.removeEventListener('ended', update);
      }
      attached?.detach(node);
      node.srcObject = null;
    };
  }, [node, stream, volume, outputVolume, trackIds]);
  return hasVideo;
}
