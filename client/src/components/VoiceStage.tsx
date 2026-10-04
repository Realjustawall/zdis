import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from './ui';
import { useVoice } from '../store/voice';
import { useMediaPlayback } from '../lib/useMediaPlayback';
import { useRealtime } from '../store/realtime';
import { useSession } from '../store/session';
import { formatDuration } from '../lib/format';
import { api, ApiError } from '../lib/api';
import { toast } from '../store/toast';
import type { Channel, GroupExpression, PublicUser, VoiceParticipant } from '../types';
import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';
import { VoiceAudioSettings } from './VoiceAudioSettings';
import { VoiceActivities, type VoiceActivity } from './VoiceActivities';

const EMPTY_PARTICIPANTS: VoiceParticipant[] = [];

interface Props {
  channel: Channel;
  members: PublicUser[];
  chatOpen: boolean;
  onToggleChat: () => void;
}

interface CallControl {
  channelStatus: string | null;
  permissions: {
    useSoundboard: boolean;
    useEmbeddedActivities: boolean;
    setVoiceChannelStatus: boolean;
    useVoiceActivity: boolean;
    prioritySpeaker: boolean;
    useExternalSounds: boolean;
  };
  room: {
    hostId: string;
    lobbyEnabled: boolean;
    recordingConsentRequired: boolean;
    status: string;
  };
  lobby: {
    userId: string;
    displayName: string;
    requestedAt: number;
  }[];
  recordings: {
    id: string;
    status: string;
    startedAt: number;
  }[];
  consent: {
    recording: boolean;
    transcript: boolean;
    updatedAt: number | null;
  };
  stage: {
    enabled: boolean;
    members: {
      userId: string;
      role: 'speaker' | 'audience';
      requestedAt: number | null;
      username: string;
      displayName: string;
      avatarUrl: string | null;
    }[];
  };
  activity: VoiceActivity | null;
}

