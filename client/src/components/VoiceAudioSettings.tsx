import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui';
import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';
import { useVoice } from '../store/voice';
import { useVoicePreferences, setAudioOutput } from '../store/voicePreferences';
import { captureMicrophone, releaseMicrophone } from '../lib/microphone';

export function VoiceAudioSettings({ onClose }: { onClose: () => void }) {
  const { locale } = useI18n(); const fa = locale === 'fa';
  const preferences = useVoicePreferences();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [speakerTesting, setSpeakerTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const test = useRef<{stream?: MediaStream; context?: AudioContext; audio?: HTMLAudioElement; frame?: number; timer?: number}>({});
  const generation = useRef(0);
  const alive = useRef(true);
  function stop() {
    generation.current++;
    const resource = test.current; test.current = {};
    if(resource.frame) cancelAnimationFrame(resource.frame);
    if(resource.timer) clearTimeout(resource.timer);
    resource.audio?.pause(); if(resource.audio) resource.audio.srcObject = null;
    releaseMicrophone(resource.stream ?? null);
    void resource.context?.close();
    if(alive.current) { setTesting(false); setSpeakerTesting(false); setLevel(0); setBusy(false); }
  }
  async function refreshDevices() {
    if (!navigator.mediaDevices) { setError(fa ? 'برای دسترسی به میکروفن، HTTPS یا localhost لازم است.' : 'Microphone access requires HTTPS or localhost.'); return; }
    try { const list = await navigator.mediaDevices.enumerateDevices(); if(alive.current) setDevices(list); }
    catch { if(alive.current) setError('Could not list audio devices.'); }
  }
  useEffect(() => {
    alive.current = true; void refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => { alive.current = false; stop(); navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices); };
  }, []);
  useEffect(() => {
    if(test.current.audio) { test.current.audio.volume = preferences.outputVolume / 100; void setAudioOutput(test.current.audio,preferences.outputDevice).catch(reason => setError(reason.message)); }
  }, [preferences.outputVolume,preferences.outputDevice]);
  async function microphoneTest() {
    if (testing) { stop(); return; }
    stop(); setError(''); setBusy(true); const token = generation.current;
    try {
      const stream = await captureMicrophone();
      if(!alive.current || generation.current !== token) { releaseMicrophone(stream); return; }
      test.current.stream = stream;
      const context = new AudioContext(); test.current.context = context; await context.resume();
      if(generation.current !== token) return;
      const analyser = context.createAnalyser(); analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const audio = new Audio(); test.current.audio = audio; audio.srcObject = stream; audio.volume = preferences.outputVolume / 100;
      await setAudioOutput(audio,preferences.outputDevice); await audio.play();
      if(generation.current !== token) return;
      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => { if(generation.current !== token) return; analyser.getByteTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((sum,value) => sum + ((value - 128) / 128) ** 2,0) / samples.length); setLevel(Math.min(100, rms * 300)); test.current.frame = requestAnimationFrame(tick); };
      tick(); setTesting(true); void refreshDevices();
    } catch(reason) { stop(); if(alive.current) setError(reason instanceof Error ? reason.message : 'Microphone access failed.'); }
    finally { if(alive.current) setBusy(false); }
  }
  async function speakerTest() {
    if(speakerTesting) { stop(); return; }
    stop(); setError(''); const token = generation.current;
    try {
      const context = new AudioContext(); test.current.context = context; await context.resume();
      if(generation.current !== token) return;
      const destination = context.createMediaStreamDestination(), gain = context.createGain(); gain.gain.value = .15; gain.connect(destination);
      for(let i=0; i<3; i++) { const tone = context.createOscillator(); tone.frequency.value = [440,660,880][i]; tone.connect(gain); tone.start(context.currentTime + i*.5); tone.stop(context.currentTime + i*.5 + .35); }
      const audio = new Audio(); test.current.audio = audio; audio.srcObject = destination.stream; audio.volume = preferences.outputVolume / 100;
      await setAudioOutput(audio,preferences.outputDevice); await audio.play();
      if(generation.current !== token) return;
      setSpeakerTesting(true); test.current.timer = window.setTimeout(stop,2000);
    } catch(reason) { stop(); if(alive.current) setError(reason instanceof Error ? reason.message : 'Speaker test failed.'); }
  }
  async function selectInput(id: string) {
    const previous = preferences.inputDevice; stop(); setBusy(true); setError('');
    preferences.update({inputDevice:id});
    try { await useVoice.getState().changeInputDevice(); void refreshDevices(); }
    catch(reason) { preferences.update({inputDevice:previous}); if(alive.current) setError(reason instanceof Error ? reason.message : 'Could not switch microphone.'); }
    finally { if(alive.current) setBusy(false); }
  }
  return <Modal title={fa ? 'صدا و میکروفن' : 'Voice & Audio'} className="voice-audio-settings" onClose={onClose}>
    <div className="audio-device-grid"><label><span><Icon name="microphone" size={18} /> {fa ? 'میکروفن ورودی' : 'INPUT DEVICE'}</span><select disabled={busy || testing} value={preferences.inputDevice} onChange={event => void selectInput(event.target.value)}><option value="">{fa ? 'پیش‌فرض سیستم' : 'System default'}</option>{devices.filter(device => device.kind === 'audioinput' && device.deviceId !== 'default').map((device,index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index+1}`}</option>)}</select></label><label><span><Icon name="headphones" size={18} /> {fa ? 'بلندگوی خروجی' : 'OUTPUT DEVICE'}</span><select value={preferences.outputDevice} onChange={event => preferences.update({outputDevice:event.target.value})}><option value="">{fa ? 'پیش‌فرض سیستم' : 'System default'}</option>{devices.filter(device => device.kind === 'audiooutput' && device.deviceId !== 'default').map((device,index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index+1}`}</option>)}</select></label><label>{fa ? 'قدرت میکروفن' : 'INPUT VOLUME'} <strong>{preferences.inputVolume}%</strong><input type="range" min="0" max="200" value={preferences.inputVolume} onChange={event => preferences.update({inputVolume:Number(event.target.value)})} /></label><label>{fa ? 'صدای بلندگو' : 'OUTPUT VOLUME'} <strong>{preferences.outputVolume}%</strong><input type="range" min="0" max="100" value={preferences.outputVolume} onChange={event => preferences.update({outputVolume:Number(event.target.value)})} /></label></div>
    <div className="audio-test-section"><h4>{fa ? 'تست میکروفن' : 'MIC TEST'}</h4><p>{fa ? 'شروع را بزن و صحبت کن. صدای خودت را از خروجی انتخاب‌شده می‌شنوی؛ این پیش‌نمایش برای اعضای تماس ارسال نمی‌شود.' : 'Click Let’s Check and speak. You will hear yourself through the selected output. This preview is not sent to the call.'}</p><div className="audio-test-row"><button className={`btn ${testing ? 'danger' : 'primary'}`} disabled={busy} onClick={() => void microphoneTest()}>{busy ? '…' : testing ? (fa ? 'توقف تست' : 'Stop testing') : (fa ? 'شروع تست' : 'Let’s Check')}</button><div className="mic-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level)}>{Array.from({length:30},(_,index) => <i key={index} className={level > index * 100/30 ? 'lit' : ''} />)}</div></div></div>
    <div className="audio-test-section"><h4>{fa ? 'تست بلندگو' : 'SPEAKER TEST'}</h4><p>{fa ? 'سه صدای کوتاه از بلندگوی انتخاب‌شده پخش می‌شود.' : 'Play three short tones through your selected speaker.'}</p><button className="btn" disabled={busy} onClick={() => void speakerTest()}><Icon name="speaker" size={18} /> {speakerTesting ? (fa ? 'توقف' : 'Stop tone') : (fa ? 'تست بلندگو' : 'Test speaker')}</button></div>
    {error ? <p className="activity-error" role="alert">{error}</p> : null}
  </Modal>;
}
