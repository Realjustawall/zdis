import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageItem } from './MessageItem';
import { Composer, type EncryptedAttachmentMeta } from './Composer';
import { EmptyState, Modal, Confirm, Avatar } from './ui';
import { VoiceStage } from './VoiceStage';
import { useChat, targetKey, targetPath, type Target } from '../store/chat';
import { useRealtime } from '../store/realtime';
import { useSession } from '../store/session';
import { toast } from '../store/toast';
import { api, ApiError } from '../lib/api';
import { formatDayHeading, isNewDay } from '../lib/format';
import {
  decryptConversationMessage,
  encryptConversationMessage,
  ensureE2eeIdentity,
  readableEncryptedPreview,
} from '../lib/e2ee';
import type { Attachment, Channel, Message, PublicUser } from '../types';
import { useI18n } from '../lib/i18n';
import { Icon, type IconName } from './Icon';
import { MessagePreview } from './MessagePreview';

const EMPTY_ROLES: import('../types').ServerRole[] = [];

function securePayload(text: string, attachments: EncryptedAttachmentMeta[] = []) {
  return attachments.length ? JSON.stringify({ v: 1, text, attachments }) : text;
}

interface ScheduledMessage {
  id: string;
  content: string;
  encrypted: boolean;
  sendAt: number;
  status: string;
  error: string | null;
}

interface PollAnalytics {
  messageId: string;
  question: string;
  anonymous: boolean;
  multiple: boolean;
  examMode: boolean;
  createdAt: number;
  closesAt: number | null;
  closed: boolean;
  totalSelections: number;
  uniqueVoters: number;
  eligibleVoters: number;
  participationRate: number;
  correctAnswers: number;
  accuracyRate: number;
  leadingOptionIds: string[];
  options: Array<{
    id: string;
    label: string;
    votes: number;
    percentage: number;
    correct: boolean;
    voters: Array<{ id: string; username: string; displayName: string; avatarUrl: string | null; votedAt: number }>;
  }>;
  activity: Array<{ at: number; votes: number }>;
}

interface Props {
  target: NonNullable<Target>;
  title: string;
  glyph: string;
  topic?: string | null;
  members: PublicUser[];
  canModerate: boolean;
  canPin: boolean;
  voiceChannel?: Channel | null;
  onOpenMembers?: () => void;
  membersOpen?: boolean;
  headerExtra?: React.ReactNode;
}

