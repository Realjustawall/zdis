import { useEffect, useMemo, useState } from 'react';
import { Avatar, Modal } from './ui';
import { useChat } from '../store/chat';
import { useRealtime } from '../store/realtime';
import { useSession } from '../store/session';
import { toast } from '../store/toast';
import { api, ApiError } from '../lib/api';
import type { Conversation, PublicUser } from '../types';
import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';
import { useFriends } from '../store/friends';
import { MessagePreview } from './MessagePreview';

interface Props {
  activeConversationId: string | null;
  onSelectConversation: (conversation: Conversation) => void;
  onOpenDirectory: () => void;
  directoryOpen: boolean;
  onOpenFriends: () => void;
  friendsOpen: boolean;
  onOpenNetwork: () => void;
  networkOpen: boolean;
  footer: ReactNode;
}

export function HomeSidebar({
  activeConversationId,
  onSelectConversation,
  onOpenDirectory,
  directoryOpen,
  onOpenFriends,
  friendsOpen,
  onOpenNetwork,
  networkOpen,
  footer,
}: Props) {
  const user = useSession((state) => state.user)!;
  const settings = useSession((state) => state.settings);
  const conversations = useChat((state) => state.conversations);
  const unread = useChat((state) => state.unreadConversations);
  const directory = useChat((state) => state.directory);
  const loadDirectory = useChat((state) => state.loadDirectory);
  const openDm = useChat((state) => state.openDm);
  const removeConversation = useChat((state) => state.removeConversation);
  const presence = useRealtime((state) => state.presence);
  const incomingFriendRequests = useFriends((state) =>
    state.friendships.filter(
      (item) => item.status === 'pending' && item.direction === 'incoming',
    ).length,
  );

  const [newDmOpen, setNewDmOpen] = useState(false);
  const [groupDmOpen, setGroupDmOpen] = useState(false);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  const titleFor = (conversation: Conversation) => {
    if (conversation.type === 'group_dm') {
      if (conversation.name) return conversation.name;
      const others = conversation.members.filter((member) => member.id !== user.id);
      return others.map((member) => member.displayName).join(', ') || (fa ? 'پیام گروهی' : 'Group message');
    }
    const other = conversation.members.find((member) => member.id !== user.id);
    return other?.displayName ?? (fa ? 'پیام خصوصی' : 'Direct message');
  };

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <h2>{fa ? 'پیام‌های خصوصی' : 'Direct messages'}</h2>
        <div className="row" style={{ gap: 2 }}>
          {settings?.allow_group_dms ? (
            <button
              className="head-btn"
              title={fa ? 'پیام گروهی جدید' : 'New group message'}
              onClick={() => {
                void loadDirectory();
                setGroupDmOpen(true);
              }}
            >
              <Icon name="users" size={17} />
            </button>
          ) : null}
          <button
            className="head-btn"
            title={fa ? 'پیام جدید' : 'New message'}
            onClick={() => {
              void loadDirectory();
              setNewDmOpen(true);
            }}
          >
            <Icon name="add" size={19} />
          </button>
        </div>
      </div>

      <div className="sidebar-body">
        <button
          className={`nav-item home-friends-link${friendsOpen ? ' active' : ''}`}
          onClick={onOpenFriends}
        >
          <span className="glyph"><Icon name="users" size={18} /></span>
          <span className="label">{fa ? 'دوستان' : 'Friends'}</span>
          {incomingFriendRequests > 0 ? (
            <span className="count" aria-label={`${incomingFriendRequests} pending friend requests`}>
              {incomingFriendRequests > 99 ? '99+' : incomingFriendRequests}
            </span>
          ) : null}
        </button>
        <button
          className={`nav-item${directoryOpen ? ' active' : ''}`}
          onClick={onOpenDirectory}
        >
          <span className="glyph"><Icon name="directory" size={18} /></span>
          <span className="label">{fa ? 'فهرست اعضا' : 'Member directory'}</span>
        </button>
        <button
          className={`nav-item${networkOpen ? ' active' : ''}`}
          onClick={onOpenNetwork}
        >
          <span className="glyph"><Icon name="compass" size={18} /></span>
          <span className="label">{fa ? 'شبکه ارتباطی' : 'Network'}</span>
        </button>

        <div className="section-label">
          <span>{fa ? 'گفتگوها' : 'Conversations'}</span>
        </div>

        {conversations.length === 0 ? (
          <p className="faint small" style={{ padding: '8px 10px' }}>
            {fa ? 'هنوز گفتگویی ندارید. برای ارسال پیام روی ＋ بزنید.' : 'No conversations yet. Press ＋ to message someone.'}
          </p>
        ) : null}

        {conversations.map((conversation) => {
          const counts = unread[conversation.id];
          const isActive = conversation.id === activeConversationId;
          const other = conversation.members.find((member) => member.id !== user.id);
          const live = other ? presence[other.id] ?? other.presence : undefined;

          return (
            <button
              key={conversation.id}
              className={`nav-item${isActive ? ' active' : ''}${counts?.unread && !isActive ? ' unread' : ''}`}
              onClick={() => onSelectConversation(conversation)}
            >
              {conversation.type === 'group_dm' ? (
                <span className="glyph"><Icon name="users" size={18} /></span>
              ) : (
                <Avatar
                  name={other?.displayName ?? '?'}
                  id={other?.id}
                  color={other?.bannerColor}
                  size={22}
                  presence={live}
                />
              )}
              <span className="label">
                {titleFor(conversation)}
                {conversation.lastMessage ? (
                  <span
                    className="faint"
                    style={{ display: 'block', fontSize: 11.5, lineHeight: 1.3 }}
                  >
                    <MessagePreview
                      content={conversation.lastMessage.preview}
                      encrypted={conversation.lastMessage.encrypted}
                      encryptedContent={conversation.lastMessage.encryptedContent}
                      conversationId={conversation.id}
                      authorId={conversation.lastMessage.authorId}
                      currentUserId={user.id}
                      fallback={fa ? 'پیام رمزگذاری‌شده' : 'Encrypted message'}
                      limit={34}
                    />
                  </span>
                ) : null}
              </span>
              {counts?.unread ? <span className="count">{counts.unread}</span> : null}
              <span className="actions">
                <button
                  title={fa ? 'بستن گفتگو' : 'Close conversation'}
                  onClick={async (event) => {
                    event.stopPropagation();
                    try {
                      await api.del(`/api/conversations/${conversation.id}`);
                      removeConversation(conversation.id);
                    } catch {
                      toast.error(fa ? 'بستن گفتگو انجام نشد.' : 'Could not close that conversation.');
                    }
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              </span>
            </button>
          );
        })}
      </div>

      {footer}

      {newDmOpen ? (
        <PeoplePicker
          title={fa ? 'شروع گفتگو' : 'Start a conversation'}
          description={fa ? 'همه حساب‌های این سرور در این فهرست هستند.' : 'Every account on this server is listed here.'}
          people={directory.filter((person) => person.id !== user.id)}
          onSearch={(term) => void loadDirectory(term)}
          onPick={async (person) => {
            try {
              const conversation = await openDm(person.id);
              onSelectConversation(conversation);
              setNewDmOpen(false);
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : (fa ? 'بازکردن گفتگو انجام نشد.' : 'Could not open that conversation.'));
            }
          }}
          onClose={() => setNewDmOpen(false)}
        />
      ) : null}

      {groupDmOpen ? (
        <GroupDmModal
          people={directory.filter((person) => person.id !== user.id)}
          onSearch={(term) => void loadDirectory(term)}
          onClose={() => setGroupDmOpen(false)}
          onCreated={(conversation) => {
            onSelectConversation(conversation);
            setGroupDmOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function PeoplePicker({
  title,
  description,
  people,
  onSearch,
  onPick,
  onClose,
}: {
  title: string;
  description?: string;
  people: PublicUser[];
  onSearch: (term: string) => void;
  onPick: (person: PublicUser) => void;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  useEffect(() => {
    onSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal title={title} description={description} onClose={onClose}>
      <input
        className="input"
        placeholder={fa ? 'جست‌وجو با نام یا نام کاربری…' : 'Search by name or username…'}
        onChange={(event) => onSearch(event.target.value)}
        autoFocus
      />
      <div className="picker-list">
        {people.length === 0 ? (
          <div style={{ padding: 16 }} className="muted small">
            {fa ? 'نتیجه‌ای پیدا نشد.' : 'Nobody matched.'}
          </div>
        ) : (
          people.map((person) => (
            <button key={person.id} className="picker-row" onClick={() => onPick(person)}>
              <Avatar
                name={person.displayName}
                id={person.id}
                color={person.bannerColor}
                size={32}
                presence={person.presence}
              />
              <span className="info">
                <span className="name">{person.displayName}</span>
                <span className="sub">@{person.username}</span>
              </span>
              {person.role !== 'member' ? (
                <span className={`badge ${person.role}`}>{person.role === 'youtuber' ? 'YouTuber' : person.role}</span>
              ) : null}
            </button>
          ))
        )}
      </div>
      <div style={{ height: 16 }} />
    </Modal>
  );
}

function GroupDmModal({
  people,
  onSearch,
  onClose,
  onCreated,
}: {
  people: PublicUser[];
  onSearch: (term: string) => void;
  onClose: () => void;
  onCreated: (conversation: Conversation) => void;
}) {
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const selectedIds = useMemo(() => new Set(selected.map((person) => person.id)), [selected]);

  async function create() {
    setBusy(true);
    try {
      const data = await api.post<{ conversation: Conversation }>('/api/conversations/group', {
        userIds: selected.map((person) => person.id),
        name: name.trim() || null,
      });
      onCreated(data.conversation);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'ساخت پیام گروهی انجام نشد.' : 'Could not create the group message.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={fa ? 'پیام گروهی جدید' : 'New group message'}
      description={fa ? 'حداقل دو نفر را انتخاب کنید؛ حداکثر ۲۵ نفر می‌توانند عضو باشند.' : 'Pick at least two people. Up to 25 can take part.'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {fa ? 'انصراف' : 'Cancel'}
          </button>
          <button className="btn primary" onClick={create} disabled={busy || selected.length < 2}>
            {busy ? (fa ? 'در حال ساخت…' : 'Creating…') : (fa ? `ساخت (${selected.length})` : `Create (${selected.length})`)}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="gdm-name">{fa ? 'نام (اختیاری)' : 'Name (optional)'}</label>
        <input
          id="gdm-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={fa ? 'مثلاً بررسی تصویر بندانگشتی' : 'Thumbnail review'}
          maxLength={48}
        />
      </div>

      {selected.length > 0 ? (
        <div className="row wrap" style={{ marginBottom: 10 }}>
          {selected.map((person) => (
            <span className="pending-chip" key={person.id}>
              <span className="name">{person.displayName}</span>
              <button onClick={() => setSelected((current) => current.filter((p) => p.id !== person.id))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <input
        className="input"
        placeholder={fa ? 'جست‌وجوی حساب‌ها…' : 'Search accounts…'}
        onChange={(event) => onSearch(event.target.value)}
      />
      <div className="picker-list">
        {people.map((person) => (
          <button
            key={person.id}
            className={`picker-row${selectedIds.has(person.id) ? ' selected' : ''}`}
            onClick={() =>
              setSelected((current) =>
                selectedIds.has(person.id)
                  ? current.filter((p) => p.id !== person.id)
                  : current.length >= 24
                    ? current
                    : [...current, person],
              )
            }
          >
            <Avatar name={person.displayName} id={person.id} color={person.bannerColor} size={30} />
            <span className="info">
              <span className="name">{person.displayName}</span>
              <span className="sub">@{person.username}</span>
            </span>
            {selectedIds.has(person.id) ? <span className="badge moderator">{fa ? 'انتخاب‌شده' : 'picked'}</span> : null}
          </button>
        ))}
      </div>
      <div style={{ height: 16 }} />
    </Modal>
  );
}