export function VoiceStage({ channel, members, chatOpen, onToggleChat }: Props) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const user = useSession((state) => state.user)!;
  const participants =
    useRealtime((state) => state.voice[channel.id]) ?? EMPTY_PARTICIPANTS;
  const {
    channelId,
    localStream,
    screenStream,
    remoteStreams,
    muted,
    deafened,
    cameraOn,
    screenSharing,
    stageAudience,
    speaking,
    connecting,
    joinedAt,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    toggleScreenShare,
  } = useVoice();

  const inThisChannel = channelId === channel.id;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hideThumbnails, setHideThumbnails] = useState(false);
  useEffect(() => { setFocusedId(null); setHideThumbnails(false); }, [channel.id, inThisChannel]);
  useEffect(() => {
    if (focusedId === `${user.id}:screen`) {
      if (!screenSharing) setFocusedId(null);
    } else if (focusedId && focusedId !== user.id && !participants.some(member => member.userId === focusedId)) setFocusedId(null);
  }, [participants, focusedId, user.id, screenSharing]);
  useEffect(() => { if (screenSharing && inThisChannel) setFocusedId(`${user.id}:screen`); }, [screenSharing, inThisChannel, user.id]);
  useEffect(() => { setOptionsOpen(false); }, [channel.id]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setOptionsOpen(false); };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);
  const [elapsed, setElapsed] = useState(0);
  const [control, setControl] = useState<CallControl | null>(null);
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [sounds, setSounds] = useState<GroupExpression[]>([]);
  const [activity, setActivity] = useState<CallControl['activity']>(null);
  const activityEpoch = useRef(0);
  const currentChannel = useRef(channel.id);
  currentChannel.current = channel.id;
  const [channelStatus, setChannelStatus] = useState(channel.voiceStatus);

  useEffect(() => { if (activity?.state.id && inThisChannel) setActivitiesOpen(true); }, [activity?.state.id, inThisChannel]);
  useEffect(() => { if (!inThisChannel) setActivitiesOpen(false); }, [inThisChannel]);
  function updateActivity(next: VoiceActivity | null) {
    activityEpoch.current++;
    setActivity(current => current && next && current.state.id === next.state.id && current.state.revision > next.state.revision ? current : next);
  }

  async function refreshControl() {
    const requestChannel = channel.id;
    const epoch = activityEpoch.current;
    try {
      const data = await api.get<CallControl>(`/api/voice/${channel.id}`);
      if (currentChannel.current !== requestChannel) return;
      setControl(data);
      if (activityEpoch.current === epoch) updateActivity(data.activity);
      setChannelStatus(data.channelStatus);
      setRecordingConsent(data.consent.recording);
    } catch {
      // Joining still works in peer-to-peer mode when enterprise call control is unavailable.
    }
  }

  useEffect(() => {
    setActivity(null);
    activityEpoch.current++;
    setControl(null);
    setActivitiesOpen(false);
    setAudioSettingsOpen(false);
    void refreshControl();
    const timer = window.setInterval(() => void refreshControl(), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<{ expressions: GroupExpression[] }>(
        `/api/groups/${channel.groupId}/expressions`,
      ),
      api
        .get<{ expressions: GroupExpression[] }>(
          `/api/groups/${channel.groupId}/external-expressions`,
        )
        .catch(() => ({ expressions: [] })),
    ])
      .then(([local, external]) => {
        if (active) {
          setSounds(
            [...local.expressions, ...external.expressions].filter(
              (expression) => expression.type === 'sound',
            ),
          );
        }
      })
      .catch(() => {
        if (active) setSounds([]);
      });
    return () => {
      active = false;
    };
  }, [channel.groupId]);

  useEffect(
    () =>
      useRealtime.getState().on(
        'voice:soundboard',
        ((payload: { channelId: string; attachmentId: string; name: string }) => {
          if (payload.channelId !== channel.id) return;
          const audio = new Audio(`/api/files/${payload.attachmentId}`);
          audio.volume = 0.8;
          void audio.play().catch(() => {});
        }) as never,
      ),
    [channel.id],
  );

  useEffect(
    () =>
      useRealtime.getState().on(
        'voice:status',
        ((payload: { channelId: string; status: string | null }) => {
          if (payload.channelId === channel.id) setChannelStatus(payload.status);
        }) as never,
      ),
    [channel.id],
  );

  useEffect(
    () =>
      useRealtime.getState().on(
        'voice:activity',
        ((payload: { channelId: string; activity: CallControl['activity'] }) => {
          if (payload.channelId === channel.id) updateActivity(payload.activity);
        }) as never,
      ),
    [channel.id],
  );

  useEffect(() => {
    if (!inThisChannel || !joinedAt) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - joinedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [inThisChannel, joinedAt]);

  const byId = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const nameFor = (id: string) => byId.get(id)?.displayName ?? (id === user.id ? user.displayName : 'Someone');

  const stateFor = (id: string): VoiceParticipant | undefined =>
    participants.find((participant) => participant.userId === id);

  const isHost = control?.room.hostId === user.id;
  const activeRecording = control?.recordings.find((recording) =>
    ['recording', 'starting', 'stopping'].includes(recording.status),
  );
  const priorityUserId = participants.find((participant) => participant.priority)?.userId ?? null;
  const ownPriority = stateFor(user.id)?.priority ?? false;

  useEffect(() => {
    const pushToTalk =
      inThisChannel &&
      control &&
      !control.permissions.useVoiceActivity &&
      !stageAudience;
    if (!pushToTalk || !localStream) return;
    const audioTracks = localStream.getAudioTracks();
    audioTracks.forEach((track) => { track.enabled = false; });
    const editableTarget = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    const press = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || editableTarget(event.target)) return;
      event.preventDefault();
      if (!muted) audioTracks.forEach((track) => { track.enabled = true; });
    };
    const release = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      audioTracks.forEach((track) => { track.enabled = false; });
    };
    window.addEventListener('keydown', press);
    window.addEventListener('keyup', release);
    return () => {
      window.removeEventListener('keydown', press);
      window.removeEventListener('keyup', release);
      audioTracks.forEach((track) => { track.enabled = !muted; });
    };
  }, [
    control,
    inThisChannel,
    localStream,
    muted,
    stageAudience,
  ]);

  async function decideLobby(userId: string, approved: boolean) {
    try {
      await api.patch(`/api/voice/${channel.id}/lobby/${userId}`, { approved });
      await refreshControl();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update the lobby request.');
    }
  }

  async function updateSettings(patch: {
    lobbyEnabled?: boolean;
    recordingConsentRequired?: boolean;
  }) {
    try {
      await api.patch(`/api/voice/${channel.id}/settings`, patch);
      await refreshControl();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update call settings.');
    }
  }

  async function setConsent(next: boolean) {
    try {
      await api.put(`/api/voice/${channel.id}/consent`, { recording: next, transcript: next });
      setRecordingConsent(next);
      toast.success(next ? 'Recording consent granted.' : 'Recording consent withdrawn.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update consent.');
    }
  }

  async function toggleRecording() {
    try {
      if (activeRecording) {
        await api.del(`/api/voice/${channel.id}/recordings/${activeRecording.id}`);
      } else {
        await api.post(`/api/voice/${channel.id}/recordings`);
      }
      await refreshControl();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change recording state.');
    }
  }

  async function requestToSpeak(requested: boolean) {
    try {
      await api.post(`/api/voice/${channel.id}/stage/request`, { requested });
      await refreshControl();
      toast.success(requested ? 'Your request was sent to the stage host.' : 'Speaking request cancelled.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update your speaking request.');
    }
  }

  async function setStageRole(userId: string, role: 'speaker' | 'audience') {
    try {
      await api.patch(`/api/voice/${channel.id}/stage/${userId}`, { role });
      await refreshControl();
      toast.success(role === 'speaker' ? 'Speaker invited.' : 'Participant moved to the audience.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update the stage role.');
    }
  }

  const ownStageMember = control?.stage.members.find((member) => member.userId === user.id);
  const requestedSpeakers = control?.stage.members.filter(
    (member) => member.role === 'audience' && member.requestedAt,
  ) ?? [];
  const stageSpeakers = control?.stage.members.filter((member) => member.role === 'speaker') ?? [];

  const callControls = control ? (
    <div
      className="col"
      style={{ gap: 8, padding: '8px 12px', borderTop: '1px solid var(--border)' }}
    >
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          className={`btn small${recordingConsent ? ' primary' : ''}`}
          onClick={() => void setConsent(!recordingConsent)}
        >
          {recordingConsent ? 'Recording consented' : 'Consent to recording'}
        </button>
        {isHost ? (
          <>
            <button
              className={`btn small${control.room.lobbyEnabled ? ' primary' : ''}`}
              onClick={() => void updateSettings({ lobbyEnabled: !control.room.lobbyEnabled })}
            >
              Lobby {control.room.lobbyEnabled ? 'on' : 'off'}
            </button>
            <button
              className={`btn small${control.room.recordingConsentRequired ? ' primary' : ''}`}
              onClick={() =>
                void updateSettings({
                  recordingConsentRequired: !control.room.recordingConsentRequired,
                })
              }
            >
              Require consent
            </button>
            <button
              className={`btn small${activeRecording ? ' danger' : ''}`}
              onClick={() => void toggleRecording()}
            >
              {activeRecording ? 'Stop recording' : 'Start recording'}
            </button>
          </>
        ) : null}
      </div>
      {isHost && control.lobby.length > 0 ? (
        <div className="col" style={{ gap: 6 }}>
          <strong className="small">Waiting room</strong>
          {control.lobby.map((entry) => (
            <div className="row" key={entry.userId} style={{ gap: 8 }}>
              <span>{entry.displayName}</span>
              <span className="spacer" />
              <button className="btn primary small" onClick={() => void decideLobby(entry.userId, true)}>
                Approve
              </button>
              <button className="btn danger small" onClick={() => void decideLobby(entry.userId, false)}>
                Deny
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {control.stage.enabled ? (
        <div className="col" style={{ gap: 7 }}>
          <strong className="small">Stage controls</strong>
          {!isHost && ownStageMember?.role !== 'speaker' ? (
            <button
              className={`btn small${ownStageMember?.requestedAt ? ' danger' : ' primary'}`}
              onClick={() => void requestToSpeak(!ownStageMember?.requestedAt)}
            >
              {ownStageMember?.requestedAt ? 'Cancel speaking request' : '✋ Request to speak'}
            </button>
          ) : null}
          {isHost && requestedSpeakers.length > 0 ? (
            <div className="col" style={{ gap: 6 }}>
              {requestedSpeakers.map((member) => (
                <div className="row" key={member.userId} style={{ gap: 8 }}>
                  <span>{member.displayName} requested to speak</span>
                  <span className="spacer" />
                  <button className="btn primary small" onClick={() => void setStageRole(member.userId, 'speaker')}>
                    Invite
                  </button>
                  <button className="btn small" onClick={() => void setStageRole(member.userId, 'audience')}>
                    Dismiss
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {isHost && stageSpeakers.length > 0 ? (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {stageSpeakers.map((member) => (
                <button className="btn small" key={member.userId} onClick={() => void setStageRole(member.userId, 'audience')}>
                  Move {member.displayName} to audience
                </button>
              ))}
            </div>
          ) : null}
          {stageAudience && ownStageMember?.role === 'speaker' ? (
            <button
              className="btn primary small"
              onClick={() => {
                leave();
                void join(channel.id);
              }}
            >
              Rejoin as speaker
            </button>
          ) : null}
        </div>
      ) : null}
      {inThisChannel && control?.permissions.useSoundboard && sounds.length ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <strong className="small">Soundboard</strong>
          {sounds.filter(
            (sound) => !sound.sourceGroupName || control.permissions.useExternalSounds,
          ).map((sound) => (
            <button
              className="btn small"
              key={sound.id}
              onClick={() => useRealtime.getState().emit('voice:soundboard', { expressionId: sound.id })}
            >
              🔊 {sound.name}{sound.sourceGroupName ? ` · ${sound.sourceGroupName}` : ''}
            </button>
          ))}
        </div>
      ) : null}
      {inThisChannel && control?.permissions.setVoiceChannelStatus ? (
        <button
          className="btn small"
          onClick={async () => {
            const next = window.prompt('Voice channel status (leave blank to clear):', channelStatus ?? '');
            if (next === null) return;
            try {
              const data = await api.patch<{ status: string | null }>(
                `/api/voice/${channel.id}/status`,
                { status: next.trim() || null },
              );
              setChannelStatus(data.status);
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not update voice status.');
            }
          }}
        >
          ✏️ {channelStatus ? 'Edit status' : 'Set status'}
        </button>
      ) : null}
    </div>
  ) : null;

  const tools = <div className="voice-toolbar-actions">
    <button className="head-btn" onClick={() => setAudioSettingsOpen(true)} title="Voice & Audio" aria-label="Voice & Audio"><Icon name="headphones" size={20} /></button>
    {inThisChannel ? <button className="head-btn" onClick={() => { setFocusedId(value => value ? null : (participants.find(member => member.screen)?.userId ?? user.id)); setHideThumbnails(false); }} aria-label={focusedId ? 'Grid view' : 'Focus view'} title={focusedId ? 'Grid view' : 'Focus view'}><Icon name={focusedId ? 'grid' : 'focus'} size={20} /></button> : null}
    {focusedId ? <button className="head-btn" onClick={() => setHideThumbnails(value => !value)} aria-label={hideThumbnails ? 'Show participants' : 'Hide participants'} title={hideThumbnails ? 'Show participants' : 'Hide participants'} aria-pressed={hideThumbnails}><Icon name="users" size={20} /></button> : null}
    <button className={`head-btn${chatOpen ? ' on' : ''}`} onClick={onToggleChat} title="Channel chat" aria-label="Channel chat" aria-pressed={chatOpen}><Icon name="message" size={21} /></button>
    <button className={`head-btn${optionsOpen ? ' on' : ''}`} onClick={() => setOptionsOpen(value => !value)} title="Call options" aria-label="Call options" aria-expanded={optionsOpen}><Icon name="settings" size={21} /></button>
  </div>;
  const options = optionsOpen ? <div className="voice-options"><div className="voice-options-heading"><strong>Call options</strong><button className="head-btn" onClick={() => setOptionsOpen(false)} aria-label="Close call options"><Icon name="close" size={18} /></button></div>{callControls || <p className="faint">Join the channel to access call options.</p>}        {control?.permissions.prioritySpeaker ? (
          <button
            className={`voice-btn${ownPriority ? ' active' : ''}`}
            onClick={() =>
              useRealtime.getState().emit('voice:priority', { active: !ownPriority })
            }
            title="Priority Speaker"
          >
            <Icon name="announcement" size={19} />
          </button>
        ) : null}
</div> : null;

  if (!inThisChannel) {
    return (
      <div className="voice-stage">
        <div className="voice-head">
          <span className="voice-channel-title">
            <Icon name={channel.type === 'stage' ? 'microphone' : 'speaker'} size={17} /> {channel.name}
            {channelStatus ? <small className="faint"> · {channelStatus}</small> : null}
          </span>
          <span className="spacer" />
          <span className="faint small">
            {participants.length === 0
              ? 'Nobody is here yet'
              : `${participants.length} connected`}
          </span>
          {tools}
        </div>

        {participants.length > 0 ? (
          <div className="voice-grid" style={{ minHeight: 0 }}>
            {participants.map((participant) => (
              <div className="voice-tile" key={participant.userId} style={{ aspectRatio: '16 / 7' }}>
                <Avatar name={nameFor(participant.userId)} id={participant.userId} src={byId.get(participant.userId)?.avatarUrl} size={48} />
                <div className="tile-label">{nameFor(participant.userId)}</div>
                <div className="tile-flags">
                  {participant.muted ? <span title="Muted"><Icon name="volumeOff" size={14} /></span> : null}
                  {participant.video ? <span title="Camera on"><Icon name="video" size={14} /></span> : null}
                  {participant.screen ? <span title="Sharing screen"><Icon name="screen" size={14} /></span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : <div className="voice-lobby"><div className="voice-lobby-icon"><Icon name="speaker" size={48} /></div><h2>{channel.name}</h2><p>{fa ? 'هنوز کسی اینجا نیست. وارد شو و گفتگو را شروع کن.' : 'No one is here yet. Grab a seat and start the conversation.'}</p><span className="voice-lobby-hint"><Icon name="headphones" size={16} /> {fa ? 'کانال صوتی آماده است' : 'Your voice channel is ready'}</span></div>}

        <div className="voice-controls voice-join-controls">
          <button className="btn primary" onClick={() => void join(channel.id)} disabled={connecting}>
            {connecting ? <span className="spinner tiny" /> : <Icon name={channel.type === 'stage' ? 'headphones' : 'microphone'} size={17} />}
            {connecting ? (fa ? 'در حال اتصال…' : 'Connecting…') : channel.type === 'stage' ? (fa ? 'پیوستن به شنوندگان' : 'Join audience') : (fa ? 'ورود به ویس' : 'Join voice')}
          </button>
          {channel.type !== 'stage' ? (
            <button className="btn" onClick={() => void join(channel.id, { withVideo: true })} disabled={connecting}>
              <Icon name="video" size={17} /> {fa ? 'ورود با دوربین' : 'Join with camera'}
            </button>
          ) : null}
        </div>
        {options}
        {audioSettingsOpen ? <VoiceAudioSettings onClose={() => setAudioSettingsOpen(false)} /> : null}
      </div>
    );
  }

  const others = participants.filter((participant) => participant.userId !== user.id);

  return (
    <div className="voice-stage">
      <div className="voice-head">
        <span className="live">
          <span className="dot" />
          Live
        </span>
        <span className="voice-channel-title">
          <Icon name={channel.type === 'stage' ? 'microphone' : 'speaker'} size={17} /> {channel.name}
          {channelStatus ? <small className="faint"> · {channelStatus}</small> : null}
        </span>
        <span className="faint">·</span>
        <span className="faint">{formatDuration(elapsed)}</span>
        <span className="spacer" />
        <button className="head-btn" aria-label="Full screen call" title="Full screen call" onClick={(event) => {
          const stage = event.currentTarget.closest('.voice-stage');
          if (document.fullscreenElement) void document.exitFullscreen();
          else if (stage instanceof HTMLElement) void stage.requestFullscreen().catch(() => toast.error('Full screen is unavailable.'));
        }}>
          <Icon name="screen" size={19} />
        </button>
        {tools}
      </div>

      <div className={`voice-grid${activitiesOpen ? ' activity-behind' : ''}${focusedId ? ' focus-view' : ''}${hideThumbnails && focusedId ? ' hide-thumbnails' : ''}`}>
        <VoiceTile
          name={`${user.displayName} (you)`}
          userId={user.id}
          avatarUrl={user.avatarUrl}
          focused={focusedId === user.id}
          onFocus={() => setFocusedId(value => value === user.id ? null : user.id)}
          stream={localStream}
          muted={true}
          mirrored={cameraOn}
          speaking={Boolean(speaking[user.id])}
          volume={1}
          flags={{ muted, deafened, video: cameraOn, screen: false }}
        />
        {screenSharing ? <VoiceTile name={fa ? 'صفحهٔ شما' : 'Your screen'} userId={user.id} avatarUrl={user.avatarUrl} stream={screenStream} muted={true} speaking={false} focused={focusedId === `${user.id}:screen`} onFocus={() => setFocusedId(value => value === `${user.id}:screen` ? null : `${user.id}:screen`)} flags={{ screen: true }} /> : null}
        {others.map((participant) => (
          <VoiceTile
            key={participant.userId}
            name={nameFor(participant.userId)}
            userId={participant.userId}
            avatarUrl={byId.get(participant.userId)?.avatarUrl}
            focused={focusedId === participant.userId}
            onFocus={() => setFocusedId(value => value === participant.userId ? null : participant.userId)}
            stream={remoteStreams[participant.userId] ?? null}
            muted={deafened}
            speaking={Boolean(stateFor(participant.userId)?.speaking)}
            volume={
              priorityUserId && priorityUserId !== participant.userId ? 0.25 : 1
            }
            flags={{
              muted: participant.muted,
              deafened: participant.deafened,
              video: participant.video,
              screen: participant.screen,
            }}
          />
        ))}
      </div>

      {activitiesOpen ? <VoiceActivities activity={activity} members={members} canStart={Boolean(control?.permissions.useEmbeddedActivities)} isHost={isHost} onChange={next => { if (currentChannel.current === channel.id) updateActivity(next); }} onClose={() => setActivitiesOpen(false)} /> : null}
      <div className="voice-controls" role="group" aria-label="Call controls">
        {control && !control.permissions.useVoiceActivity && !stageAudience ? (
          <span className="badge" title="Hold Space to speak">Push to Talk · Space</span>
        ) : null}
        <button
          className={`voice-btn${muted ? ' off' : ''}`}
          onClick={toggleMute}
          disabled={stageAudience}
          title={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
        >
          <Icon name={muted ? 'microphoneOff' : 'microphone'} size={19} />
        </button>
        <button
          className={`voice-btn${deafened ? ' off' : ''}`}
          onClick={toggleDeafen}
          title={deafened ? 'Undeafen' : 'Deafen'}
          aria-pressed={deafened}
        >
          <Icon name={deafened ? 'headphonesOff' : 'headphones'} size={19} />
        </button>
        <button
          className={`voice-btn${cameraOn ? ' on' : ''}`}
          onClick={() => void toggleCamera()}
          disabled={stageAudience}
          title={cameraOn ? 'Turn camera off' : 'Turn camera on'}
          aria-pressed={cameraOn}
        >
          <Icon name={cameraOn ? 'video' : 'videoOff'} size={19} />
        </button>
        <button
          className={`voice-btn${screenSharing ? ' on' : ''}`}
          onClick={() => void toggleScreenShare()}
          disabled={stageAudience}
          title={screenSharing ? 'Stop sharing' : 'Share your screen'}
          aria-pressed={screenSharing}
        >
          <Icon name="screen" size={19} />
        </button>
        <button className={`voice-btn${activitiesOpen ? ' on' : ''}`} onClick={() => setActivitiesOpen(value => !value)} title="Activities" aria-label="Activities" aria-pressed={activitiesOpen}><Icon name="activity" size={21} /></button>
        <button className="voice-btn leave" onClick={leave} title="Disconnect" aria-label="Disconnect">
          <Icon name="phoneOff" size={22} /><span className="voice-leave-label">Disconnect</span>
        </button>
      </div>
      {options}
      {audioSettingsOpen ? <VoiceAudioSettings onClose={() => setAudioSettingsOpen(false)} /> : null}
    </div>
  );
}

function VoiceTile({
  name,
  userId,
  stream,
  muted,
  mirrored,
  speaking,
  volume = 1,
  flags,
  avatarUrl,
  focused,
  onFocus,
}: {
  name: string;
  userId: string;
  stream: MediaStream | null;
  muted: boolean;
  mirrored?: boolean;
  speaking: boolean;
  volume?: number;
  flags: { muted?: boolean; deafened?: boolean; video?: boolean; screen?: boolean };
  avatarUrl?: string | null;
  focused: boolean;
  onFocus: () => void;
}) {
  const [videoNode, setVideoNode] = useState<HTMLVideoElement | null>(null);
  const hasVideo = useMediaPlayback(videoNode, stream, volume);

  return (
    <div className={`voice-tile${speaking ? ' speaking' : ''}${flags.screen ? ' screen-share' : ''}${focused ? ' focused' : ''}`}>
      <button className="tile-focus" onClick={onFocus} aria-label={`${focused ? 'Unfocus' : 'Focus'} ${name}`} aria-pressed={focused} title={focused ? 'Return to grid' : 'Focus this participant'} />
      <video
        ref={setVideoNode}
        autoPlay
        playsInline
        muted={muted}
        className={mirrored ? 'mirrored' : undefined}
        style={{ display: hasVideo ? 'block' : 'none' }}
      />
      {!hasVideo ? <Avatar name={name.replace(/\s\(you\)$/, '')} id={userId} src={avatarUrl} size={64} /> : null}
      <div className="tile-label">
        {flags.muted ? <Icon name="microphoneOff" size={15} /> : null}
        {name}
      </div>
      <div className="tile-flags">
        {flags.deafened ? <span title="Deafened"><Icon name="headphones" size={13} /></span> : null}
        {flags.screen ? <span title="Sharing screen"><Icon name="screen" size={13} /></span> : null}
        {hasVideo ? (
          <button
            className="tile-fullscreen"
            title="Full screen"
            onClick={() => void videoNode?.requestFullscreen().catch(() => undefined)}
          >
<Icon name="screen" size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
