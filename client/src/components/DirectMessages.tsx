import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useChat } from '../store/chat';
import { useRealtime } from '../store/realtime';
import { useSession } from '../store/session';
import { toast } from '../store/toast';
import { useVoice } from '../store/voice';
import type { Conversation, Friendship, PublicUser } from '../types';
import { Icon } from './Icon';
import { Avatar, Confirm, Modal } from './ui';

const callRoomId = (conversationId: string) => `dm:${conversationId}`;

interface ConversationPreference {
  targetType: 'conversation';
  targetId: string;
  level: 'all' | 'mentions' | 'none';
  email: boolean;
  push: boolean;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}

export function DirectMessageActions({ conversation }: { conversation: Conversation }) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const me = useSession((state) => state.user)!;
  const callsEnabled = useSession((state) => state.settings?.feature_voice_calls ?? false);
  const activeRoom = useVoice((state) => state.channelId);
  const connecting = useVoice((state) => state.connecting);
  const cameraOn = useVoice((state) => state.cameraOn);
  const join = useVoice((state) => state.join);
  const leave = useVoice((state) => state.leave);
  const toggleCamera = useVoice((state) => state.toggleCamera);
  const socket = useRealtime((state) => state.socket);
  const on = useRealtime((state) => state.on);
  const loadInitial = useChat((state) => state.loadInitial);
  const removeConversation = useChat((state) => state.removeConversation);
  const setTarget = useChat((state) => state.setTarget);

  const other = conversation.type === 'dm'
    ? conversation.members.find((member) => member.id !== me.id) ?? null
    : null;
  const roomId = callRoomId(conversation.id);
  const [friendship, setFriendship] = useState<Friendship | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preference, setPreference] = useState<ConversationPreference>({
    targetType: 'conversation',
    targetId: conversation.id,
    level: 'all',
    email: true,
    push: true,
  });
  const [blocked, setBlocked] = useState(false);
  const [name, setName] = useState(conversation.name ?? '');
  const [busy, setBusy] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);

  async function refreshRelationship() {
    if (!other) return;
    const [friends, blocks] = await Promise.all([
      api.get<{ friendships: Friendship[] }>('/api/network/friends'),
      api.get<{ blocked: PublicUser[] }>('/api/users/me/blocks'),
    ]);
    setFriendship(friends.friendships.find((item) => item.user.id === other.id) ?? null);
    setBlocked(blocks.blocked.some((person) => person.id === other.id));
  }

  useEffect(() => {
    void refreshRelationship().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [other?.id]);

  useEffect(() => {
    if (!socket || !other) return;
    return on('network:updated', (() => {
      void refreshRelationship().catch(() => undefined);
    }) as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, other?.id]);

  useEffect(() => {
    if (!settingsOpen) return;
    setName(conversation.name ?? '');
    void api
      .get<{ preference: ConversationPreference | null }>(
        `/api/notifications/channels/conversation/${conversation.id}`,
      )
      .then((result) => {
        if (result.preference) setPreference(result.preference);
      })
      .catch(() => toast.error(fa ? 'تنظیمات اعلان بارگذاری نشد.' : 'Could not load notification settings.'));
    void refreshRelationship().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, conversation.id]);

  async function startCall(withVideo: boolean) {
    if (!callsEnabled) {
      toast.info(fa ? 'تماس‌ها توسط مدیر غیرفعال شده‌اند.' : 'Calls are disabled by the administrator.');
      return;
    }
    if (activeRoom === roomId) {
      if (withVideo && !cameraOn) await toggleCamera();
      return;
    }
    await join(roomId, { withVideo });
  }

  async function friendAction() {
    if (!other || busy) return;
    setBusy(true);
    try {
      if (friendship?.status === 'pending' && friendship.direction === 'incoming') {
        await api.patch(`/api/network/friends/${friendship.id}`, { status: 'accepted' });
        toast.success(fa ? 'درخواست دوستی پذیرفته شد.' : 'Friend request accepted.');
      } else if (!friendship || friendship.status === 'rejected') {
        await api.post(`/api/network/friends/${other.id}`);
        toast.success(fa ? 'درخواست دوستی ارسال شد.' : 'Friend request sent.');
      }
      await refreshRelationship();
    } catch (error) {
      toast.error(errorMessage(error, fa ? 'این عملیات انجام نشد.' : 'That action failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function removeFriend() {
    if (!friendship) return;
    setBusy(true);
    try {
      await api.del(`/api/network/friends/${friendship.id}`);
      setFriendship(null);
      toast.success(
        friendship.status === 'accepted'
          ? (fa ? 'دوست حذف شد.' : 'Friend removed.')
          : (fa ? 'درخواست لغو شد.' : 'Friend request cancelled.'),
      );
    } catch (error) {
      toast.error(errorMessage(error, fa ? 'تغییر دوستی انجام نشد.' : 'Could not update friendship.'));
    } finally {
      setBusy(false);
    }
  }

  async function savePreference(next: Partial<ConversationPreference>) {
    const updated = { ...preference, ...next };
    setPreference(updated);
    try {
      const result = await api.put<{ preference: ConversationPreference }>(
        `/api/notifications/channels/conversation/${conversation.id}`,
        { level: updated.level, email: updated.email, push: updated.push },
      );
      setPreference(result.preference);
    } catch (error) {
      toast.error(errorMessage(error, fa ? 'تنظیم اعلان ذخیره نشد.' : 'Could not save notification settings.'));
    }
  }

  async function saveName() {
    if (conversation.type !== 'group_dm') return;
    setBusy(true);
    try {
      await api.patch(`/api/conversations/${conversation.id}`, { name: name.trim() || null });
      await loadInitial();
      toast.success(fa ? 'نام گروه خصوصی ذخیره شد.' : 'Group DM name saved.');
    } catch (error) {
      toast.error(errorMessage(error, fa ? 'نام ذخیره نشد.' : 'Could not save the name.'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleBlock() {
    if (!other) return;
    setBusy(true);
    try {
      if (blocked) await api.del(`/api/users/${other.id}/block`);
      else {
        await api.post(`/api/users/${other.id}/block`);
        if (activeRoom === roomId) leave();
      }
      setBlocked(!blocked);
      toast.success(
        blocked
          ? (fa ? 'مسدودیت برداشته شد.' : 'User unblocked.')
          : (fa ? 'کاربر مسدود شد.' : 'User blocked.'),
      );
    } catch (error) {
      toast.error(errorMessage(error, fa ? 'تنظیم مسدودیت انجام نشد.' : 'Could not change block status.'));
    } finally {
      setBusy(false);
    }
  }

  async function closeConversation() {
    setBusy(true);
    try {
      if (activeRoom === roomId) leave();
      await api.del(`/api/conversations/${conversation.id}`);
      removeConversation(conversation.id);
      setTarget(null);
      setCloseConfirm(false);
      setSettingsOpen(false);
      toast.success(
        conversation.type === 'group_dm'
          ? (fa ? 'از گروه خصوصی خارج شدید.' : 'You left the group DM.')
          : (fa ? 'گفتگو بسته شد.' : 'Conversation closed.'),
      );
    } catch (error) {
      toast.error(errorMessage(error, fa ? 'بستن گفتگو انجام نشد.' : 'Could not close the conversation.'));
    } finally {
      setBusy(false);
    }
  }

  const friendshipTitle =
    friendship?.status === 'accepted'
      ? (fa ? 'دوست شما' : 'Friends')
      : friendship?.status === 'pending' && friendship.direction === 'incoming'
        ? (fa ? 'پذیرفتن درخواست دوستی' : 'Accept friend request')
        : friendship?.status === 'pending'
          ? (fa ? 'درخواست دوستی ارسال شده' : 'Friend request pending')
          : (fa ? 'ارسال درخواست دوستی' : 'Add friend');
  const friendshipActionable =
    Boolean(other) &&
    (!friendship ||
      friendship.status === 'rejected' ||
      (friendship.status === 'pending' && friendship.direction === 'incoming'));

  return (
    <>
      {callsEnabled ? (
        <>
          <button
            className={`head-btn dm-primary-action${activeRoom === roomId ? ' on' : ''}`}
            onClick={() => void startCall(false)}
            disabled={connecting}
            title={fa ? 'شروع تماس صوتی' : 'Start voice call'}
            aria-label={fa ? 'شروع تماس صوتی' : 'Start voice call'}
          >
            <Icon name="microphone" size={18} />
          </button>
          <button
            className={`head-btn dm-primary-action${activeRoom === roomId && cameraOn ? ' on' : ''}`}
            onClick={() => void startCall(true)}
            disabled={connecting}
            title={fa ? 'شروع تماس تصویری' : 'Start video call'}
            aria-label={fa ? 'شروع تماس تصویری' : 'Start video call'}
          >
            <Icon name="video" size={19} />
          </button>
        </>
      ) : null}
      {other ? (
        <button
          className={`head-btn dm-primary-action${friendship?.status === 'accepted' ? ' on' : ''}${friendship?.status === 'pending' && friendship.direction === 'incoming' ? ' attention' : ''}`}
          onClick={() => void friendAction()}
          disabled={busy || !friendshipActionable}
          title={friendshipTitle}
          aria-label={friendshipTitle}
        >
          <Icon name={friendship?.status === 'accepted' ? 'check' : 'users'} size={18} />
        </button>
      ) : null}
      <button
        className={`head-btn dm-primary-action${settingsOpen ? ' on' : ''}`}
        onClick={() => setSettingsOpen(true)}
        title={fa ? 'تنظیمات گفتگو' : 'Conversation settings'}
        aria-label={fa ? 'تنظیمات گفتگو' : 'Conversation settings'}
      >
        <Icon name="settings" size={18} />
      </button>

      {settingsOpen ? (
        <Modal
          title={fa ? 'تنظیمات گفتگو' : 'Conversation settings'}
          description={
            fa
              ? 'اعلان‌ها، دوستی، حریم خصوصی و اعضای این گفتگو را مدیریت کنید.'
              : 'Manage notifications, friendship, privacy, and this conversation.'
          }
          onClose={() => setSettingsOpen(false)}
          className="dm-settings-modal"
        >
          <div className="dm-settings-profile">
            <Avatar
              name={other?.displayName ?? conversation.name ?? (fa ? 'گروه خصوصی' : 'Group DM')}
              id={other?.id ?? conversation.id}
              src={other?.avatarUrl ?? conversation.iconUrl}
              color={other?.bannerColor}
              presence={other?.presence}
              size={54}
            />
            <div>
              <strong>{other?.displayName ?? conversation.name ?? (fa ? 'گروه خصوصی' : 'Group DM')}</strong>
              <span>
                {other
                  ? `@${other.username}`
                  : (fa ? `${conversation.members.length} عضو` : `${conversation.members.length} members`)}
              </span>
            </div>
          </div>

          {conversation.type === 'group_dm' && conversation.ownerId === me.id ? (
            <section className="dm-settings-section">
              <h4>{fa ? 'نام گروه خصوصی' : 'Group DM name'}</h4>
              <div className="row">
                <input
                  className="input"
                  value={name}
                  maxLength={48}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={fa ? 'نام گروه خصوصی' : 'Group DM name'}
                />
                <button className="btn primary" onClick={() => void saveName()} disabled={busy}>
                  {fa ? 'ذخیره' : 'Save'}
                </button>
              </div>
            </section>
          ) : null}

          <section className="dm-settings-section">
            <h4>{fa ? 'اعلان‌ها' : 'Notifications'}</h4>
            <label className="dm-setting-row">
              <span>
                <strong>{fa ? 'سطح اعلان' : 'Notification level'}</strong>
                <small>{fa ? 'اعلان‌های مخصوص این گفتگو را انتخاب کنید.' : 'Choose what alerts you receive from this conversation.'}</small>
              </span>
              <select
                className="select"
                value={preference.level}
                onChange={(event) =>
                  void savePreference({ level: event.target.value as ConversationPreference['level'] })
                }
              >
                <option value="all">{fa ? 'همه پیام‌ها' : 'All messages'}</option>
                <option value="mentions">{fa ? 'فقط اشاره‌ها' : 'Mentions only'}</option>
                <option value="none">{fa ? 'هیچ‌کدام' : 'Nothing'}</option>
              </select>
            </label>
            <label className="dm-setting-row">
              <span>
                <strong>{fa ? 'اعلان پوش' : 'Push notifications'}</strong>
                <small>{fa ? 'اعلان را به مرورگر یا برنامه نصب‌شده بفرست.' : 'Send alerts to your browser or installed app.'}</small>
              </span>
              <input
                type="checkbox"
                checked={preference.push}
                onChange={(event) => void savePreference({ push: event.target.checked })}
              />
            </label>
            <label className="dm-setting-row">
              <span>
                <strong>{fa ? 'اعلان ایمیلی' : 'Email notifications'}</strong>
                <small>{fa ? 'برای این گفتگو ایمیل ارسال شود.' : 'Allow email delivery for this conversation.'}</small>
              </span>
              <input
                type="checkbox"
                checked={preference.email}
                onChange={(event) => void savePreference({ email: event.target.checked })}
              />
            </label>
          </section>

          {other ? (
            <section className="dm-settings-section">
              <h4>{fa ? 'دوستی و حریم خصوصی' : 'Friendship & privacy'}</h4>
              <div className="dm-settings-actions">
                {friendshipActionable ? (
                  <button className="btn primary" onClick={() => void friendAction()} disabled={busy}>
                    {friendship?.direction === 'incoming'
                      ? (fa ? 'پذیرفتن درخواست' : 'Accept request')
                      : (fa ? 'افزودن دوست' : 'Add friend')}
                  </button>
                ) : null}
                {friendship && friendship.status !== 'rejected' ? (
                  <button className="btn" onClick={() => void removeFriend()} disabled={busy}>
                    {friendship.status === 'accepted'
                      ? (fa ? 'حذف دوست' : 'Remove friend')
                      : (fa ? 'لغو درخواست' : 'Cancel request')}
                  </button>
                ) : null}
                <button
                  className={`btn${blocked ? '' : ' danger'}`}
                  onClick={() => void toggleBlock()}
                  disabled={busy}
                >
                  {blocked ? (fa ? 'رفع مسدودیت' : 'Unblock') : (fa ? 'مسدود کردن' : 'Block')}
                </button>
              </div>
            </section>
          ) : null}

          <section className="dm-settings-section danger-zone">
            <h4>{fa ? 'مدیریت گفتگو' : 'Conversation management'}</h4>
            <p>
              {conversation.type === 'group_dm'
                ? (fa ? 'از این گروه خصوصی خارج شوید.' : 'Leave this group DM.')
                : (fa ? 'این گفتگو را از فهرست پیام‌های خصوصی پنهان کنید.' : 'Hide this conversation from your direct messages.')}
            </p>
            <button className="btn danger" onClick={() => setCloseConfirm(true)}>
              {conversation.type === 'group_dm'
                ? (fa ? 'خروج از گروه خصوصی' : 'Leave group DM')
                : (fa ? 'بستن گفتگو' : 'Close conversation')}
            </button>
          </section>
        </Modal>
      ) : null}

      {closeConfirm ? (
        <Confirm
          title={conversation.type === 'group_dm' ? (fa ? 'خروج از گروه خصوصی؟' : 'Leave group DM?') : (fa ? 'بستن گفتگو؟' : 'Close conversation?')}
          message={
            conversation.type === 'group_dm'
              ? (fa ? 'برای بازگشت باید دوباره دعوت شوید.' : 'You will need another invitation to return.')
              : (fa ? 'تاریخچه حذف نمی‌شود و با ارسال پیام دوباره باز خواهد شد.' : 'History is kept and the DM can be reopened later.')
          }
          confirmLabel={conversation.type === 'group_dm' ? (fa ? 'خروج' : 'Leave') : (fa ? 'بستن' : 'Close')}
          danger
          busy={busy}
          onCancel={() => setCloseConfirm(false)}
          onConfirm={() => void closeConversation()}
        />
      ) : null}
    </>
  );
}

interface IncomingCall {
  channelId: string;
  conversationId: string;
  fromUserId: string;
  video: boolean;
  startedAt: number;
}

export function DirectCallLayer({
  conversations,
  onOpenConversation,
}: {
  conversations: Conversation[];
  onOpenConversation: (conversation: Conversation) => void;
}) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const me = useSession((state) => state.user)!;
  const callsEnabled = useSession((state) => state.settings?.feature_voice_calls ?? false);
  const socket = useRealtime((state) => state.socket);
  const on = useRealtime((state) => state.on);
  const emit = useRealtime((state) => state.emit);
  const channelId = useVoice((state) => state.channelId);
  const connecting = useVoice((state) => state.connecting);
  const localStream = useVoice((state) => state.localStream);
  const remoteStreams = useVoice((state) => state.remoteStreams);
  const muted = useVoice((state) => state.muted);
  const deafened = useVoice((state) => state.deafened);
  const cameraOn = useVoice((state) => state.cameraOn);
  const screenSharing = useVoice((state) => state.screenSharing);
  const joinedAt = useVoice((state) => state.joinedAt);
  const join = useVoice((state) => state.join);
  const leave = useVoice((state) => state.leave);
  const toggleMute = useVoice((state) => state.toggleMute);
  const toggleDeafen = useVoice((state) => state.toggleDeafen);
  const toggleCamera = useVoice((state) => state.toggleCamera);
  const toggleScreenShare = useVoice((state) => state.toggleScreenShare);
  const upsertConversation = useChat((state) => state.upsertConversation);
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [incomingDetails, setIncomingDetails] = useState<Conversation | null>(null);
  const [, setClock] = useState(0);

  useEffect(() => {
    if (!socket || !callsEnabled) return;
    const offs = [
      on('voice:incoming', ((payload: IncomingCall) => {
        if (payload.fromUserId === me.id || channelId === payload.channelId) return;
        setIncoming(payload);
        const known = conversations.find((conversation) => conversation.id === payload.conversationId);
        setIncomingDetails(known ?? null);
        if (!known) {
          void api
            .get<{ conversation: Conversation }>(`/api/conversations/${payload.conversationId}`)
            .then((result) => setIncomingDetails(result.conversation))
            .catch(() => setIncoming((current) => current?.channelId === payload.channelId ? null : current));
        }
      }) as never),
      on('voice:ended', ((payload: { channelId: string }) => {
        setIncoming((current) => current?.channelId === payload.channelId ? null : current);
        setIncomingDetails((current) => current?.id === payload.channelId.slice(3) ? null : current);
      }) as never),
      on('voice:declined', ((payload: { channelId: string; userId: string }) => {
        if (payload.channelId === channelId && payload.userId !== me.id) {
          const person = conversations
            .flatMap((conversation) => conversation.members)
            .find((member) => member.id === payload.userId);
          toast.info(
            fa
              ? `${person?.displayName ?? 'کاربر'} تماس را رد کرد.`
              : `${person?.displayName ?? 'Someone'} declined the call.`,
          );
        }
      }) as never),
    ];
    return () => offs.forEach((off) => off());
  }, [socket, callsEnabled, channelId, me.id, conversations, fa, on]);

  useEffect(() => {
    if (!incoming) return;
    const timeout = window.setTimeout(() => {
      setIncoming(null);
      setIncomingDetails(null);
    }, 45_000);
    return () => window.clearTimeout(timeout);
  }, [incoming]);

  useEffect(() => {
    if (!joinedAt) return;
    const interval = window.setInterval(() => setClock((value) => value + 1), 1_000);
    return () => window.clearInterval(interval);
  }, [joinedAt]);

  const activeConversation = useMemo(
    () =>
      channelId?.startsWith('dm:')
        ? conversations.find((conversation) => conversation.id === channelId.slice(3)) ?? null
        : null,
    [channelId, conversations],
  );

  const incomingConversation = incoming
    ? conversations.find((conversation) => conversation.id === incoming.conversationId) ??
      (incomingDetails?.id === incoming.conversationId ? incomingDetails : null)
    : null;
  const incomingCaller = incomingConversation?.members.find((member) => member.id === incoming?.fromUserId);

  async function acceptCall() {
    if (!incoming || !incomingConversation) return;
    const call = incoming;
    setIncoming(null);
    setIncomingDetails(null);
    let selected = incomingConversation;
    if (selected.type === 'dm') {
      try {
        const reopened = await api.post<{ conversation: Conversation }>('/api/conversations/dm', {
          userId: call.fromUserId,
        });
        selected = reopened.conversation;
        upsertConversation(selected);
      } catch (error) {
        toast.error(errorMessage(error, fa ? 'باز کردن گفتگو انجام نشد.' : 'Could not open the conversation.'));
        return;
      }
    }
    onOpenConversation(selected);
    await join(call.channelId, { withVideo: call.video });
  }

  function declineCall() {
    if (!incoming) return;
    emit('voice:decline', { channelId: incoming.channelId });
    setIncoming(null);
    setIncomingDetails(null);
  }

  const title = activeConversation
    ? conversationTitle(activeConversation, me.id, fa)
    : '';
  const elapsed = joinedAt ? Math.max(0, Math.floor((Date.now() - joinedAt) / 1000)) : 0;
  const elapsedLabel = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  if (!incoming && !activeConversation && !connecting) return null;

  return createPortal(
    <>
      {incoming && incomingConversation ? (
        <div className="incoming-call" role="dialog" aria-modal="false" aria-label={fa ? 'تماس ورودی' : 'Incoming call'}>
          <div className="incoming-call-pulse">
            <Avatar
              name={incomingCaller?.displayName ?? conversationTitle(incomingConversation, me.id, fa)}
              id={incomingCaller?.id ?? incomingConversation.id}
              src={incomingCaller?.avatarUrl ?? incomingConversation.iconUrl}
              color={incomingCaller?.bannerColor}
              size={58}
            />
          </div>
          <div className="incoming-call-copy">
            <span>{incoming.video ? (fa ? 'تماس تصویری ورودی' : 'Incoming video call') : (fa ? 'تماس صوتی ورودی' : 'Incoming voice call')}</span>
            <strong>{incomingCaller?.displayName ?? conversationTitle(incomingConversation, me.id, fa)}</strong>
          </div>
          <div className="incoming-call-actions">
            <button className="call-round decline" onClick={declineCall} title={fa ? 'رد تماس' : 'Decline'}>
              <Icon name="close" size={21} />
            </button>
            <button className="call-round accept" onClick={() => void acceptCall()} title={fa ? 'پاسخ' : 'Answer'}>
              <Icon name={incoming.video ? 'video' : 'microphone'} size={21} />
            </button>
          </div>
        </div>
      ) : null}

      {activeConversation ? (
        <aside className="direct-call-dock" aria-label={fa ? 'تماس فعال' : 'Active call'}>
          <div className="direct-call-head">
            <div>
              <span className="call-live-dot" />
              <strong>{title}</strong>
              <small>{elapsedLabel}</small>
            </div>
            <button className="head-btn" onClick={() => onOpenConversation(activeConversation)} title={fa ? 'باز کردن گفتگو' : 'Open conversation'}>
              <Icon name="message" size={17} />
            </button>
          </div>
          <div className={`direct-call-grid${Object.keys(remoteStreams).length ? '' : ' waiting'}`}>
            <CallVideo
              stream={localStream}
              user={me}
              muted
              label={fa ? 'شما' : 'You'}
            />
            {Object.entries(remoteStreams).map(([userId, stream]) => (
              <CallVideo
                key={userId}
                stream={stream}
                user={activeConversation.members.find((member) => member.id === userId)}
                label={activeConversation.members.find((member) => member.id === userId)?.displayName ?? (fa ? 'شرکت‌کننده' : 'Participant')}
              />
            ))}
            {Object.keys(remoteStreams).length === 0 ? (
              <div className="call-waiting-copy">
                <span className="spinner" />
                <span>{fa ? 'در انتظار پیوستن دیگران…' : 'Waiting for others to join…'}</span>
              </div>
            ) : null}
          </div>
          <div className="direct-call-controls">
            <button className={`call-control${muted ? ' off' : ''}`} onClick={toggleMute} title={muted ? (fa ? 'فعال کردن میکروفن' : 'Unmute') : (fa ? 'بی‌صدا کردن' : 'Mute')}>
              <Icon name={muted ? 'volumeOff' : 'microphone'} size={19} />
            </button>
            <button className={`call-control${deafened ? ' off' : ''}`} onClick={toggleDeafen} title={deafened ? (fa ? 'فعال کردن صدا' : 'Undeafen') : (fa ? 'قطع صدای دریافتی' : 'Deafen')}>
              <Icon name="headphones" size={19} />
            </button>
            <button className={`call-control${cameraOn ? ' active' : ''}`} onClick={() => void toggleCamera()} title={fa ? 'دوربین' : 'Camera'}>
              <Icon name="video" size={19} />
            </button>
            <button className={`call-control${screenSharing ? ' active' : ''}`} onClick={() => void toggleScreenShare()} title={fa ? 'اشتراک صفحه' : 'Share screen'}>
              <Icon name="screen" size={19} />
            </button>
            <button className="call-control hangup" onClick={leave} title={fa ? 'پایان تماس' : 'End call'}>
              <Icon name="close" size={20} />
            </button>
          </div>
        </aside>
      ) : null}
    </>,
    document.body,
  );
}

function CallVideo({
  stream,
  user,
  muted = false,
  label,
}: {
  stream: MediaStream | null;
  user?: PublicUser | null;
  muted?: boolean;
  label: string;
}) {
  const [node, setNode] = useState<HTMLVideoElement | null>(null);
  const hasVideo = Boolean(stream?.getVideoTracks().some((track) => track.readyState === 'live'));

  useEffect(() => {
    if (!node) return;
    node.srcObject = stream;
    void node.play().catch(() => undefined);
    return () => {
      node.srcObject = null;
    };
  }, [node, stream]);

  return (
    <div className={`call-video${hasVideo ? ' has-video' : ''}`}>
      <video ref={setNode} autoPlay playsInline muted={muted} />
      {!hasVideo ? (
        <Avatar
          name={user?.displayName ?? label}
          id={user?.id ?? label}
          src={user?.avatarUrl}
          color={user?.bannerColor}
          size={52}
        />
      ) : null}
      <span>{label}</span>
    </div>
  );
}

function conversationTitle(conversation: Conversation, selfId: string, fa: boolean) {
  if (conversation.type === 'group_dm') {
    return conversation.name ||
      conversation.members
        .filter((member) => member.id !== selfId)
        .map((member) => member.displayName)
        .join(', ') ||
      (fa ? 'گروه خصوصی' : 'Group DM');
  }
  return conversation.members.find((member) => member.id !== selfId)?.displayName ??
    (fa ? 'پیام خصوصی' : 'Direct message');
}
