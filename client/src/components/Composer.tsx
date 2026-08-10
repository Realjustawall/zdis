import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { formatBytes } from '../lib/format';
import { toast } from '../store/toast';
import { useSession } from '../store/session';
import type { Attachment, GroupExpression, Message, PublicUser, ServerRole } from '../types';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';

interface Props {
  targetPath: string;
  groupId?: string;
  channelId?: string;
  placeholder: string;
  disabled?: boolean;
  replyTo: Message | null;
  editing: Message | null;
  members: PublicUser[];
  roles?: ServerRole[];
  secureMode?: boolean;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSend: (body: {
    content: string;
    replyToId?: string | null;
    attachmentIds: string[];
    expiresInSeconds?: number | null;
    tts?: boolean;
    encryptedAttachments?: EncryptedAttachmentMeta[];
  }) => Promise<void>;
  onEncrypt?: (content: string, attachments?: EncryptedAttachmentMeta[]) => Promise<string>;
  onPollCreated: (message: Message) => void;
  onSaveEdit: (messageId: string, content: string) => Promise<void>;
  onTyping: () => void;
  onStopTyping: () => void;
  typingLabel: string | null;
}

export interface EncryptedAttachmentMeta {
  id: string;
  name: string;
  mime: string;
  key: string;
  iv: string;
}

type PendingAttachment = Attachment & { encryption?: EncryptedAttachmentMeta };

function base64url(bytes: ArrayBuffer | Uint8Array) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function encryptUploadFile(file: File) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer());
  const marker = new TextEncoder().encode('ZDISENC1');
  return {
    file: new File([marker, ciphertext], `${file.name}.zdis`, { type: 'application/vnd.zdis.encrypted' }),
    metadata: { id: '', name: file.name, mime: file.type || 'application/octet-stream',
      key: base64url(await crypto.subtle.exportKey('raw', key)), iv: base64url(iv) } as EncryptedAttachmentMeta,
  };
}

const EMOJI = [
  '😀', '😂', '🥲', '😊', '😍', '🤩', '😎', '🤔',
  '😴', '🤯', '😭', '😡', '👍', '👎', '👏', '🙏',
  '💪', '🔥', '✨', '🎉', '🎬', '🎥', '📈', '📉',
  '💡', '✅', '❌', '⚠️', '❤️', '💜', '👀', '🚀',
  '🙂', '🙃', '😉', '😌', '😋', '😜', '🤪', '🤗', '🫡', '🤭', '🫢', '🫣',
  '🫠', '🤫', '🤔', '🫡', '😐', '😑', '😶', '🫥', '🙄', '😬', '😮‍💨', '🤥',
  '😏', '😒', '🙃', '😣', '😥', '😮', '🤐', '😯', '😪', '🥱', '😓', '😔',
  '🤤', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯',
  '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '🫤', '😟', '🙁', '☹️', '😖',
  '😫', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '😱', '😨', '😰', '😥',
  '🤩', '🥰', '😍', '🤗', '🫶', '💔', '❤️‍🔥', '❤️‍🩹', '💯', '💢', '💥', '💫',
  '⭐', '🌟', '✨', '⚡', '☀️', '🌈', '❄️', '🌙', '🌍', '🌸', '🌻', '🌹',
  '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮',
  '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧', '🐦', '🦄', '🐝', '🦋',
  '🍎', '🍊', '🍋', '🍉', '🍇', '🍓', '🍒', '🥑', '🍕', '🍔', '🍟', '🌮',
  '🍿', '🍩', '🍪', '🎂', '☕', '🍵', '🥤', '🍺', '🍷', '🥂', '🍹', '🍸',
  '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🎮', '🎯', '🎲', '🎨', '🎵', '🎶',
  '🚗', '🚕', '🚌', '🚓', '🚑', '🚒', '✈️', '🚀', '🚲', '🏠', '💻', '📱',
  '🔒', '🔑', '🔔', '🔕', '📌', '📎', '✏️', '📚', '💰', '🎁', '🏆', '🛡️',
  '🙏', '👏', '🙌', '🤝', '✍️', '💪', '👋', '🤞', '✌️', '🤟', '🤘', '👌',
];

