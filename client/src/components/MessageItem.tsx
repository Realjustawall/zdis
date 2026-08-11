import { memo, useEffect, useRef, useState } from 'react';
import { Avatar } from './ui';
import { formatFullTimestamp, formatBytes, formatTimestamp } from '../lib/format';
import { renderRichText } from '../lib/richText';
import type { Attachment, Message } from '../types';
import { decryptConversationMessage } from '../lib/e2ee';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { toast } from '../store/toast';
import { useSession } from '../store/session';
import { MessagePreview } from './MessagePreview';
import {
  decryptAndCacheAttachment,
  type DecryptedAttachmentStage,
  type EncryptedFileMetadata,
} from '../lib/fileCrypto';

interface Props {
  message: Message;
  previous?: Message;
  currentUserId: string;
  currentUsername: string;
  canModerate: boolean;
  canPin: boolean;
  canPublish?: boolean;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onEditPoll: (message: Message) => void;
  onAnalyzePoll: (message: Message) => void;
  onDelete: (message: Message) => void;
  onReact: (message: Message, emoji: string) => void;
  onPin: (message: Message, pinned: boolean) => void;
  onPublish?: (message: Message) => void;
  onSave: (message: Message, saved: boolean) => void;
  isSaved?: boolean;
  onOpenThread: (message: Message) => void;
  onPollVote: (message: Message, optionId: string) => void;
  onReport: (message: Message, decryptedEvidence?: string) => void;
  onReportUser: (userId: string) => void;
  onJumpTo?: (messageId: string) => void;
  onOpenProfile?: (userId: string) => void;
  onOpenImage: (attachment: Attachment) => void;
  mentionNames?: Map<string, string>;
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🔥'];
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

function MessageItemInner({
  message,
  previous,
  currentUserId,
  currentUsername,
  canModerate,
  canPin,
  canPublish,
  onReply,
  onEdit,
  onEditPoll,
  onAnalyzePoll,
  onDelete,
  onReact,
  onPin,
  onPublish,
  onSave,
  isSaved,
  onOpenThread,
  onPollVote,
  onReport,
  onReportUser,
  onJumpTo,
  onOpenProfile,
  onOpenImage,
  mentionNames,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [decryptedEvidence, setDecryptedEvidence] = useState<string | undefined>();
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const fishTtsEnabled = useSession((state) => state.settings?.fish_tts_enabled ?? false);
  const ttsButtonEnabled = useSession((state) => state.user?.ttsButtonEnabled ?? true);

  // Deleted rows are retained server-side only for integrity and moderation;
  // they are never a visible chat item.
  if (message.deleted) return null;

  if (message.type === 'system') {
    return (
      <div className="message system">
        <div className="gutter" />
        <div className="body">
          <div className="content" dir="auto">{message.content}</div>
        </div>
      </div>
    );
  }

  // Consecutive messages from the same person within a few minutes collapse
  // into one visual block, the way every chat client does it.
  const grouped =
    !!previous &&
    (previous.type === 'user' || previous.type === 'encrypted' || previous.type === 'tts') &&
    previous.authorId === message.authorId &&
    !message.replyToId &&
    message.createdAt - previous.createdAt < GROUPING_WINDOW_MS;

  const isMine = message.authorId === currentUserId;
  const pollTotal = message.poll?.options.reduce((total, option) => total + option.votes, 0) ?? 0;
  const ownsPoll = !!message.poll && (message.poll.creatorId === currentUserId || message.authorId === currentUserId);
  const pollSubmitted = !!message.poll?.viewerOptionIds?.length;
  const showPollResults = !!message.poll && (!message.poll.examMode || pollSubmitted || message.poll.closed || ownsPoll);
  const examPassed = !!message.poll?.examMode && pollSubmitted && message.poll.viewerOptionIds.some((id) => message.poll?.correctOptionIds?.includes(id));
  const mentionsMe =
    !message.deleted &&
    new RegExp(`(^|[^\\w@])@${currentUsername}\\b`, 'i').test(message.content);

  const classes = ['message'];
  if (grouped) classes.push('grouped');
  else classes.push('first-of-group');
  if (mentionsMe) classes.push('mentioned');
  else if (message.pinned) classes.push('pinned-highlight');
  if (message.deliveryStatus) classes.push(`delivery-${message.deliveryStatus}`);

  return (
    <div className={classes.join(' ')} id={`msg-${message.id}`}>
      <div className="gutter">
        {grouped ? (
          <span className="stamp" dir="ltr">{new Date(message.createdAt).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          })}</span>
        ) : (
          <Avatar
            name={message.author?.displayName ?? (fa ? 'ناشناس' : 'Unknown')}
            id={message.authorId}
            src={message.author?.avatarUrl}
            color={message.author?.bannerColor}
            size={40}
          />
        )}
      </div>

      <div className="body">
        {message.replyTo ? (
          <div className="reply-context" dir="auto" onClick={() => onJumpTo?.(message.replyTo!.id)}>
            <span className="spine" />
            <bdi className="who" dir="auto">@{message.replyTo.displayName}</bdi>
            <span className="snippet">
              <MessagePreview
                content={message.replyTo.preview}
                encrypted={message.replyTo.encrypted}
                encryptedContent={message.replyTo.encryptedContent}
                conversationId={message.replyTo.conversationId}
                authorId={message.replyTo.authorId}
                currentUserId={currentUserId}
                fallback={fa ? 'پیام رمزگذاری‌شده' : 'Encrypted message'}
                limit={160}
              />
            </span>
          </div>
        ) : null}

        {!grouped ? (
          <div className="meta">
            <bdi
              className="author"
              dir="auto"
              style={{ color: message.author?.bannerColor ?? undefined }}
              onClick={() => onOpenProfile?.(message.authorId)}
            >
              {message.author?.displayName ?? (fa ? 'کاربر حذف‌شده' : 'Deleted user')}
            </bdi>
            <span className="time" dir="ltr" title={formatFullTimestamp(message.createdAt)}>
              {formatTimestamp(message.createdAt)}
            </span>
            {message.pinned ? <span className="badge">{fa ? 'سنجاق‌شده' : 'pinned'}</span> : null}
            {message.type === 'tts' ? <span className="badge">TTS</span> : null}
            {message.deliveryStatus === 'sending' ? <span className="delivery-state">{fa ? 'در حال ارسال…' : 'Sending…'}</span> : null}
            {message.deliveryStatus === 'failed' ? <span className="delivery-state failed" title={message.deliveryError ?? undefined}>{fa ? 'ارسال نشد' : 'Not sent'}</span> : null}
          </div>
        ) : null}

        {!message.deleted ? (
          <>
            {message.content && message.type !== 'poll' ? (
              <div className="content" dir="auto">
                {message.type === 'encrypted' && message.conversationId ? (
                  <EncryptedContent message={message} currentUserId={currentUserId} mentionNames={mentionNames}
                    onPollVote={onPollVote} onOpenImage={onOpenImage} fa={fa}
                    showTtsButton={fishTtsEnabled && ttsButtonEnabled}
                    onDecrypted={setDecryptedEvidence} />
                ) : renderRichText(message.content, { mentionNames })}
                {message.editedAt ? (
                  <span className="edited" title={formatFullTimestamp(message.editedAt)}>
                    {fa ? '(ویرایش‌شده)' : '(edited)'}
                  </span>
                ) : null}
              </div>
            ) : null}

            {!message.suppressEmbeds && message.type !== 'encrypted' ? (
              <LinkEmbed content={message.content} />
            ) : null}

            {message.type !== 'encrypted' && message.attachments.length > 0 ? (
              <div className="attachments">
                {message.attachments.map((attachment) => (
                  <AttachmentView
                    key={attachment.id}
                    attachment={attachment}
                    onOpenImage={onOpenImage}
                  />
                ))}
              </div>
            ) : null}

            {message.type !== 'encrypted' && message.poll ? (
              <section className={`poll-card${message.poll.closed ? ' poll-closed' : ''}`}>
                <header className="poll-card-head">
                  <div className="poll-card-icon"><Icon name="poll" size={20} /></div>
                  <div className="poll-card-title">
                    <span className="poll-kicker">{fa ? 'نظرسنجی انجمن' : 'COMMUNITY POLL'}</span>
                    <strong>{message.poll.question}</strong>
                  </div>
                  <div className="poll-badges">
                    {message.poll.multiple ? <span>{fa ? 'چندگزینه‌ای' : 'Multiple'}</span> : null}
                    {message.poll.examMode ? <span className="exam">{fa ? 'آزمون' : 'Exam'}</span> : null}
                    {message.poll.anonymous ? <span>{fa ? 'ناشناس' : 'Anonymous'}</span> : null}
                    {message.poll.closed ? <span className="closed">{fa ? 'بسته' : 'Closed'}</span> : null}
                  </div>
                </header>
                <div className="poll-options">
                {message.poll.options.map((option) => {
                  const selected = message.poll!.viewerOptionIds?.includes(option.id) ?? option.userIds.includes(currentUserId);
                  const correct = message.poll!.correctOptionIds?.includes(option.id);
                  const percentage = showPollResults && pollTotal ? Math.round((option.votes / pollTotal) * 100) : 0;
                  return (
                    <button
                      key={option.id}
                      className={`poll-option${selected ? ' selected' : ''}${showPollResults && correct ? ' correct' : ''}${message.poll?.examMode && pollSubmitted && selected && !correct ? ' wrong' : ''}`}
                      disabled={message.poll?.closed || (message.poll?.examMode && pollSubmitted)}
                      onClick={() => onPollVote(message, option.id)}
                    >
                      <span className="poll-option-fill" style={{ width: `${percentage}%` }} />
                      <span className={`poll-choice-mark${message.poll?.multiple ? ' square' : ''}`}>
                        {selected ? <Icon name="check" size={13} /> : null}
                      </span>
                      <span className="poll-option-label">{option.label}</span>
                      <span className="poll-option-result">{showPollResults ? <><strong>{percentage}%</strong><small>{option.votes} {fa ? 'انتخاب' : option.votes === 1 ? 'vote' : 'votes'}</small></> : <small>{fa ? 'انتخاب پاسخ' : 'Choose answer'}</small>}</span>
                    </button>
                  );
                })}
                </div>
                <footer className="poll-card-foot">
                  <span>
                    {message.poll.examMode && pollSubmitted ? <strong className={examPassed ? 'exam-pass' : 'exam-fail'}>{examPassed ? (fa ? 'پاسخ صحیح' : 'Correct answer') : (fa ? 'پاسخ نادرست' : 'Incorrect answer')}</strong> : <><strong>{showPollResults ? pollTotal : '—'}</strong> {fa ? 'انتخاب ثبت‌شده' : pollTotal === 1 ? 'selection' : 'selections'}</>}
                    {' · '}{message.poll.examMode && !pollSubmitted && !message.poll.closed && !ownsPoll
                      ? (fa ? 'فقط یک بار می‌توانید پاسخ دهید' : 'You have one attempt')
                      : message.poll.closed
                      ? (fa ? 'رأی‌گیری پایان یافته' : 'Voting ended')
                      : message.poll.multiple
                        ? (fa ? 'هر تعداد گزینه را انتخاب کنید' : 'Select all that apply')
                        : (fa ? 'یک گزینه را انتخاب کنید' : 'Select one option')}
                  </span>
                  {ownsPoll ? (
                    <button className="poll-analyze-btn" onClick={() => onAnalyzePoll(message)}>
                      <Icon name="chart" size={15} /> {fa ? 'تحلیل' : 'Analytics'}
                    </button>
                  ) : null}
                </footer>
              </section>
            ) : null}

            {message.reactions.length > 0 ? (
              <div className="reactions">
                {message.reactions.map((reaction) => (
                  <button
                    key={reaction.emoji}
                    className={`reaction${reaction.userIds.includes(currentUserId) ? ' mine' : ''}`}
                    onClick={() => onReact(message, reaction.emoji)}
                    title={`${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`}
                  >
                    <span>{reaction.emoji}</span>
                    <span className="count">{reaction.count}</span>
                  </button>
                ))}
                <button className="reaction add" onClick={() => setPickerOpen((open) => !open)}>
                  ＋
                </button>
              </div>
            ) : null}

            {pickerOpen ? (
              <div className="reactions" style={{ marginTop: 6 }}>
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    className="reaction"
                    onClick={() => {
                      onReact(message, emoji);
                      setPickerOpen(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {!message.deleted && message.deliveryStatus !== 'sending' && message.deliveryStatus !== 'failed' ? (
        <div className="msg-actions">
          {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
            <button key={emoji} onClick={() => onReact(message, emoji)} title={`React ${emoji}`}>
              {emoji}
            </button>
          ))}
          <button onClick={() => setPickerOpen((open) => !open)} title={fa ? 'واکنش‌های بیشتر' : 'More reactions'}>
            ＋
          </button>
          <button onClick={() => onReply(message)} title={fa ? 'پاسخ' : 'Reply'}>
            <Icon name="reply" size={16} />
          </button>
          <button onClick={() => onOpenThread(message)} title={fa ? 'بازکردن رشته گفتگو' : 'Open thread'}>
            <Icon name="thread" size={16} />
            {message.threadReplyCount ? <small>{message.threadReplyCount}</small> : null}
          </button>
          <button onClick={() => onSave(message, !isSaved)} title={isSaved ? (fa ? 'حذف نشانک' : 'Remove bookmark') : (fa ? 'ذخیره پیام' : 'Save message')}>
            <Icon name="bookmark" size={16} className={isSaved ? 'filled-icon' : ''} />
          </button>
          {fishTtsEnabled && ttsButtonEnabled && message.type !== 'encrypted' && message.type !== 'poll' && message.content.trim() ? <FishTtsButton text={message.content} fa={fa} /> : null}
          {isMine ? (
            <button onClick={() => message.poll ? onEditPoll(message) : onEdit(message)} title={fa ? 'ویرایش' : 'Edit'} disabled={message.type === 'encrypted'}>
              <Icon name="edit" size={16} />
            </button>
          ) : null}
          {canPin ? (
            <button onClick={() => onPin(message, !message.pinned)} title={message.pinned ? (fa ? 'برداشتن سنجاق' : 'Unpin') : (fa ? 'سنجاق‌کردن' : 'Pin')}>
              <Icon name="pin" size={16} />
            </button>
          ) : null}
          {canPublish ? (
            <button
              onClick={() => onPublish?.(message)}
              title={fa ? 'انتشار در کانال‌های دنبال‌کننده' : 'Publish to following channels'}
            >
              <Icon name="announcement" size={16} />
            </button>
          ) : null}
          {isMine || canModerate ? (
            <button className="danger" onClick={() => onDelete(message)} title={fa ? 'حذف' : 'Delete'}>
              <Icon name="trash" size={16} />
            </button>
          ) : null}
          {!isMine ? (
            <>
              <button onClick={() => onReport(message, decryptedEvidence)} title={fa ? 'گزارش پیام' : 'Report message'}>
                <Icon name="flag" size={16} />
              </button>
              <button onClick={() => onReportUser(message.authorId)} title={fa ? 'گزارش کاربر' : 'Report user'}>
                <Icon name="users" size={16} />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LinkEmbed({ content }: { content: string }) {
  const raw = content.match(/https?:\/\/[^\s<]+/i)?.[0]?.replace(/[),.!?]+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const title = decodeURIComponent(url.pathname === '/' ? url.hostname : url.pathname).slice(0, 90);
    return (
      <a className="message-link-embed" href={url.href} target="_blank" rel="noreferrer">
        <span className="message-link-embed-icon"><Icon name="link" size={18} /></span>
        <span>
          <small>{url.hostname.replace(/^www\./, '')}</small>
          <strong>{title}</strong>
          <em>{url.href.slice(0, 140)}</em>
        </span>
        <Icon name="arrowLeft" className="message-link-embed-arrow" size={16} />
      </a>
    );
  } catch {
    return null;
  }
}

function AttachmentView({
  attachment,
  onOpenImage,
}: {
  attachment: Attachment;
  onOpenImage: (attachment: Attachment) => void;
}) {
  if (attachment.mime.startsWith('image/')) {
    return <ImageAttachment attachment={attachment} onOpenImage={onOpenImage} />;
  }

  if (attachment.mime.startsWith('video/')) {
    return <MediaAttachment attachment={attachment} kind="video" />;
  }

  if (attachment.mime.startsWith('audio/')) {
    return <MediaAttachment attachment={attachment} kind="audio" />;
  }

  if (isTextAttachment(attachment)) {
    return <TextAttachment attachment={attachment} />;
  }

  return (
    <a className="attachment-file" href={attachment.url} download={attachment.filename}>
      <span className="icon">📄</span>
      <span className="info">
        <bdi className="name" dir="auto">{attachment.filename}</bdi>
        <span className="size">{formatBytes(attachment.size)}</span>
      </span>
      <span className="faint">⭳</span>
    </a>
  );
}

function ImageAttachment({ attachment, onOpenImage }: { attachment: Attachment; onOpenImage: (attachment: Attachment) => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  return (
    <button className={`attachment-image media-${state}`} onClick={() => state === 'ready' && onOpenImage(attachment)} disabled={state === 'error'}>
      {state === 'loading' ? <span className="media-placeholder"><span className="spinner tiny" /></span> : null}
      <img src={attachment.previewUrl ?? attachment.url} alt={attachment.filename} loading="lazy" decoding="async"
        width={attachment.width ?? undefined} height={attachment.height ?? undefined}
        onLoad={() => setState('ready')} onError={() => setState('error')} />
      {state === 'error' ? <span className="media-error">Could not load image</span> : null}
    </button>
  );
}

function MediaAttachment({ attachment, kind }: { attachment: Attachment; kind: 'audio' | 'video' }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const common = {
    src: attachment.optimizedUrl ?? attachment.url,
    controls: true,
    preload: 'metadata' as const,
    onLoadStart: () => setState('loading' as const),
    onLoadedMetadata: () => setState('ready' as const),
    onCanPlay: () => setState('ready' as const),
    onError: () => setState('error' as const),
  };
  return (
    <div className={`attachment-media media-${state}`}>
      {attachment.kind === 'voice' ? <small className="muted">🎙 Voice message{attachment.durationMs ? ` · ${Math.round(attachment.durationMs / 1000)}s` : ''}</small> : null}
      {state === 'loading' ? <span className="media-loading"><span className="spinner tiny" /> Loading media…</span> : null}
      {kind === 'video' ? <video {...common} playsInline /> : <audio {...common} />}
      {state === 'error' ? <span className="media-error">This media could not be played.</span> : null}
    </div>
  );
}

const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/css', 'text/javascript', 'application/json']);
const TEXT_EXTENSIONS = /\.(?:txt|md|markdown|json|log|csv|ts|tsx|js|jsx|css|py|java|c|cc|cpp|h|hpp|go|rs|sh|sql|yaml|yml)$/i;

function isTextAttachment(attachment: Pick<Attachment, 'mime' | 'filename'>) {
  return TEXT_MIMES.has(attachment.mime) || TEXT_EXTENSIONS.test(attachment.filename);
}

function validTextBytes(bytes: Uint8Array) {
  if (bytes.includes(0)) return false;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
}

function TextAttachment({ attachment }: { attachment: Attachment }) {
  const PREVIEW_BYTES = 64 * 1024;
  const EXPANDED_BYTES = 512 * 1024;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const limit = expanded ? EXPANDED_BYTES : PREVIEW_BYTES;
    void fetch(attachment.url, {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Range: `bytes=0-${Math.min(attachment.size, limit) - 1}` },
    }).then(async (response) => {
      if (!response.ok) throw new Error('preview failed');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const decoded = validTextBytes(bytes.subarray(0, Math.min(bytes.byteLength, limit)));
      if (decoded === false) throw new Error('binary file');
      setText(decoded);
      setError(false);
    }).catch((reason) => { if (reason?.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, [attachment.size, attachment.url, expanded]);
  return <section className="attachment-text">
    <header><span>📄</span><bdi dir="auto">{attachment.filename}</bdi><small>{formatBytes(attachment.size)}</small>
      <a href={attachment.url} download={attachment.filename} title="Download">⭳</a></header>
    {error ? <div className="media-error">A safe text preview is not available.</div>
      : text === null ? <div className="text-preview-loading"><span className="spinner tiny" /> Loading preview…</div>
      : <pre dir="auto">{text}</pre>}
    {!error && attachment.size > PREVIEW_BYTES ? <footer>
      {!expanded ? <button onClick={() => setExpanded(true)}>View more</button> : null}
      {expanded && attachment.size > EXPANDED_BYTES ? <span>Preview limited to {formatBytes(EXPANDED_BYTES)}.</span> : null}
    </footer> : null}
  </section>;
}

function EncryptedContent({ message, currentUserId, mentionNames, onPollVote, onOpenImage, fa, showTtsButton, onDecrypted }: {
  message: Message; currentUserId: string; mentionNames?: Map<string, string>;
  onPollVote: (message: Message, optionId: string) => void;
  onOpenImage: (attachment: Attachment) => void; fa: boolean;
  showTtsButton: boolean;
  onDecrypted: (plaintext: string) => void;
}) {
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    decryptConversationMessage(message.content, message.conversationId!, currentUserId, message.authorId)
      .then((value) => { if (active) { setPlaintext(value); onDecrypted(value); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'رمزگشایی ناموفق بود.'); });
    return () => { active = false; };
  }, [currentUserId, message.authorId, message.content, message.conversationId, onDecrypted]);
  if (error) return <span className="e2ee-error" title={error}>🔒 امکان رمزگشایی این پیام روی این دستگاه وجود ندارد.</span>;
  if (plaintext === null) return <span className="e2ee-pending">🔒 در حال رمزگشایی…</span>;
  let text = plaintext;
  let encryptedAttachments: Array<EncryptedFileMetadata & { id: string }> = [];
  let encryptedPoll: { question: string; options: string[]; multiple: boolean; anonymous: boolean } | null = null;
  try {
    const payload = JSON.parse(plaintext);
    if (payload?.v === 1 && payload.kind === 'poll' && payload.poll && Array.isArray(payload.poll.options)) {
      text = '';
      encryptedPoll = payload.poll;
    } else if (payload?.v === 1 && typeof payload.text === 'string' && Array.isArray(payload.attachments)) {
      text = payload.text;
      encryptedAttachments = payload.attachments;
    }
  } catch { /* legacy encrypted messages contain plain text */ }
  return <>{text ? renderRichText(text, { mentionNames }) : null}{text && showTtsButton ? <LocalTtsButton text={text} /> : null}
    {encryptedAttachments.length ? <div className="attachments">{encryptedAttachments.map((meta) => {
      const attachment = message.attachments.find((item) => item.id === meta.id);
      return attachment ? <EncryptedAttachment key={meta.id} attachment={attachment} meta={meta} onOpenImage={onOpenImage} fa={fa} /> : null;
    })}</div> : null}
    {!encryptedAttachments.length && message.attachments.length ? (
      <div className="attachments">{message.attachments.map((attachment) => (
        <AttachmentView key={attachment.id} attachment={attachment} onOpenImage={onOpenImage} />
      ))}</div>
    ) : null}
    {encryptedPoll && message.poll ? <EncryptedPoll message={message} poll={encryptedPoll}
      currentUserId={currentUserId} onPollVote={onPollVote} fa={fa} /> : null}
  </>;
}

function EncryptedPoll({ message, poll, currentUserId, onPollVote, fa }: {
  message: Message;
  poll: { question: string; options: string[]; multiple: boolean; anonymous: boolean };
  currentUserId: string;
  onPollVote: (message: Message, optionId: string) => void;
  fa: boolean;
}) {
  const state = message.poll!;
  const total = state.options.reduce((sum, option) => sum + option.votes, 0);
  return <section className={`poll-card${state.closed ? ' poll-closed' : ''}`}>
    <header className="poll-card-head"><div className="poll-card-icon"><Icon name="lock" size={19} /></div>
      <div className="poll-card-title"><span className="poll-kicker">{fa ? 'نظرسنجی رمزنگاری‌شده' : 'ENCRYPTED POLL'}</span>
        <strong>{poll.question}</strong></div></header>
    <div className="poll-options">{state.options.map((option, index) => {
      const selected = state.viewerOptionIds?.includes(option.id) ?? option.userIds.includes(currentUserId);
      const percentage = total ? Math.round(option.votes / total * 100) : 0;
      return <button key={option.id} className={`poll-option${selected ? ' selected' : ''}`} disabled={state.closed}
        onClick={() => onPollVote(message, option.id)}><span className="poll-option-fill" style={{ width: `${percentage}%` }} />
        <span className={`poll-choice-mark${poll.multiple ? ' square' : ''}`}>{selected ? <Icon name="check" size={13} /> : null}</span>
        <span className="poll-option-label">{poll.options[index] ?? `#${index + 1}`}</span>
        <span className="poll-option-result"><strong>{percentage}%</strong><small>{option.votes}</small></span></button>;
    })}</div>
    <footer className="poll-card-foot"><span>🔒 {fa ? 'پرسش و گزینه‌ها سرتاسری رمز شده‌اند' : 'Question and choices are end-to-end encrypted'} · {total}</span></footer>
  </section>;
}

function EncryptedAttachment({ attachment, meta, onOpenImage, fa }: {
  attachment: Attachment;
  meta: EncryptedFileMetadata;
  onOpenImage: (attachment: Attachment) => void;
  fa: boolean;
}) {
  const autoDecode = meta.mime.startsWith('image/') || meta.mime.startsWith('video/') || meta.mime.startsWith('audio/');
  const [stage, setStage] = useState<DecryptedAttachmentStage | 'ready' | 'error'>('checking');
  const [progress, setProgress] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const decode = async () => {
    if (url) return;
    setError(null);
    setProgress(0);
    try {
      const result = await decryptAndCacheAttachment(attachment.id, attachment.url, meta, (nextStage, nextProgress) => {
        setStage(nextStage);
        setProgress(nextProgress);
      });
      const nextUrl = URL.createObjectURL(result.blob);
      setUrl(nextUrl);
      setPersisted(result.persisted);
      setFromCache(result.fromCache);
      setStage('ready');
      if (!autoDecode && !(isTextAttachment({ mime: meta.mime, filename: meta.name }))) {
        const link = document.createElement('a'); link.href = nextUrl; link.download = meta.name; link.click();
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Decryption failed.';
      setError(message);
      setStage('error');
      toast.error(fa ? 'رمزگشایی فایل ناموفق بود.' : 'Could not decrypt the file.');
    }
  };
  useEffect(() => {
    if (!autoDecode) {
      setStage('ready');
      return;
    }
    let active = true;
    void (async () => {
      try {
        const result = await decryptAndCacheAttachment(attachment.id, attachment.url, meta, (nextStage, nextProgress) => {
          if (active) {
            setStage(nextStage);
            setProgress(nextProgress);
          }
        });
        if (!active) return;
        setUrl(URL.createObjectURL(result.blob));
        setPersisted(result.persisted);
        setFromCache(result.fromCache);
        setStage('ready');
      } catch (reason) {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : 'Decryption failed.');
        setStage('error');
      }
    })();
    return () => { active = false; };
    // Encryption metadata is immutable for an attachment id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.id, attachment.url, autoDecode]);
  const clearAttachment: Attachment | null = url ? {
    ...attachment,
    filename: meta.name,
    mime: meta.mime,
    size: meta.size ?? attachment.size,
    url,
    previewUrl: null,
  } : null;
  if (clearAttachment && (clearAttachment.mime.startsWith('image/') || clearAttachment.mime.startsWith('video/') ||
      clearAttachment.mime.startsWith('audio/') || isTextAttachment(clearAttachment))) {
    const savedLabel = persisted
      ? (fromCache ? (fa ? 'از مرورگر بارگذاری شد' : 'Loaded from browser') : (fa ? 'رمزگشایی و در مرورگر ذخیره شد' : 'Decrypted and saved in browser'))
      : (fa ? 'رمزگشایی شد؛ ذخیره‌سازی مرورگر در دسترس نیست' : 'Decrypted; browser storage unavailable');
    return <div className="encrypted-preview"><span className={`encrypted-preview-label${persisted ? ' saved' : ''}`} role="status">🔒 ✓ {savedLabel}</span>
      <AttachmentView attachment={clearAttachment} onOpenImage={onOpenImage} /></div>;
  }
  const busy = stage === 'checking' || stage === 'decrypting' || stage === 'saving';
  const stateLabel = stage === 'checking'
    ? (fa ? 'در حال بررسی حافظه مرورگر…' : 'Checking browser storage…')
    : stage === 'decrypting'
      ? `${fa ? 'در حال رمزگشایی' : 'Decrypting'}… ${Math.round(progress * 100)}%`
      : stage === 'saving'
        ? (fa ? 'در حال ذخیره در مرورگر…' : 'Saving in browser…')
        : error
          ? (fa ? 'رمزگشایی ناموفق بود؛ دوباره تلاش کنید' : 'Decryption failed — try again')
          : formatBytes(meta.size ?? attachment.size);
  return <button className="attachment-file encrypted-file" disabled={busy} title={error ?? undefined} onClick={async () => {
    if (url) {
      const link = document.createElement('a'); link.href = url; link.download = meta.name; link.click();
      return;
    }
    await decode();
  }}><span className="icon">🔒</span><span className="info"><bdi className="name" dir="auto">{meta.name}</bdi>
    <span className="size" aria-live="polite">{stateLabel}</span>
    {busy ? <span className="decrypt-progress"><i style={{ width: `${progress * 100}%` }} /></span> : null}</span></button>;
}

function FishTtsButton({ text, fa }: { text: string; fa: boolean }) {
  const [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  useEffect(() => () => { audio.current?.pause(); if (url.current) URL.revokeObjectURL(url.current); }, []);
  return <button disabled={busy} onClick={async () => {
    if (busy) return;
    setBusy(true);
    try {
      audio.current?.pause();
      if (url.current) URL.revokeObjectURL(url.current);
      const blob = await api.postBlob('/api/tts', { text: text.slice(0, 2000) });
      url.current = URL.createObjectURL(blob);
      audio.current = new Audio(url.current);
      await audio.current.play();
    } catch (error) { toast.error(error instanceof ApiError ? error.message : (fa ? 'ساخت صدا ناموفق بود.' : 'Could not generate speech.')); }
    finally { setBusy(false); }
  }} title={fa ? 'خواندن با Fish Audio' : 'Read with Fish Audio'} aria-label={fa ? 'خواندن با Fish Audio' : 'Read with Fish Audio'}><Icon name="speaker" size={16} /></button>;
}

function LocalTtsButton({ text }: { text: string }) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  return <button className="e2ee-local-tts" onClick={() => { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); }} title="خواندن امن روی این دستگاه"><Icon name="speaker" size={15} /></button>;
}

export const MessageItem = memo(MessageItemInner, (previous, next) => {
  const previousGroupingKey = previous.previous
    ? `${previous.previous.id}:${previous.previous.authorId}:${previous.previous.type}:${previous.previous.createdAt}`
    : '';
  const nextGroupingKey = next.previous
    ? `${next.previous.id}:${next.previous.authorId}:${next.previous.type}:${next.previous.createdAt}`
    : '';
  return previous.message === next.message &&
    previousGroupingKey === nextGroupingKey &&
    previous.currentUserId === next.currentUserId &&
    previous.currentUsername === next.currentUsername &&
    previous.canModerate === next.canModerate &&
    previous.canPin === next.canPin &&
    previous.canPublish === next.canPublish &&
    previous.isSaved === next.isSaved &&
    previous.mentionNames === next.mentionNames;
});