export function ChatView({
  target,
  title,
  glyph,
  topic,
  members,
  canModerate,
  canPin,
  voiceChannel,
  onOpenMembers,
  membersOpen,
  headerExtra,
}: Props) {
  const user = useSession((state) => state.user)!;
  const messages = useChat((state) => state.messages[targetKey(target)]);
  const hasMore = useChat((state) => state.hasMore[targetKey(target)]);
  const loading = useChat((state) => state.loadingMessages[targetKey(target)]);
  const loadMessages = useChat((state) => state.loadMessages);
  const sendMessage = useChat((state) => state.sendMessage);
  const editMessageAction = useChat((state) => state.editMessage);
  const deleteMessageAction = useChat((state) => state.deleteMessage);
  const toggleReaction = useChat((state) => state.toggleReaction);
  const togglePin = useChat((state) => state.togglePin);
  const markRead = useChat((state) => state.markRead);
  const applyIncoming = useChat((state) => state.applyIncoming);
  const applyUpdated = useChat((state) => state.applyUpdated);
  const roles = useChat((state) =>
    target.kind === 'channel'
      ? state.groupDetail[target.groupId]?.roles ?? EMPTY_ROLES
      : EMPTY_ROLES,
  );
  const channelType = useChat((state) =>
    target.kind === 'channel'
      ? state.groupDetail[target.groupId]?.channels.find(
          (channel) => channel.id === target.channelId,
        )?.type
      : undefined,
  );

  const typingIds = useRealtime((state) => state.typing[targetKey(target)]);
  const startTyping = useRealtime((state) => state.startTyping);
  const stopTyping = useRealtime((state) => state.stopTyping);

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [pollEditing, setPollEditing] = useState<Message | null>(null);
  const [pollDraft, setPollDraft] = useState<{ question: string; options: string[]; multiple: boolean; anonymous: boolean; examMode: boolean; correctOptionIndex: number; closesAt: number | null }>({ question: '', options: ['', ''], multiple: false, anonymous: false, examMode: false, correctOptionIndex: 0, closesAt: null });
  const [pollAnalytics, setPollAnalytics] = useState<PollAnalytics | null>(null);
  const [pollAnalyticsMessage, setPollAnalyticsMessage] = useState<Message | null>(null);
  const [pollAnalyticsLoading, setPollAnalyticsLoading] = useState(false);
  const [deleting, setDeleting] = useState<Message | null>(null);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pins, setPins] = useState<Message[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedMessages, setSavedMessages] = useState<Message[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const [threadOpen, setThreadOpen] = useState(false);
  const [threadMessages, setThreadMessages] = useState<Message[]>([]);
  const [threadRoot, setThreadRoot] = useState<Message | null>(null);
  const [threadReply, setThreadReply] = useState('');
  const e2eeAvailable = useSession((state) => state.settings?.feature_e2ee ?? false);
  const e2eeRequired = useSession((state) => state.settings?.e2ee_required_for_dms ?? false);
  const secureStorageKey = target.kind === 'conversation' ? `zdis.e2ee.${target.conversationId}` : '';
  const [secureMode, setSecureMode] = useState(() => Boolean(
    secureStorageKey && (e2eeRequired || localStorage.getItem(secureStorageKey) === '1'),
  ));
  const { locale } = useI18n();
  const fa = locale === 'fa';

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const key = targetKey(target);

  const typingTarget = useMemo(
    () =>
      target.kind === 'channel'
        ? { channelId: target.channelId }
        : { conversationId: target.conversationId },
    [target],
  );

  // Load history when the open target changes.
  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
    atBottomRef.current = true;
    if (!messages) void loadMessages(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    setSecureMode(Boolean(
      secureStorageKey && (e2eeRequired || localStorage.getItem(secureStorageKey) === '1'),
    ));
  }, [secureStorageKey, e2eeRequired]);

  useEffect(() => {
    void api
      .get<{ messages: Message[] }>('/api/saved')
      .then((data) => {
        setSavedMessages(data.messages);
        setSavedIds(new Set(data.messages.map((message) => message.id)));
      })
      .catch(() => {});
  }, [key]);

  // Keep the viewport pinned to the newest message unless the reader scrolled up.
  useEffect(() => {
    if (!atBottomRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, [messages?.length, key]);

  // Mark read whenever the newest message is visible.
  useEffect(() => {
    if (!messages?.length || !atBottomRef.current) return;
    const newest = messages[messages.length - 1];
    void markRead(target, newest.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages?.length, key]);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }, []);

  async function loadOlder() {
    if (!messages?.length) return;
    const node = scrollRef.current;
    const previousHeight = node?.scrollHeight ?? 0;
    await loadMessages(target, { before: messages[0].id });
    requestAnimationFrame(() => {
      if (node) node.scrollTop = node.scrollHeight - previousHeight;
    });
  }

  const mentionNames = useMemo(
    () => new Map(members.map((member) => [member.username, member.displayName])),
    [members],
  );

  const typingLabel = useMemo(() => {
    const others = (typingIds ?? []).filter((id) => id !== user.id);
    if (!others.length) return null;
    const names = others
      .map((id) => members.find((member) => member.id === id)?.displayName ?? 'Someone')
      .slice(0, 3);
    if (others.length === 1) return `${names[0]} is typing…`;
    if (others.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    return `${names.join(', ')} and others are typing…`;
  }, [typingIds, members, user.id]);

  function openPollEditor(message: Message) {
    if (!message.poll) return;
    setPollEditing(message);
    setPollDraft({
      question: message.poll.question,
      options: message.poll.options.map((option) => option.label),
      multiple: message.poll.multiple,
      anonymous: message.poll.anonymous,
      examMode: message.poll.examMode,
      correctOptionIndex: Math.max(0, message.poll.options.findIndex((option) => message.poll?.correctOptionIds?.includes(option.id))),
      closesAt: message.poll.closesAt,
    });
  }

  async function openPollAnalytics(message: Message) {
    setPollAnalyticsMessage(message);
    setPollAnalytics(null);
    setPollAnalyticsLoading(true);
    try {
      const data = await api.get<{ analytics: PollAnalytics }>(
        `${targetPath(target)}/messages/${message.id}/poll/analytics`,
      );
      setPollAnalytics(data.analytics);
    } catch (error) {
      setPollAnalyticsMessage(null);
      toast.error(error instanceof ApiError ? error.message : 'Could not load poll analytics.');
    } finally {
      setPollAnalyticsLoading(false);
    }
  }

  async function closeCurrentPoll() {
    if (!pollAnalyticsMessage || !window.confirm(fa ? 'این نظرسنجی اکنون بسته شود؟' : 'Close this poll now?')) return;
    try {
      const data = await api.post<{ message: Message }>(
        `${targetPath(target)}/messages/${pollAnalyticsMessage.id}/poll/close`,
      );
      applyUpdated(data.message);
      setPollAnalyticsMessage(data.message);
      setPollAnalytics((current) => current ? { ...current, closed: true, closesAt: Date.now() } : current);
      toast.success(fa ? 'نظرسنجی بسته شد.' : 'Poll closed.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not close the poll.');
    }
  }

  async function savePoll() {
    if (!pollEditing) return;
    const populatedOptions = pollDraft.options.map((option, originalIndex) => ({ option: option.trim(), originalIndex })).filter((item) => item.option);
    const correctOptionIndex = populatedOptions.findIndex((item) => item.originalIndex === pollDraft.correctOptionIndex);
    if (pollDraft.examMode && correctOptionIndex < 0) {
      toast.error(fa ? 'یک پاسخ صحیح انتخاب کنید.' : 'Choose the correct answer.');
      return;
    }
    try {
      const data = await api.patch<{ message: Message }>(`${targetPath(target)}/messages/${pollEditing.id}/poll`, {
        ...pollDraft,
        options: populatedOptions.map((item) => item.option),
        correctOptionIndexes: pollDraft.examMode ? [correctOptionIndex] : [],
      });
      applyUpdated(data.message);
      setPollEditing(null);
      toast.success(fa ? 'نظرسنجی به‌روزرسانی شد.' : 'Poll updated.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update the poll.');
    }
  }

  function jumpTo(messageId: string) {
    const node = document.getElementById(`msg-${messageId}`);
    if (!node) {
      toast.info('That message is further back — scroll up to load it.');
      return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.style.transition = 'background 0.4s';
    node.style.background = 'rgba(88, 101, 242, 0.18)';
    setTimeout(() => {
      node.style.background = '';
    }, 1400);
  }

  async function openPins() {
    setPinsOpen(true);
    try {
      const data = await api.get<{ messages: Message[] }>(
        `${target.kind === 'channel' ? `/api/channels/${target.channelId}` : `/api/conversations/${target.conversationId}`}/pins`,
      );
      setPins(data.messages);
    } catch {
      toast.error('Could not load pinned messages.');
    }
  }

  async function runSearch(term: string) {
    setSearchTerm(term);
    if (term.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      if (secureMode && target.kind === 'conversation') {
        const needle = term.trim().toLocaleLowerCase();
        const decrypted = await Promise.all((messages ?? []).filter((message) => message.type === 'encrypted').map(async (message): Promise<Message | null> => {
          try {
            const plaintext = await decryptConversationMessage(message.content, target.conversationId,
              user.id, message.authorId);
            return { ...message, content: readableEncryptedPreview(plaintext), type: 'user' };
          } catch { return null; }
        }));
        setSearchResults(decrypted.filter((message): message is Message =>
          message !== null && message.content.toLocaleLowerCase().includes(needle)));
        return;
      }
      const data = await api.get<{ messages: Message[] }>(`/api/search?q=${encodeURIComponent(term)}`);
      setSearchResults(data.messages);
    } catch (error) {
      if (error instanceof ApiError && error.status !== 400) toast.error(error.message);
    }
  }

  async function openSaved() {
    setSavedOpen(true);
    try {
      const data = await api.get<{ messages: Message[] }>('/api/saved');
      setSavedMessages(data.messages);
      setSavedIds(new Set(data.messages.map((message) => message.id)));
    } catch {
      toast.error('Could not load saved messages.');
    }
  }

  async function toggleSaved(message: Message, saved: boolean) {
    try {
      await api.put(`${targetPath(target)}/messages/${message.id}/saved`, { saved });
      setSavedIds((current) => {
        const next = new Set(current);
        if (saved) next.add(message.id);
        else next.delete(message.id);
        return next;
      });
      setSavedMessages((current) =>
        saved
          ? current.some((item) => item.id === message.id)
            ? current
            : [message, ...current]
          : current.filter((item) => item.id !== message.id),
      );
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update the bookmark.');
    }
  }

  async function openScheduled() {
    setScheduledOpen(true);
    try {
      const data = await api.get<{ scheduled: ScheduledMessage[] }>(`${targetPath(target)}/scheduled`);
      setScheduledMessages(data.scheduled);
    } catch {
      toast.error('Could not load scheduled messages.');
    }
  }

  async function openThread(message: Message) {
    setThreadOpen(true);
    setThreadRoot(message);
    try {
      const data = await api.get<{ messages: Message[] }>(
        `${targetPath(target)}/messages/${message.id}/thread`,
      );
      setThreadMessages(data.messages);
    } catch {
      setThreadOpen(false);
      toast.error('Could not load the thread.');
    }
  }

  async function vote(message: Message, optionId: string) {
    if (!message.poll) return;
    const selected = message.poll.options
      .filter((option) => message.poll?.viewerOptionIds?.includes(option.id) ?? option.userIds.includes(user.id))
      .map((option) => option.id);
    const optionIds = message.poll.multiple
      ? selected.includes(optionId)
        ? selected.filter((id) => id !== optionId)
        : [...selected, optionId]
      : [optionId];
    try {
      const data = await api.put<{ message: Message }>(
        `${targetPath(target)}/messages/${message.id}/poll-vote`,
        { optionIds },
      );
      applyUpdated(data.message);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not submit the vote.');
    }
  }

  return (
    <div className="main">
      <div className="main-head">
        <div className="title">
          <span className="glyph channel-glyph"><ChannelGlyph glyph={glyph} /></span>
          <span>{title}</span>
        </div>
        {topic ? <div className="topic">{topic}</div> : null}
        <div className="spacer" />
        {headerExtra}
        {target.kind === 'conversation' && e2eeAvailable ? (
          <button className={`head-btn e2ee-toggle${secureMode ? ' on secure' : ''}`} disabled={e2eeRequired} onClick={async () => {
            const next = !secureMode;
            if (next) {
              try { await ensureE2eeIdentity(user.id); }
              catch (error) { toast.error(error instanceof Error ? error.message : 'راه‌اندازی رمزنگاری ناموفق بود.'); return; }
            }
            localStorage.setItem(secureStorageKey, next ? '1' : '0');
            setSecureMode(next);
            setSearchOpen(false);
            toast.info(next ? 'رمزنگاری سرتاسری برای پیام‌های جدید فعال شد.' : 'پیام‌های جدید بدون E2EE ارسال می‌شوند.');
          }} title={e2eeRequired ? 'رمزنگاری سرتاسری برای گفتگوهای خصوصی الزامی است' : secureMode ? 'E2EE فعال است' : 'فعال‌سازی رمزنگاری سرتاسری'}><Icon name="lock" size={17} /></button>
        ) : null}
        <button className="head-btn secondary-head-action" onClick={() => void openSaved()} title={fa ? 'پیام‌های ذخیره‌شده' : 'Saved messages'}>
          <Icon name="bookmark" size={17} />
        </button>
        <button className="head-btn secondary-head-action" onClick={() => void openScheduled()} title={fa ? 'پیام‌های زمان‌بندی‌شده' : 'Scheduled messages'}>
          <Icon name="calendar" size={17} />
        </button>
        <button className="head-btn secondary-head-action" onClick={openPins} title={fa ? 'پیام‌های سنجاق‌شده' : 'Pinned messages'}>
          <Icon name="pin" size={17} />
        </button>
        <button
          className={`head-btn search-head-action${searchOpen ? ' on' : ''}`}
          onClick={() => setSearchOpen((open) => !open)}
          title={fa ? 'جست‌وجو' : 'Search'}
        >
          <Icon name="search" size={18} />
        </button>
        {onOpenMembers ? (
          <button
            className={`head-btn${membersOpen ? ' on' : ''}`}
            onClick={onOpenMembers}
            title={fa ? 'اعضا' : 'Members'}
          >
            <Icon name="users" size={18} />
          </button>
        ) : null}
      </div>

      {searchOpen ? (
        <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)' }}>
          <input
            className="input"
            placeholder={fa ? 'جست‌وجو در پیام‌های قابل مشاهده…' : 'Search everything you can read…'}
            value={searchTerm}
            onChange={(event) => void runSearch(event.target.value)}
            autoFocus
          />
          {searchResults.length > 0 ? (
            <div className="picker-list" style={{ marginTop: 10, maxHeight: 220 }}>
              {searchResults.map((result) => (
                <button
                  key={result.id}
                  className="picker-row"
                  onClick={() => {
                    setSearchOpen(false);
                    jumpTo(result.id);
                  }}
                >
                  <Avatar
                    name={result.author?.displayName ?? '?'}
                    id={result.authorId}
                    color={result.author?.bannerColor}
                    size={28}
                  />
                  <span className="info">
                    <span className="name">{result.author?.displayName}</span>
                    <span className="sub">{result.content.slice(0, 90)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : searchTerm.trim().length >= 2 ? (
            <p className="faint small" style={{ marginTop: 8 }}>
              {fa ? 'نتیجه‌ای پیدا نشد.' : 'Nothing matched.'}
            </p>
          ) : null}
        </div>
      ) : null}

      {voiceChannel ? <VoiceStage channel={voiceChannel} members={members} /> : null}

      <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>
        {!hasMore && target.kind === 'conversation' && secureMode ? (
          <div className="conversation-e2ee-intro">
            <Icon name="lock" size={18} />
            <span><strong>{fa ? 'پیام‌ها و تماس‌ها سرتاسری رمزنگاری شده‌اند' : 'Messages and calls are end-to-end encrypted'}</strong>
              <small>{fa ? 'فقط افراد این گفتگو می‌توانند محتوای آن را بخوانند یا بشنوند.' : 'Only people in this conversation can read or listen to them.'}</small></span>
          </div>
        ) : null}
        {hasMore ? (
          <button className="btn ghost small load-more" onClick={loadOlder} disabled={loading}>
            {loading ? (fa ? 'در حال بارگذاری…' : 'Loading…') : (fa ? 'بارگذاری پیام‌های قبلی' : 'Load earlier messages')}
          </button>
        ) : messages?.length ? (
          <div className="channel-intro">
            <div className="channel-intro-icon"><ChannelGlyph glyph={glyph} size={28} /></div>
            <h2>{title}</h2>
            <p>{fa ? 'این آغاز گفتگو است.' : 'This is the beginning of the conversation.'}</p>
          </div>
        ) : null}

        {!messages && loading ? (
          <div className="empty-state">
            <span className="spinner" />
          </div>
        ) : null}

        {messages?.length === 0 ? (
          <EmptyState icon={<Icon name="message" size={34} />} title={fa ? 'هنوز پیامی نیست' : 'No messages yet'}>
            {fa ? 'گفتگو را با یک پیام آغاز کنید.' : 'Say something — it is quiet in here.'}
          </EmptyState>
        ) : null}

        {messages?.map((message, index) => {
          const previous = index > 0 ? messages[index - 1] : undefined;
          const showDay = isNewDay(previous?.createdAt, message.createdAt);
          return (
            <div key={message.id}>
              {showDay ? <div className="day-divider">{formatDayHeading(message.createdAt)}</div> : null}
              <MessageItem
                message={message}
                previous={showDay ? undefined : previous}
                currentUserId={user.id}
                currentUsername={user.username}
                canModerate={canModerate}
                canPin={canPin}
                canPublish={channelType === 'announcement' && canModerate}
                onReply={setReplyTo}
                onEdit={setEditing}
                onEditPoll={openPollEditor}
                onAnalyzePoll={(msg) => void openPollAnalytics(msg)}
                onDelete={setDeleting}
                onReact={(msg, emoji) =>
                  void toggleReaction(target, msg.id, emoji).catch((error) =>
                    toast.error(error instanceof ApiError ? error.message : 'Could not react.'),
                  )
                }
                onPin={(msg, pinned) =>
                  void togglePin(target, msg.id, pinned).catch((error) =>
                    toast.error(error instanceof ApiError ? error.message : 'Could not pin.'),
                  )
                }
                onPublish={(msg) => {
                  void api
                    .post<{ publishedCount: number }>(
                      `${targetPath(target)}/messages/${msg.id}/publish`,
                    )
                    .then((result) =>
                      toast.success(
                        result.publishedCount
                          ? `Published to ${result.publishedCount} following channel${result.publishedCount === 1 ? '' : 's'}.`
                          : 'This announcement has no new follower destinations.',
                      ),
                    )
                    .catch((error) =>
                      toast.error(
                        error instanceof ApiError
                          ? error.message
                          : 'Could not publish this announcement.',
                      ),
                    );
                }}
                isSaved={savedIds.has(message.id)}
                onSave={(msg, saved) => void toggleSaved(msg, saved)}
                onOpenThread={(msg) => void openThread(msg)}
                onPollVote={(msg, optionId) => void vote(msg, optionId)}
                onReport={(msg, decryptedEvidence) => {
                  const details = window.prompt('Describe why this message should be reviewed (optional):');
                  if (details === null) return;
                  void api
                    .post(`${targetPath(target)}/messages/${msg.id}/report`, {
                      reason: 'other',
                      details: details.trim() || null,
                      decryptedEvidence,
                    })
                    .then(() => toast.success('Report submitted for review.'))
                    .catch((error) =>
                      toast.error(error instanceof ApiError ? error.message : 'Could not submit report.'),
                    );
                }}
                onReportUser={(userId) => {
                  const allowedReasons = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'malware', 'impersonation', 'other'] as const;
                  const reason = window.prompt('Reason: spam, harassment, hate, sexual, violence, malware, impersonation, or other', 'harassment');
                  if (!reason || !allowedReasons.includes(reason as typeof allowedReasons[number])) {
                    if (reason) toast.error(fa ? 'دلیل گزارش معتبر نیست.' : 'Choose a valid report reason.');
                    return;
                  }
                  const details = window.prompt('Additional details (optional):', '') ?? null;
                  void api.post(`/api/users/${userId}/report`, { reason, details: (details ?? '').trim() || null })
                    .then(() => toast.success(fa ? 'گزارش کاربر ثبت شد.' : 'User report submitted.'))
                    .catch((error) => toast.error(error instanceof ApiError ? error.message : 'Could not report user.'));
                }}
                onJumpTo={jumpTo}
                onOpenImage={setLightbox}
                mentionNames={mentionNames}
              />
            </div>
          );
        })}
      </div>

      <Composer
        targetPath={targetPath(target)}
        groupId={target.kind === 'channel' ? target.groupId : undefined}
        channelId={target.kind === 'channel' ? target.channelId : undefined}
        placeholder={`Message ${glyph}${title}`}
        replyTo={replyTo}
        editing={editing}
        members={members}
        roles={roles}
        secureMode={secureMode}
        onCancelReply={() => setReplyTo(null)}
        onCancelEdit={() => setEditing(null)}
        onSend={async (body) => {
          if (secureMode && target.kind === 'conversation') {
            const content = await encryptConversationMessage(target.conversationId, user.id,
              securePayload(body.content, body.encryptedAttachments));
            await sendMessage(target, { content, encrypted: true, replyToId: body.replyToId,
              attachmentIds: body.attachmentIds, expiresInSeconds: body.expiresInSeconds });
          } else {
            await sendMessage(target, body);
          }
          atBottomRef.current = true;
        }}
        onEncrypt={target.kind === 'conversation'
          ? (content, attachments) => encryptConversationMessage(target.conversationId, user.id,
              securePayload(content, attachments))
          : undefined}
        onPollCreated={applyIncoming}
        onSaveEdit={(messageId, content) => editMessageAction(target, messageId, content)}
        onTyping={() => startTyping(typingTarget)}
        onStopTyping={() => stopTyping(typingTarget)}
        typingLabel={typingLabel}
      />

      {deleting ? (
        <Confirm
          title="Delete message"
          message="This cannot be undone. Any files attached to it are removed too."
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await deleteMessageAction(target, deleting.id);
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not delete.');
            }
            setDeleting(null);
          }}
        />
      ) : null}

      {pinsOpen ? (
        <Modal title="Pinned messages" onClose={() => setPinsOpen(false)}>
          {pins.length === 0 ? (
            <p className="muted">Nothing is pinned here yet.</p>
          ) : (
            <div className="col" style={{ paddingBottom: 16 }}>
              {pins.map((pin) => (
                <button
                  key={pin.id}
                  className="picker-row"
                  onClick={() => {
                    setPinsOpen(false);
                    jumpTo(pin.id);
                  }}
                >
                  <Avatar
                    name={pin.author?.displayName ?? '?'}
                    id={pin.authorId}
                    color={pin.author?.bannerColor}
                    size={30}
                  />
                  <span className="info">
                    <span className="name">{pin.author?.displayName}</span>
                    <span className="sub"><MessagePreview
                      content={pin.content}
                      encrypted={pin.type === 'encrypted'}
                      encryptedContent={pin.type === 'encrypted' ? pin.content : null}
                      conversationId={pin.conversationId}
                      authorId={pin.authorId}
                      currentUserId={user.id}
                      fallback={fa ? 'پیام رمزگذاری‌شده' : 'Encrypted message'}
                      limit={120}
                    /></span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      ) : null}

      {savedOpen ? (
        <Modal title="Saved messages" onClose={() => setSavedOpen(false)}>
          {savedMessages.length === 0 ? (
            <p className="muted">You have no saved messages.</p>
          ) : (
            <div className="picker-list">
              {savedMessages.map((message) => (
                <button
                  key={message.id}
                  className="picker-row"
                  onClick={() => {
                    setSavedOpen(false);
                    jumpTo(message.id);
                  }}
                >
                  <span className="info">
                    <span className="name">{message.author?.displayName ?? 'Unknown'}</span>
                    <span className="sub"><MessagePreview
                      content={message.content}
                      encrypted={message.type === 'encrypted'}
                      encryptedContent={message.type === 'encrypted' ? message.content : null}
                      conversationId={message.conversationId}
                      authorId={message.authorId}
                      currentUserId={user.id}
                      fallback={fa ? 'پیام رمزگذاری‌شده' : 'Encrypted message'}
                      limit={140}
                    /></span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      ) : null}

      {scheduledOpen ? (
        <Modal title="Scheduled messages" onClose={() => setScheduledOpen(false)}>
          {scheduledMessages.length === 0 ? (
            <p className="muted">Nothing is scheduled here.</p>
          ) : (
            <div className="picker-list">
              {scheduledMessages.map((scheduled) => (
                <div key={scheduled.id} className="picker-row">
                  <span className="info">
                    <span className="name">{scheduled.encrypted ? (fa ? 'پیام رمزگذاری‌شده' : 'End-to-end encrypted message') : scheduled.content || 'Attachment'}</span>
                    <span className="sub">
                      {new Date(scheduled.sendAt).toLocaleString()} · {scheduled.status}
                    </span>
                  </span>
                  <button
                    className="btn danger small"
                    onClick={() =>
                      void api
                        .del(`${targetPath(target)}/scheduled/${scheduled.id}`)
                        .then(() =>
                          setScheduledMessages((current) =>
                            current.filter((item) => item.id !== scheduled.id),
                          ),
                        )
                        .catch((error) =>
                          toast.error(error instanceof ApiError ? error.message : 'Could not cancel.'),
                        )
                    }
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}

      {threadOpen ? (
        <Modal title="Message thread" onClose={() => setThreadOpen(false)}>
          <div className="picker-list">
            {threadMessages.map((message) => (
              <div key={message.id} className="picker-row">
                <Avatar
                  name={message.author?.displayName ?? '?'}
                  id={message.authorId}
                  color={message.author?.bannerColor}
                  size={30}
                />
                <span className="info">
                  <span className="name">{message.author?.displayName ?? 'Unknown'}</span>
                  <span className="sub"><MessagePreview
                    content={message.content}
                    encrypted={message.type === 'encrypted'}
                    encryptedContent={message.type === 'encrypted' ? message.content : null}
                    conversationId={message.conversationId}
                    authorId={message.authorId}
                    currentUserId={user.id}
                    fallback={fa ? 'پیام رمزگذاری‌شده' : 'Encrypted message'}
                    limit={200}
                  /></span>
                </span>
                <button
                  className="btn ghost small"
                  onClick={() => {
                    setReplyTo(message);
                    setThreadOpen(false);
                  }}
                >
                  Reply
                </button>
              </div>
            ))}
          </div>
          {threadRoot ? (
            <div className="forum-reply">
              <textarea
                className="textarea"
                placeholder="Reply in thread…"
                value={threadReply}
                onChange={(event) => setThreadReply(event.target.value)}
              />
              <button
                className="btn primary"
                disabled={!threadReply.trim()}
                onClick={async () => {
                  try {
                    await api.post(`${targetPath(target)}/messages`, {
                      content: threadReply.trim(),
                      replyToId: threadRoot.id,
                    });
                    setThreadReply('');
                    await openThread(threadRoot);
                  } catch (error) {
                    toast.error(error instanceof ApiError ? error.message : 'Could not reply in thread.');
                  }
                }}
              >
                Reply
              </button>
            </div>
          ) : null}
        </Modal>
      ) : null}

      {pollAnalyticsMessage ? (
        <Modal
          title={fa ? 'مرکز تحلیل نظرسنجی' : 'Poll insights'}
          description={fa ? 'نمای زنده مشارکت و توزیع رأی‌ها' : 'Live participation and response intelligence'}
          onClose={() => setPollAnalyticsMessage(null)}
          wide
          className="poll-analytics-modal"
          footer={pollAnalytics ? (
            <>
              <button className="btn ghost" onClick={() => {
                setPollAnalyticsMessage(null);
                openPollEditor(pollAnalyticsMessage);
              }}><Icon name="edit" size={16} /> {fa ? 'ویرایش نظرسنجی' : 'Edit poll'}</button>
              {!pollAnalytics.closed ? (
                <button className="btn danger" onClick={() => void closeCurrentPoll()}>
                  <Icon name="close" size={16} /> {fa ? 'بستن رأی‌گیری' : 'Close voting'}
                </button>
              ) : null}
            </>
          ) : undefined}
        >
          {pollAnalyticsLoading || !pollAnalytics ? (
            <div className="poll-analytics-loading"><span className="spinner" /> {fa ? 'در حال تحلیل پاسخ‌ها…' : 'Analyzing responses…'}</div>
          ) : (
            <div className="poll-analytics">
              <section className="poll-analytics-hero">
                <div className="poll-analytics-symbol"><Icon name="chart" size={26} /></div>
                <div>
                  <span className="poll-kicker">{pollAnalytics.closed ? (fa ? 'نتیجه نهایی' : 'FINAL RESULTS') : (fa ? 'نتایج زنده' : 'LIVE RESULTS')}</span>
                  <h2>{pollAnalytics.question}</h2>
                  <p>{pollAnalytics.examMode ? (fa ? 'حالت آزمون · یک تلاش' : 'Exam mode · one attempt') : pollAnalytics.multiple ? (fa ? 'پاسخ چندگزینه‌ای' : 'Multiple choice') : (fa ? 'پاسخ تک‌گزینه‌ای' : 'Single choice')} · {pollAnalytics.anonymous ? (fa ? 'هویت رأی‌دهندگان محرمانه است' : 'Voter identities are private') : (fa ? 'رأی‌دهندگان قابل مشاهده‌اند' : 'Voters are visible')}</p>
                </div>
                <span className={`poll-live-pill${pollAnalytics.closed ? ' closed' : ''}`}><i />{pollAnalytics.closed ? (fa ? 'بسته' : 'Closed') : (fa ? 'زنده' : 'Live')}</span>
              </section>

              <div className="poll-stat-grid">
                <div className="poll-stat"><span>{fa ? 'رأی‌دهندگان' : 'Voters'}</span><strong>{pollAnalytics.uniqueVoters}</strong><small>{fa ? 'شرکت‌کننده یکتا' : 'unique participants'}</small></div>
                <div className="poll-stat accent"><span>{pollAnalytics.examMode ? (fa ? 'دقت آزمون' : 'Exam accuracy') : (fa ? 'مشارکت' : 'Participation')}</span><strong>{pollAnalytics.examMode ? pollAnalytics.accuracyRate : pollAnalytics.participationRate}%</strong><small>{pollAnalytics.examMode ? (fa ? `${pollAnalytics.correctAnswers} پاسخ صحیح` : `${pollAnalytics.correctAnswers} correct answers`) : (fa ? `از ${pollAnalytics.eligibleVoters} عضو واجد شرایط` : `of ${pollAnalytics.eligibleVoters} eligible members`)}</small></div>
                <div className="poll-stat"><span>{fa ? 'انتخاب‌ها' : 'Selections'}</span><strong>{pollAnalytics.totalSelections}</strong><small>{pollAnalytics.multiple ? (fa ? 'چند انتخاب مجاز' : 'multiple allowed') : (fa ? 'هر نفر یک انتخاب' : 'one per voter')}</small></div>
                <div className="poll-stat"><span>{fa ? 'وضعیت' : 'Status'}</span><strong className="poll-stat-status">{pollAnalytics.closed ? (fa ? 'پایان‌یافته' : 'Ended') : (fa ? 'فعال' : 'Open')}</strong><small>{pollAnalytics.closesAt ? new Date(pollAnalytics.closesAt).toLocaleString() : (fa ? 'بدون پایان خودکار' : 'no automatic close')}</small></div>
              </div>

              <div className="poll-analytics-grid">
                <section className="poll-insight-panel">
                  <div className="poll-panel-head"><div><span>{fa ? 'توزیع پاسخ‌ها' : 'Response distribution'}</span><small>{fa ? 'مقایسه گزینه‌ها' : 'Option-by-option performance'}</small></div><Icon name="poll" size={19} /></div>
                  <div className="poll-breakdown">
                    {pollAnalytics.options.map((option) => (
                      <div className={`poll-breakdown-row${pollAnalytics.leadingOptionIds.includes(option.id) ? ' leader' : ''}${option.correct ? ' correct-answer' : ''}`} key={option.id}>
                        <div className="poll-breakdown-label"><span>{option.label}</span>{option.correct ? <em>{fa ? 'پاسخ صحیح' : 'Correct'}</em> : pollAnalytics.leadingOptionIds.includes(option.id) ? <em>{fa ? 'پیشتاز' : 'Leader'}</em> : null}<strong>{option.percentage}%</strong></div>
                        <div className="poll-breakdown-track"><span style={{ width: `${option.percentage}%` }} /></div>
                        <div className="poll-breakdown-meta"><span>{option.votes} {fa ? 'انتخاب' : option.votes === 1 ? 'vote' : 'votes'}</span>{!pollAnalytics.anonymous && option.voters.length ? <span className="poll-voter-stack">{option.voters.slice(0, 5).map((voter) => <Avatar key={voter.id} name={voter.displayName} id={voter.id} src={voter.avatarUrl} size={24} />)}{option.voters.length > 5 ? <b>+{option.voters.length - 5}</b> : null}</span> : null}</div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="poll-insight-panel poll-activity-panel">
                  <div className="poll-panel-head"><div><span>{fa ? 'فعالیت ۱۲ ساعت اخیر' : 'Last 12 hours'}</span><small>{fa ? 'سرعت ثبت پاسخ‌ها' : 'Voting momentum'}</small></div><Icon name="chart" size={19} /></div>
                  <div className="poll-activity-chart">
                    {pollAnalytics.activity.map((bucket) => {
                      const max = Math.max(1, ...pollAnalytics.activity.map((item) => item.votes));
                      return <div className="poll-activity-bar" key={bucket.at} title={`${new Date(bucket.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${bucket.votes}`}><span style={{ height: `${Math.max(bucket.votes ? 12 : 3, (bucket.votes / max) * 100)}%` }} /><small>{new Date(bucket.at).toLocaleTimeString([], { hour: '2-digit' })}</small></div>;
                    })}
                  </div>
                  <div className="poll-activity-summary"><strong>{pollAnalytics.activity.reduce((sum, bucket) => sum + bucket.votes, 0)}</strong><span>{fa ? 'انتخاب در ۱۲ ساعت اخیر' : 'selections in the last 12 hours'}</span></div>
                </section>
              </div>
            </div>
          )}
        </Modal>
      ) : null}

      {pollEditing ? (
        <Modal title={fa ? 'ویرایش نظرسنجی' : 'Edit poll'} onClose={() => setPollEditing(null)} footer={(
          <>
            <button className="btn ghost" onClick={() => setPollEditing(null)}>{fa ? 'انصراف' : 'Cancel'}</button>
            <button className="btn primary" onClick={() => void savePoll()}>{fa ? 'ذخیره تغییرات' : 'Save changes'}</button>
          </>
        )}>
          <div className="col" style={{ gap: 12 }}>
            <label>{fa ? 'پرسش' : 'Question'}<input value={pollDraft.question} onChange={(event) => setPollDraft((draft) => ({ ...draft, question: event.target.value }))} maxLength={300} autoFocus /></label>
            <strong>{fa ? 'گزینه‌ها' : 'Options'}</strong>
            {pollDraft.options.map((option, index) => (
              <div className="row" key={index}>
                {pollDraft.examMode ? <button className={`poll-correct-answer${pollDraft.correctOptionIndex === index ? ' selected' : ''}`} onClick={() => setPollDraft((draft) => ({ ...draft, correctOptionIndex: index }))} title={fa ? 'پاسخ صحیح' : 'Correct answer'}><Icon name="check" size={14} /></button> : null}
                <input value={option} onChange={(event) => setPollDraft((draft) => ({ ...draft, options: draft.options.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} maxLength={120} />
                {pollDraft.options.length > 2 ? <button className="btn ghost small" onClick={() => setPollDraft((draft) => ({ ...draft, options: draft.options.filter((_, itemIndex) => itemIndex !== index), correctOptionIndex: draft.correctOptionIndex === index ? 0 : draft.correctOptionIndex > index ? draft.correctOptionIndex - 1 : draft.correctOptionIndex }))}>×</button> : null}
              </div>
            ))}
            <button className="btn ghost small" onClick={() => setPollDraft((draft) => ({ ...draft, options: draft.options.length < 10 ? [...draft.options, ''] : draft.options }))} disabled={pollDraft.options.length >= 10}>{fa ? 'افزودن گزینه' : 'Add option'}</button>
            <label className="row"><input type="checkbox" checked={pollDraft.examMode} onChange={(event) => setPollDraft((draft) => ({ ...draft, examMode: event.target.checked, multiple: event.target.checked ? false : draft.multiple }))} />{fa ? 'حالت آزمون (یک تلاش)' : 'Exam mode (one attempt)'}</label>
            <label className="row"><input type="checkbox" checked={pollDraft.multiple} disabled={pollDraft.examMode} onChange={(event) => setPollDraft((draft) => ({ ...draft, multiple: event.target.checked }))} />{fa ? 'انتخاب چند گزینه‌ای' : 'Allow multiple choices'}</label>
            <label className="row"><input type="checkbox" checked={pollDraft.anonymous} onChange={(event) => setPollDraft((draft) => ({ ...draft, anonymous: event.target.checked }))} />{fa ? 'رأی‌گیری ناشناس' : 'Anonymous voting'}</label>
          </div>
        </Modal>
      ) : null}

      {lightbox ? (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox.url} alt={lightbox.filename} />
        </div>
      ) : null}
    </div>
  );
}

function ChannelGlyph({ glyph, size = 18 }: { glyph: string; size?: number }) {
  const value = glyph.trim();
  let name: IconName = 'hash';
  if (value.includes('🔊')) name = 'speaker';
  else if (value.includes('🎙')) name = 'microphone';
  else if (value.includes('📢')) name = 'announcement';
  else if (value.includes('🔒')) name = 'lock';
  else if (value === '@') name = 'message';
  else if (value.includes('👥')) name = 'users';
  return <Icon name={name} size={size} />;
}