export function Composer({
  targetPath,
  groupId,
  channelId,
  placeholder,
  disabled,
  replyTo,
  editing,
  members,
  roles = [],
  secureMode = false,
  onCancelReply,
  onCancelEdit,
  onSend,
  onEncrypt,
  onPollCreated,
  onSaveEdit,
  onTyping,
  onStopTyping,
  typingLabel,
}: Props) {
  const settings = useSession((state) => state.settings);
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const [text, setText] = useState('');
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState('');
  const [codeOpen, setCodeOpen] = useState(false);
  const [expressions, setExpressions] = useState<GroupExpression[]>([]);
  const [commands, setCommands] = useState<
    { id: string; name: string; description: string | null; botName: string }[]
  >([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [expiresInSeconds, setExpiresInSeconds] = useState<number | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [pollMultiple, setPollMultiple] = useState(false);
  const [pollAnonymous, setPollAnonymous] = useState(false);
  const [pollExamMode, setPollExamMode] = useState(false);
  const [pollCorrectIndex, setPollCorrectIndex] = useState(0);
  const [pollDurationHours, setPollDurationHours] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStartedRef = useRef(0);
  const recordingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!groupId) {
      setExpressions([]);
      return;
    }
    let active = true;
    void Promise.all([
      api.get<{ expressions: GroupExpression[] }>(`/api/groups/${groupId}/expressions`),
      api
        .get<{ expressions: GroupExpression[] }>(
          `/api/groups/${groupId}/external-expressions`,
        )
        .catch(() => ({ expressions: [] })),
    ])
      .then(([local, external]) => {
        if (active) setExpressions([...local.expressions, ...external.expressions]);
      })
      .catch(() => {
        if (active) setExpressions([]);
      });
    return () => {
      active = false;
    };
  }, [groupId]);

  useEffect(() => {
    if (!groupId) {
      setCommands([]);
      return;
    }
    let active = true;
    void api
      .get<{ commands: typeof commands }>(`/api/integrations/groups/${groupId}/commands`)
      .then((data) => {
        if (active) setCommands(data.commands);
      })
      .catch(() => {
        if (active) setCommands([]);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  useEffect(() => {
    if (editing) {
      setText(editing.content);
      textareaRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    let active = true;
    setDraftReady(false);
    setText('');
    setPending([]);
    if (secureMode) {
      setText(localStorage.getItem(`zdis.secure-draft:${targetPath}`) ?? '');
      setDraftReady(true);
      return () => { active = false; };
    }
    void api
      .get<{ draft: { content: string } | null }>(`${targetPath}/draft`)
      .then((result) => {
        if (!active) return;
        setText(result.draft?.content ?? '');
        setDraftReady(true);
      })
      .catch(() => {
        if (active) setDraftReady(true);
      });
    return () => {
      active = false;
    };
  }, [secureMode, targetPath]);

  useEffect(() => {
    if (!draftReady || editing) return;
    const timer = window.setTimeout(() => {
      if (secureMode) {
        if (text.trim()) localStorage.setItem(`zdis.secure-draft:${targetPath}`, text);
        else localStorage.removeItem(`zdis.secure-draft:${targetPath}`);
        return;
      }
      if (!text.trim() && !replyTo && pending.length === 0) {
        void api.del(`${targetPath}/draft`).catch(() => {});
      } else {
        void api
          .put(`${targetPath}/draft`, {
            content: text,
            replyToId: replyTo?.id ?? null,
            attachmentIds: pending.map((item) => item.id),
          })
          .catch(() => {});
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draftReady, editing, pending, replyTo, secureMode, targetPath, text]);

  // Auto-grow the textarea up to the CSS max-height.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [text]);

  useEffect(
    () => () => {
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const uploadsEnabled = settings?.uploads_enabled ?? false;
  const maxMb = settings?.max_upload_mb ?? 10;
  const uploadLimitEnabled = settings?.upload_limit_enabled ?? true;

  function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setText(value);
    if (value.trim()) onTyping();

    // Mention autocomplete on the token under the caret.
    const upToCaret = value.slice(0, event.target.selectionStart ?? value.length);
    const match = /(?:^|\s)@([a-z0-9._-]*)$/i.exec(upToCaret);
    setMentionQuery(match ? match[1].toLowerCase() : null);
  }

  const mentionMatches: {
    id: string;
    displayName: string;
    subtitle: string;
    token: string;
    kind: 'member' | 'role';
  }[] =
    mentionQuery === null
      ? []
      : [
          ...members
          .filter(
            (member) =>
              member.username.startsWith(mentionQuery) ||
              member.displayName.toLowerCase().includes(mentionQuery),
          )
          .map((member) => ({
            id: member.id,
            displayName: member.displayName,
            subtitle: `@${member.username}`,
            token: `@${member.username}`,
            kind: 'member' as const,
          })),
          ...roles
            .filter(
              (role) =>
                !role.isDefault &&
                role.mentionable &&
                role.name.toLowerCase().includes(mentionQuery),
            )
            .map((role) => ({
              id: role.id,
              displayName: role.name,
              subtitle: 'Role mention',
              token: `<@&${role.id}>`,
              kind: 'role' as const,
            })),
        ].slice(0, 8);

  function applyMention(token: string) {
    const node = textareaRef.current;
    if (!node) return;
    const caret = node.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([a-z0-9._-]*)$/i, `${token} `);
    const next = before + text.slice(caret);
    setText(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(before.length, before.length);
    });
  }

  function insertAtCaret(token: string, closePicker = false) {
    const node = textareaRef.current;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? start;
    const next = text.slice(0, start) + token + text.slice(end);
    const caret = start + token.length;
    setText(next);
    setMentionQuery(null);
    if (closePicker) setEmojiOpen(false);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(caret, caret);
    });
  }

  function insertCodeBlock(language = '') {
    const node = textareaRef.current;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? start;
    const selected = text.slice(start, end);
    const prefix = start > 0 && !text.slice(0, start).endsWith('\n') ? '\n' : '';
    const suffix = end < text.length && !text.slice(end).startsWith('\n') ? '\n' : '';
    const opening = `\`\`\`${language}\n`;
    const block = `${prefix}${opening}${selected}\n\`\`\`${suffix}`;
    const next = text.slice(0, start) + block + text.slice(end);
    const caret = start + prefix.length + opening.length + selected.length;
    setText(next);
    setCodeOpen(false);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(caret, caret);
    });
  }

  async function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      insertCodeBlock();
      return;
    }
    if (event.key === 'Escape') {
      if (editing) onCancelEdit();
      else if (replyTo) onCancelReply();
      else if (mentionQuery !== null) setMentionQuery(null);
      return;
    }
    if (mentionQuery !== null && event.key === 'Tab' && mentionMatches[0]) {
      event.preventDefault();
      applyMention(mentionMatches[0].token);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      await submit();
    }
  }

  async function submit() {
    const rawContent = text.trim();
    const tts = !secureMode && /^\/tts(?:\s|$)/i.test(rawContent);
    const content = tts ? rawContent.replace(/^\/tts(?:\s+|$)/i, '').trim() : rawContent;
    if (!content && pending.length === 0) return;
    if (sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    try {
      const slash = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(content);
      const command = slash
        ? commands.find((item) => item.name.toLowerCase() === slash[1].toLowerCase())
        : null;
      if (!editing && command && channelId) {
        const data = await api.post<{ message: Message }>(
          `/api/integrations/commands/${command.id}/execute`,
          { channelId, arguments: slash?.[2] ?? '' },
        );
        onPollCreated(data.message);
        setText('');
        onStopTyping();
        return;
      }
      if (editing) {
        await onSaveEdit(editing.id, content);
        onCancelEdit();
      } else {
        await onSend({
          content,
          replyToId: replyTo?.id ?? null,
          attachmentIds: pending.map((item) => item.id),
          expiresInSeconds,
          tts,
          encryptedAttachments: pending.flatMap((item) => item.encryption ? [item.encryption] : []),
        });
        setPending([]);
        onCancelReply();
        if (secureMode) localStorage.removeItem(`zdis.secure-draft:${targetPath}`);
        else void api.del(`${targetPath}/draft`).catch(() => {});
      }
      setText('');
      onStopTyping();
    } catch (error) {
      toast.error(
        error instanceof ApiError || error instanceof Error
          ? error.message
          : (fa ? 'ارسال پیام انجام نشد.' : 'Could not send that message.'),
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function schedule() {
    const content = text.trim();
    if (!content && pending.length === 0) return;
    const minutesInput = window.prompt(fa ? 'پیام چند دقیقه دیگر ارسال شود؟' : 'Send in how many minutes?', '10');
    if (minutesInput === null) return;
    const minutes = Number(minutesInput);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      toast.error(fa ? 'یک تعداد دقیقه مثبت وارد کنید.' : 'Enter a positive number of minutes.');
      return;
    }

    setSending(true);
    try {
      const sendAt = Date.now() + Math.round(minutes * 60_000);
      const scheduledContent = secureMode
        ? await onEncrypt?.(content, pending.flatMap((item) => item.encryption ? [item.encryption] : []))
        : content;
      if (secureMode && !scheduledContent) throw new Error('Encryption is not available for this conversation.');
      await api.post(`${targetPath}/scheduled`, {
        content: scheduledContent,
        encrypted: secureMode,
        replyToId: replyTo?.id ?? null,
        attachmentIds: pending.map((item) => item.id),
        sendAt,
        expiresAt: expiresInSeconds ? sendAt + expiresInSeconds * 1000 : null,
      });
      setText('');
      setPending([]);
      onCancelReply();
      onStopTyping();
      void api.del(`${targetPath}/draft`).catch(() => {});
      toast.success(`Message scheduled for ${new Date(sendAt).toLocaleString()}.`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'زمان‌بندی پیام انجام نشد.' : 'Could not schedule the message.'));
    } finally {
      setSending(false);
    }
  }

  async function createPoll() {
    const question = pollQuestion.trim();
    const populatedOptions = pollOptions.map((choice, originalIndex) => ({ choice: choice.trim(), originalIndex })).filter((item) => item.choice);
    const options = populatedOptions.map((item) => item.choice);
    if (!question) { toast.error(fa ? 'پرسش نظرسنجی را وارد کنید.' : 'Enter a poll question.'); return; }
    if (options.length < 2 || options.length > 10) {
      toast.error(fa ? 'نظرسنجی باید بین ۲ تا ۱۰ گزینه داشته باشد.' : 'A poll needs between 2 and 10 choices.');
      return;
    }
    const correctIndex = populatedOptions.findIndex((item) => item.originalIndex === pollCorrectIndex);
    if (!secureMode && pollExamMode && correctIndex < 0) {
      toast.error(fa ? 'یک پاسخ صحیح انتخاب کنید.' : 'Choose the correct answer.');
      return;
    }

    setSending(true);
    try {
      const encryptedPoll = secureMode
        ? await onEncrypt?.(JSON.stringify({ v: 1, kind: 'poll', poll: {
            question, options, multiple: pollMultiple, anonymous: pollAnonymous,
            examMode: false, correctIndex: null,
          } }))
        : undefined;
      if (secureMode && !encryptedPoll) throw new Error('Encryption is not available for this conversation.');
      const data = await api.post<{ message: Message }>(`${targetPath}/polls`, {
        question: secureMode ? '🔒' : question.trim(),
        options: secureMode ? options.map((_, index) => `option-${index + 1}`) : options,
        encrypted: secureMode,
        content: encryptedPoll,
        multiple: pollMultiple,
        anonymous: pollAnonymous,
        examMode: secureMode ? false : pollExamMode,
        correctOptionIndexes: secureMode ? [] : pollExamMode ? [correctIndex] : [],
        closesAt: pollDurationHours ? Date.now() + pollDurationHours * 60 * 60_000 : null,
      });
      onPollCreated(data.message);
      setText('');
      setPollOpen(false);
      setPollQuestion('');
      setPollOptions(['', '']);
      setPollMultiple(false);
      setPollAnonymous(false);
      setPollExamMode(false);
      setPollCorrectIndex(0);
      setPollDurationHours(0);
      void api.del(`${targetPath}/draft`).catch(() => {});
      toast.success(fa ? 'نظرسنجی ساخته شد.' : 'Poll created.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'ساخت نظرسنجی انجام نشد.' : 'Could not create the poll.'));
    } finally {
      setSending(false);
    }
  }

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;

    if (pending.length + files.length > 10) {
      toast.error(fa ? 'به هر پیام حداکثر ۱۰ فایل می‌توانید پیوست کنید.' : 'You can attach at most 10 files to one message.');
      return;
    }

    setUploading(true);
    for (const file of files) {
      if (uploadLimitEnabled && file.size > maxMb * 1024 * 1024) {
        toast.error(fa
          ? `${file.name} برابر ${formatBytes(file.size)} است؛ سقف مجاز ${maxMb} مگابایت است.`
          : `${file.name} is ${formatBytes(file.size)} — the limit is ${maxMb} MB.`);
        continue;
      }
      try {
        const form = new FormData();
        let uploadFile = file;
        let encryption: EncryptedAttachmentMeta | undefined;
        if (secureMode) {
          const encrypted = await encryptUploadFile(file);
          uploadFile = encrypted.file;
          encryption = encrypted.metadata;
        }
        form.append('file', uploadFile);
        const data = await api.post<{ attachment: Attachment }>('/api/files', form);
        setPending((current) => [...current, { ...data.attachment,
          encryption: encryption ? { ...encryption, id: data.attachment.id } : undefined }]);
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : (fa ? `بارگذاری ${file.name} انجام نشد.` : `Could not upload ${file.name}.`));
      }
    }
    setUploading(false);
  }

  async function startVoiceMessage() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error('Voice recording is not supported by this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recordingStreamRef.current = stream;
      recorderRef.current = recorder;
      recordingChunksRef.current = [];
      recordingStartedRef.current = Date.now();
      setRecordingMs(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const durationMs = Date.now() - recordingStartedRef.current;
        const blob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        if (durationMs < 250 || !blob.size) return;
        setUploading(true);
        try {
          const extension = blob.type.includes('ogg') ? 'ogg' : 'webm';
          const form = new FormData();
          const voiceFile = new File([blob], `voice-message.${extension}`, { type: blob.type });
          const encrypted = secureMode ? await encryptUploadFile(voiceFile) : null;
          form.append('file', encrypted?.file ?? voiceFile);
          if (!secureMode) form.append('durationMs', String(durationMs));
          const data = await api.post<{ attachment: Attachment }>(secureMode ? '/api/files' : '/api/files/voice', form);
          setPending((current) => [...current, { ...data.attachment,
            encryption: encrypted ? { ...encrypted.metadata, id: data.attachment.id } : undefined }]);
        } catch (error) {
          toast.error(error instanceof ApiError ? error.message : 'Could not upload the voice message.');
        } finally {
          setUploading(false);
        }
      };
      recorder.start(250);
      setRecording(true);
      recordingTimerRef.current = window.setInterval(
        () => setRecordingMs(Date.now() - recordingStartedRef.current),
        250,
      );
    } catch {
      toast.error('Microphone permission is required to record a voice message.');
    }
  }

  function stopVoiceMessage() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  const busy = disabled || sending;

  return (
    <div className="composer-wrap">
      {pending.length > 0 ? (
        <div className="pending-attachments">
          {pending.map((attachment) => (
            <div className="pending-chip" key={attachment.id}>
              {attachment.mime.startsWith('image/') ? (
                <img src={attachment.url} alt="" />
              ) : (
                <span>📄</span>
              )}
              <span className="name">{attachment.encryption?.name ?? attachment.filename}</span>
              <span className="faint small">{formatBytes(attachment.size)}</span>
              <button
                onClick={() => setPending((current) => current.filter((item) => item.id !== attachment.id))}
                title={fa ? 'حذف' : 'Remove'}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {editing ? (
        <div className="composer-context">
          <span>✎ {fa ? 'در حال ویرایش پیام' : 'Editing message'}</span>
          <span className="spacer" />
          <button className="btn ghost small" onClick={onCancelEdit}>
            {fa ? 'انصراف' : 'Cancel'}
          </button>
        </div>
      ) : replyTo ? (
        <div className="composer-context">
          <span>
            ↩ {fa ? 'پاسخ به' : 'Replying to'} <strong>{replyTo.author?.displayName ?? (fa ? 'یک نفر' : 'someone')}</strong>
          </span>
          <span className="spacer" />
          <button className="btn ghost small" onClick={onCancelReply}>
            {fa ? 'انصراف' : 'Cancel'}
          </button>
        </div>
      ) : null}

      <div
        className={`composer${editing || replyTo || pending.length ? ' has-context' : ''}`}
        style={{ position: 'relative' }}
      >
        {uploadsEnabled ? (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={onFiles}
              accept="image/*,video/*,audio/*,.pdf,.zip,.txt,.json"
            />
            <button
              className="composer-btn"
              onClick={() => fileRef.current?.click()}
              disabled={busy || uploading}
              title={secureMode ? (fa ? 'پیوست فایل با رمزنگاری سرتاسری' : 'Attach an end-to-end encrypted file') : uploadLimitEnabled ? (fa ? `پیوست فایل (حداکثر ${maxMb} مگابایت)` : `Attach a file (max ${maxMb} MB)`) : (fa ? 'پیوست فایل (بدون محدودیت سفارشی)' : 'Attach a file (no custom limit)')}
            >
              {uploading ? <span className="spinner tiny" /> : <Icon name="add" size={21} />}
            </button>
            <button
              className={`composer-btn${recording ? ' danger' : ''}`}
              onClick={() => recording ? stopVoiceMessage() : void startVoiceMessage()}
              disabled={busy || uploading}
              title={recording ? 'Stop voice recording' : secureMode ? 'Record an end-to-end encrypted voice message' : 'Record voice message'}
            >
              {recording ? <span className="recording-time">■ {Math.floor(recordingMs / 1000)}s</span> : <Icon name="microphone" size={19} />}
            </button>
          </>
        ) : null}

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={onStopTyping}
          disabled={busy}
          maxLength={4000}
        />

        <button
          className={`composer-btn${codeOpen ? ' active' : ''}`}
          onClick={() => {
            setCodeOpen((open) => !open);
            setEmojiOpen(false);
          }}
          disabled={busy}
          title={fa ? 'ارسال قطعه‌کد' : 'Send a code block'}
        >
          <Icon name="code" size={20} />
        </button>
        <button
          className="composer-btn"
          onClick={() => {
            setEmojiOpen((open) => !open);
            setEmojiQuery('');
            setCodeOpen(false);
          }}
          disabled={busy}
          title={fa ? 'شکلک' : 'Emoji'}
        >
          <Icon name="smile" size={20} />
        </button>
        {!editing ? (
          <>
            <button
              className="composer-btn composer-poll"
              onClick={() => { setPollQuestion(text.trim()); setPollOpen(true); }}
              disabled={busy}
              title={secureMode ? (fa ? 'ساخت نظرسنجی رمزنگاری‌شده' : 'Create an encrypted poll') : fa ? 'ساخت نظرسنجی' : 'Create poll'}
            >
              <Icon name="poll" size={19} />
            </button>
            <button
              className="composer-btn composer-schedule"
              onClick={() => void schedule()}
              disabled={busy || (!text.trim() && pending.length === 0)}
              title={fa ? 'زمان‌بندی پیام' : 'Schedule message'}
            >
              <Icon name="calendar" size={18} />
            </button>
          </>
        ) : null}
        <button
          className="composer-btn send"
          onClick={submit}
          disabled={busy || (!text.trim() && pending.length === 0)}
          title={fa ? 'ارسال (Enter)' : 'Send (Enter)'}
        >
          <Icon name="send" size={19} />
        </button>

        {emojiOpen ? (
          <div className="emoji-popover emoji-picker" role="dialog" aria-label={fa ? 'انتخاب شکلک' : 'Choose an emoji'}>
            <div className="emoji-picker-head">
              <strong>{fa ? 'شکلک‌ها' : 'Emoji'}</strong>
              <button type="button" onClick={() => setEmojiOpen(false)} aria-label={fa ? 'بستن' : 'Close'}>
                <Icon name="close" size={15} />
              </button>
            </div>
            <label className="emoji-search">
              <Icon name="search" size={15} />
              <input
                value={emojiQuery}
                onChange={(event) => setEmojiQuery(event.target.value.toLowerCase())}
                placeholder={fa ? 'جست‌وجوی شکلک سفارشی…' : 'Search custom emoji…'}
                autoFocus
              />
            </label>
            {!emojiQuery ? <div className="emoji-section-title">{fa ? 'پرکاربرد' : 'Frequently used'}</div> : null}
            <div className="emoji-grid">
              {!emojiQuery ? EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    insertAtCaret(emoji);
                  }}
                >
                  {emoji}
                </button>
              )) : null}
              {expressions.filter((expression) =>
                expression.type === 'emoji' &&
                (!emojiQuery || expression.name.includes(emojiQuery) || expression.sourceGroupName?.toLowerCase().includes(emojiQuery)),
              ).map((expression) => (
                <button
                  key={`${expression.groupId}:${expression.id}`}
                  type="button"
                  title={`${expression.sourceGroupName ? `${expression.sourceGroupName} · ` : ''}:${expression.name}:`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    insertAtCaret(`<:${expression.name}:${expression.attachmentId}>`);
                  }}
                >
                  <img className="custom-emoji" src={expression.url} alt={`:${expression.name}:`} />
                </button>
              ))}
            </div>
            {!emojiQuery && expressions.some((expression) => expression.type === 'sticker') ? (
              <>
                <div className="section-label" style={{ padding: '8px 4px 4px' }}>Stickers</div>
                <div className="emoji-grid">
                  {expressions.filter((expression) => expression.type === 'sticker').map((expression) => (
                    <button
                      key={expression.id}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      title={`${expression.sourceGroupName ? `${expression.sourceGroupName} · ` : ''}${expression.name}`}
                      onClick={() => {
                        insertAtCaret(`<sticker:${expression.name}:${expression.attachmentId}>`, true);
                      }}
                    >
                      <img className="custom-emoji" src={expression.url} alt={expression.name} />
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {!emojiQuery && expressions.some((expression) => expression.type === 'sound') ? (
              <>
                <div className="section-label" style={{ padding: '8px 4px 4px' }}>Sounds</div>
                <div className="col" style={{ gap: 4 }}>
                  {expressions.filter((expression) => expression.type === 'sound').map((expression) => (
                    <button
                      className="btn small"
                      key={expression.id}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        insertAtCaret(`<sound:${expression.name}:${expression.attachmentId}>`, true);
                      }}
                    >
                      🔊 {expression.name}
                      {expression.sourceGroupName ? ` · ${expression.sourceGroupName}` : ''}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {codeOpen ? (
          <div className="code-composer-popover">
            <div>
              <strong>{fa ? 'ارسال کد' : 'Send code'}</strong>
              <small>
                {fa
                  ? 'زبان را انتخاب کنید؛ متن انتخاب‌شده داخل قطعه‌کد قرار می‌گیرد.'
                  : 'Choose a language. Selected text will be wrapped in a code block.'}
              </small>
            </div>
            <div className="code-language-grid">
              {[
                ['', fa ? 'متن ساده' : 'Plain text'],
                ['javascript', 'JavaScript'],
                ['typescript', 'TypeScript'],
                ['python', 'Python'],
                ['html', 'HTML'],
                ['css', 'CSS'],
                ['json', 'JSON'],
                ['sql', 'SQL'],
                ['bash', 'Bash'],
                ['php', 'PHP'],
                ['java', 'Java'],
                ['cpp', 'C++'],
              ].map(([language, label]) => (
                <button key={language || 'plain'} type="button" onClick={() => insertCodeBlock(language)}>
                  <Icon name="code" size={15} />
                  {label}
                </button>
              ))}
            </div>
            <span>{fa ? 'میانبر: Ctrl + Shift + C' : 'Shortcut: Ctrl + Shift + C'}</span>
          </div>
        ) : null}

        {mentionMatches.length > 0 ? (
          <div className="emoji-popover" style={{ left: 0, right: 'auto', width: 260 }}>
            {mentionMatches.map((mention) => (
              <button
                key={`${mention.kind}:${mention.id}`}
                className="picker-row"
                style={{ border: 'none' }}
                onClick={() => applyMention(mention.token)}
              >
                <span className="info">
                  <span className="name">{mention.kind === 'role' ? '🏷️ ' : ''}{mention.displayName}</span>
                  <span className="sub">{mention.subtitle}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {text.startsWith('/') && !text.includes(' ') && commands.length > 0 ? (
          <div className="emoji-popover" style={{ left: 0, right: 'auto', width: 320 }}>
            {commands
              .filter((command) => command.name.startsWith(text.slice(1).toLowerCase()))
              .slice(0, 8)
              .map((command) => (
                <button
                  key={command.id}
                  className="picker-row"
                  style={{ border: 'none' }}
                  onClick={() => {
                    setText(`/${command.name} `);
                    textareaRef.current?.focus();
                  }}
                >
                  <span className="info">
                    <span className="name">/{command.name}</span>
                    <span className="sub">{command.description ?? command.botName}</span>
                  </span>
                </button>
              ))}
          </div>
        ) : null}
      </div>

      <div className="composer-foot">
        <span>
          {typingLabel ? (
            <span className="typing-line">
              <span className="typing-dots">
                <span />
                <span />
                <span />
              </span>
              {typingLabel}
            </span>
          ) : null}
        </span>
        <span>
          {!editing ? (
            <label style={{ marginRight: 12 }}>
              {fa ? 'انقضا' : 'Expiry'}{' '}
              <select
                value={expiresInSeconds ?? ''}
                onChange={(event) =>
                  setExpiresInSeconds(event.target.value ? Number(event.target.value) : null)
                }
                aria-label={fa ? 'انقضای پیام' : 'Message expiry'}
              >
                <option value="">{fa ? 'هرگز' : 'Never'}</option>
                <option value="300">{fa ? '۵ دقیقه' : '5 min'}</option>
                <option value="3600">{fa ? '۱ ساعت' : '1 hour'}</option>
                <option value="86400">{fa ? '۱ روز' : '1 day'}</option>
                <option value="604800">{fa ? '۷ روز' : '7 days'}</option>
              </select>
            </label>
          ) : null}
          {text.length > 3600 ? `${text.length} / 4000` : ''}
          {text.length <= 3600 && !typingLabel
            ? (fa ? 'Enter برای ارسال · Shift+Enter برای خط جدید' : 'Enter to send · Shift+Enter for a new line')
            : ''}
        </span>
      </div>
      {pollOpen ? (
        <div className="poll-popover" role="dialog" aria-label={fa ? 'ساخت نظرسنجی' : 'Create poll'}>
          <div className="poll-popover-head">
            <div className="poll-popover-title"><span><Icon name="poll" size={18} /></span><div><strong>{fa ? 'ساخت نظرسنجی' : 'Create a poll'}</strong><small>{fa ? 'نظر جامعه را سریع دریافت کنید' : 'Get the community’s pulse'}</small></div></div>
            <button type="button" onClick={() => setPollOpen(false)} aria-label={fa ? 'بستن' : 'Close'}>×</button>
          </div>
          <div className="poll-builder-body">
            <label className="poll-builder-field"><span>{fa ? 'پرسش' : 'Question'} <small>{pollQuestion.length}/300</small></span><input value={pollQuestion} placeholder={fa ? 'چه چیزی می‌خواهید بدانید؟' : 'What would you like to ask?'} onChange={(event) => setPollQuestion(event.target.value)} maxLength={300} autoFocus /></label>
            <div className="poll-builder-options">
              <div className="poll-builder-section-title"><strong>{fa ? 'گزینه‌های پاسخ' : 'Answer options'}</strong><small>{pollOptions.length}/10</small></div>
              {pollOptions.map((option, index) => (
                <div className={`poll-builder-option${pollExamMode ? ' exam' : ''}`} key={index}>
                  <span>{index + 1}</span>
                  <input value={option} placeholder={`${fa ? 'گزینه' : 'Option'} ${index + 1}`} maxLength={120} onChange={(event) => setPollOptions((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
                  {pollExamMode ? <button className={`poll-correct-answer${pollCorrectIndex === index ? ' selected' : ''}`} onClick={() => setPollCorrectIndex(index)} title={fa ? 'علامت‌گذاری به عنوان پاسخ صحیح' : 'Mark as correct answer'}><Icon name="check" size={14} /></button> : null}
                  {pollOptions.length > 2 ? <button onClick={() => { setPollOptions((current) => current.filter((_, itemIndex) => itemIndex !== index)); setPollCorrectIndex((current) => current === index ? 0 : current > index ? current - 1 : current); }} aria-label={fa ? 'حذف گزینه' : 'Remove option'}>×</button> : null}
                </div>
              ))}
              <button className="poll-add-option" onClick={() => setPollOptions((current) => current.length < 10 ? [...current, ''] : current)} disabled={pollOptions.length >= 10}><Icon name="add" size={15} /> {fa ? 'افزودن گزینه' : 'Add another option'}</button>
            </div>
            <div className="poll-builder-settings">
              <label className="poll-setting poll-exam-setting"><div><strong>{fa ? 'حالت آزمون' : 'Exam mode'}</strong><small>{secureMode ? (fa ? 'در نظرسنجی سرتاسری در دسترس نیست' : 'Unavailable for end-to-end encrypted polls') : (fa ? 'یک پاسخ صحیح و فقط یک تلاش برای هر نفر' : 'One correct answer and one attempt per person')}</small></div><input type="checkbox" checked={pollExamMode} disabled={secureMode} onChange={(event) => { setPollExamMode(event.target.checked); if (event.target.checked) setPollMultiple(false); }} /></label>
              <label className="poll-setting"><div><strong>{fa ? 'چند انتخابی' : 'Multiple choice'}</strong><small>{fa ? 'کاربران می‌توانند چند گزینه را انتخاب کنند' : 'People can select more than one answer'}</small></div><input type="checkbox" checked={pollMultiple} disabled={pollExamMode} onChange={(event) => setPollMultiple(event.target.checked)} /></label>
              <label className="poll-setting"><div><strong>{fa ? 'رأی ناشناس' : 'Anonymous voting'}</strong><small>{fa ? 'هویت رأی‌دهندگان مخفی می‌ماند' : 'Keep voter identities private'}</small></div><input type="checkbox" checked={pollAnonymous} onChange={(event) => setPollAnonymous(event.target.checked)} /></label>
              <label className="poll-duration"><span>{fa ? 'بستن خودکار' : 'Auto-close'}</span><select value={pollDurationHours} onChange={(event) => setPollDurationHours(Number(event.target.value))}><option value="0">{fa ? 'هرگز' : 'Never'}</option><option value="1">{fa ? 'پس از ۱ ساعت' : 'In 1 hour'}</option><option value="6">{fa ? 'پس از ۶ ساعت' : 'In 6 hours'}</option><option value="24">{fa ? 'پس از ۱ روز' : 'In 1 day'}</option><option value="72">{fa ? 'پس از ۳ روز' : 'In 3 days'}</option><option value="168">{fa ? 'پس از ۱ هفته' : 'In 1 week'}</option></select></label>
            </div>
          </div>
          <div className="poll-popover-foot">
            <button className="btn ghost small" onClick={() => setPollOpen(false)}>{fa ? 'انصراف' : 'Cancel'}</button>
            <button className="btn primary small" onClick={() => void createPoll()} disabled={sending}>{fa ? 'ساخت نظرسنجی' : 'Create poll'}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
