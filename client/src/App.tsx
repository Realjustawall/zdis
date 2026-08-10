import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Login } from './pages/Login';
import { Directory } from './pages/Directory';
import { Network } from './pages/Network';
import { Friends } from './pages/Friends';
import { ChatView } from './components/ChatView';
import { ForumView } from './components/ForumView';
import { GroupSidebar } from './components/GroupSidebar';
import { HomeSidebar } from './components/HomeSidebar';
import { SelfPanel } from './components/SelfPanel';
import { NotificationsPanel } from './components/NotificationsPanel';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { PwaManager } from './components/PwaManager';
import { Avatar, EmptyState, Modal, Alert } from './components/ui';
import { useSession } from './store/session';
import { useRealtime } from './store/realtime';
import { useChat, type Target } from './store/chat';
import { useVoice } from './store/voice';
import { useFriends } from './store/friends';
import { useToasts, toast } from './store/toast';
import { api, ApiError } from './lib/api';
import type { Channel, Conversation, Group, Message, Notification, PublicUser } from './types';
import { useI18n } from './lib/i18n';
import { Icon } from './components/Icon';
import { DirectCallLayer, DirectMessageActions } from './components/DirectMessages';
import { ThemeStudio } from './components/ThemeStudio';
import { ensureE2eeIdentity } from './lib/e2ee';

const Admin = lazy(() => import('./pages/Admin').then((module) => ({ default: module.Admin })));

export default function App() {
  const { user, loading, bootstrap, settings } = useSession();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (user && settings?.feature_e2ee && settings.e2ee_required_for_dms) {
      void ensureE2eeIdentity(user.id).catch(() => undefined);
    }
  }, [user?.id, settings?.feature_e2ee, settings?.e2ee_required_for_dms]);

  if (loading) {
    return (
      <div className="app-loader">
        <div className="app-loader-mark">
          <Icon name="message" size={34} />
        </div>
        <strong>sahsha</strong>
        <div className="app-loader-track"><i /></div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <Login />
        <PwaManager />
        <ToastStack />
      </>
    );
  }

  return (
    <>
      <PwaManager />
      <Shell key={user.id} appName={settings?.app_name ?? 'sahsha'} />
      <ToastStack />
    </>
  );
}

function Shell({ appName }: { appName: string }) {
  const { t, locale } = useI18n();
  const fa = locale === 'fa';
  const user = useSession((state) => state.user)!;
  const settings = useSession((state) => state.settings);
  const logout = useSession((state) => state.logout);

  const connect = useRealtime((state) => state.connect);
  const disconnect = useRealtime((state) => state.disconnect);
  const connected = useRealtime((state) => state.connected);
  const on = useRealtime((state) => state.on);
  const socket = useRealtime((state) => state.socket);

  const chat = useChat();
  const refreshFriends = useFriends((state) => state.refresh);
  const clearFriends = useFriends((state) => state.clear);
  const incomingFriendRequests = useFriends((state) =>
    state.friendships.filter(
      (item) => item.status === 'pending' && item.direction === 'incoming',
    ).length,
  );
  const voiceChannelId = useVoice((state) => state.channelId);
  const leaveVoice = useVoice((state) => state.leave);

  const [view, setView] = useState<'home' | 'group' | 'admin' | 'directory' | 'friends' | 'network'>('home');
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [selfOpen, setSelfOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [initialInvite] = useState(() => new URLSearchParams(window.location.search).get('invite') ?? '');
  const [joinOpen, setJoinOpen] = useState(Boolean(initialInvite));
  const [createOpen, setCreateOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(true);
  const [showSidebar, setShowSidebar] = useState(true);
  const [themeStudioOpen, setThemeStudioOpen] = useState(false);

  const mustChangePassword = user.mustChangePassword;

  // ------------------------------------------------------------ lifecycle

  useEffect(() => {
    if (mustChangePassword) return;
    connect();
    void chat.loadInitial().catch(() => toast.error('Could not load your workspace.'));
    void refreshFriends().catch(() => toast.error(fa ? 'بارگذاری درخواست‌های دوستی انجام نشد.' : 'Could not load friend requests.'));
    return () => {
      disconnect();
      clearFriends();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mustChangePassword]);

  useEffect(() => {
    if (mustChangePassword) setSelfOpen(true);
  }, [mustChangePassword]);

  // Wire every server event into the stores.
  useEffect(() => {
    if (!socket) return;
    const offs = [
      on('message:created', ((payload: { message: Message }) => {
        chat.applyIncoming(payload.message);
      }) as never),
      on('message:updated', ((payload: { message: Message }) => {
        if (payload.message.poll) chat.applyPollUpdate(payload.message);
        else chat.applyUpdated(payload.message);
      }) as never),
      on('message:poll', ((payload: { message: Message }) => {
        chat.applyPollUpdate(payload.message);
      }) as never),
      on('message:deleted', ((payload: never) => chat.applyDeleted(payload)) as never),
      on('message:reaction', ((payload: never) => chat.applyReactions(payload)) as never),
      on('message:pinned', ((payload: { message: Message }) => {
        chat.applyUpdated(payload.message);
      }) as never),

      on('group:joined', (() => {
        void chat.loadInitial();
        socket.emit('rooms:refresh');
        toast.info('You were added to a group.');
      }) as never),
      on('group:left', ((payload: { groupId: string }) => {
        chat.removeGroup(payload.groupId);
        setActiveGroupId((current) => (current === payload.groupId ? null : current));
        setView((current) => (current === 'group' ? 'home' : current));
        toast.info('You were removed from a group.');
      }) as never),
      on('group:deleted', ((payload: { groupId: string }) => {
        chat.removeGroup(payload.groupId);
        setActiveGroupId((current) => (current === payload.groupId ? null : current));
        setView((current) => (current === 'group' ? 'home' : current));
      }) as never),
      on('group:updated', ((payload: { group: Group }) => chat.upsertGroup(payload.group)) as never),
      on('group:member-added', ((payload: { groupId: string }) => {
        void chat.loadGroup(payload.groupId);
      }) as never),
      on('group:member-removed', ((payload: { groupId: string }) => {
        void chat.loadGroup(payload.groupId);
      }) as never),
      on('group:member-updated', ((payload: { groupId: string }) => {
        void chat.loadGroup(payload.groupId);
      }) as never),

      on('channel:created', ((payload: { channel: Channel }) => {
        void chat.loadGroup(payload.channel.groupId);
      }) as never),
      on('channel:updated', ((payload: { channel: Channel }) => {
        void chat.loadGroup(payload.channel.groupId);
      }) as never),
      on('channel:deleted', ((payload: { groupId: string; channelId: string }) => {
        void chat.loadGroup(payload.groupId);
        if (voiceChannelId === payload.channelId) leaveVoice();
      }) as never),

      on('conversation:created', ((payload: { conversation: Conversation }) => {
        chat.upsertConversation(payload.conversation);
        socket.emit('rooms:refresh');
      }) as never),
      on('conversation:removed', ((payload: { conversationId: string }) => {
        chat.removeConversation(payload.conversationId);
      }) as never),
      on('conversation:updated', ((payload: { conversation: Conversation }) => {
        chat.upsertConversation(payload.conversation as Conversation);
      }) as never),

      on('settings:updated', ((payload: never) => {
        useSession.getState().patchSettings(payload);
      }) as never),
      on('notification:created', ((payload: { notification: Notification }) => {
        toast.info(`${payload.notification.title}: ${payload.notification.body}`);
      }) as never),
      on('network:updated', (() => {
        void refreshFriends();
      }) as never),

      on('session:revoked', ((payload: { reason: string }) => {
        const reason =
          payload.reason === 'account_disabled'
            ? 'Your account was disabled by an administrator.'
            : payload.reason === 'account_deleted'
              ? 'Your account was deleted.'
              : 'You were signed out by an administrator.';
        toast.error(reason);
        setTimeout(() => void logout(), 1200);
      }) as never),
    ];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, voiceChannelId]);

  // ---------------------------------------------------------------- state

  const activeGroup = activeGroupId ? chat.groupDetail[activeGroupId] : null;

  const openGroup = useCallback(
    async (groupId: string) => {
      setActiveGroupId(groupId);
      setView('group');
      setShowSidebar(true);
      const detail = await chat.loadGroup(groupId);
      if (!detail) {
        toast.error('That group is no longer available.');
        chat.removeGroup(groupId);
        setView('home');
        return;
      }
      const firstText = detail.channels.find(
        (channel) => channel.type === 'text' || channel.type === 'forum',
      );
      if (firstText) {
        chat.setTarget({ kind: 'channel', groupId, channelId: firstText.id });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const selectChannel = (channel: Channel) => {
    chat.setTarget({ kind: 'channel', groupId: channel.groupId, channelId: channel.id });
    setShowSidebar(false);
  };

  const selectConversation = (conversation: Conversation) => {
    setView('home');
    chat.setTarget({ kind: 'conversation', conversationId: conversation.id });
    setShowSidebar(false);
  };

  const target = chat.target;

  const activeChannel = useMemo(() => {
    if (!target || target.kind !== 'channel' || !activeGroup) return null;
    return activeGroup.channels.find((channel) => channel.id === target.channelId) ?? null;
  }, [target, activeGroup]);

  const activeConversation = useMemo(() => {
    if (!target || target.kind !== 'conversation') return null;
    return chat.conversations.find((c) => c.id === target.conversationId) ?? null;
  }, [target, chat.conversations]);

  const totalMentions = useMemo(
    () =>
      Object.values(chat.unreadConversations).reduce((sum, entry) => sum + entry.unread, 0),
    [chat.unreadConversations],
  );
  const homeNotifications = totalMentions + incomingFriendRequests;
  const totalChannelMentions = useMemo(
    () => Object.values(chat.unreadChannels).reduce((sum, entry) => sum + entry.mentions, 0),
    [chat.unreadChannels],
  );
  const totalNotificationCount = homeNotifications + totalChannelMentions;

  useEffect(() => {
    document.title = totalNotificationCount > 0
      ? `(${totalNotificationCount > 99 ? '99+' : totalNotificationCount}) ${appName}`
      : appName;
    return () => { document.title = appName; };
  }, [appName, totalNotificationCount]);

  const groupMentions = useCallback(
    (groupId: string) =>
      Object.values(chat.unreadChannels)
        .filter((entry) => entry.groupId === groupId)
        .reduce((sum, entry) => sum + entry.mentions, 0),
    [chat.unreadChannels],
  );
  const groupUnread = useCallback(
    (groupId: string) =>
      Object.values(chat.unreadChannels)
        .filter((entry) => entry.groupId === groupId)
        .reduce((sum, entry) => sum + entry.unread, 0),
    [chat.unreadChannels],
  );

  // A user forced to rotate their password sees only that screen.
  if (mustChangePassword) {
    return (
      <div className="auth-screen auth-login">
        <div className="auth-ambient auth-ambient-one" />
        <div className="auth-ambient auth-ambient-two" />
        <div className="auth-forced-shell">
          <div className="auth-forced-icon">🔐</div>
          <h1>{appName}</h1>
          <p>{fa ? 'برای ادامه، رمز عبور شخصی خود را انتخاب کنید.' : 'Choose your own password to continue.'}</p>
          <Alert kind="info">
            {fa ? 'مدیر برای این حساب رمز موقت تعیین کرده است. تا انتخاب رمز جدید، بخش‌های دیگر در دسترس نیستند.' : 'An administrator set a temporary password for this account. Pick a new one — nothing else is available until you do.'}
          </Alert>
          <button className="btn primary block" onClick={() => setSelfOpen(true)}>
            {fa ? 'انتخاب رمز عبور جدید' : 'Choose a new password'}
          </button>
          <button className="btn ghost block mt-16" onClick={() => void logout()}>
            {fa ? 'خروج' : 'Sign out'}
          </button>
        </div>
        {selfOpen ? <SelfPanel onClose={() => setSelfOpen(false)} /> : null}
      </div>
    );
  }

  if (view === 'admin') {
    return (
      <>
        <Suspense fallback={<div className="center-screen"><span className="spinner" /></div>}>
          <Admin onExit={() => setView('home')} />
        </Suspense>
        {selfOpen ? <SelfPanel onClose={() => setSelfOpen(false)} /> : null}
      </>
    );
  }

  const canCreateGroup =
    user.role === 'admin' ||
    (user.role === 'youtuber' && settings?.youtubers_can_create_groups) ||
    (user.role === 'member' && settings?.members_can_create_groups);

  const showMembersPanel = view === 'group' && membersOpen && Boolean(activeGroup);

  const selfFooter = (
    <SidebarFooter
      onOpenSelf={() => setSelfOpen(true)}
      connected={connected}
      onLogout={() => void logout()}
    />
  );

  return (
    <div
      className={`app${showMembersPanel ? ' with-members' : ''}${showSidebar ? ' show-sidebar' : ''}`}
    >
      {/* --------------------------------------------------------- rail */}
      <nav className="rail">
        <button
          className={`rail-item${view === 'home' || view === 'directory' ? ' active' : ''}`}
          onClick={() => {
            setView('home');
            setShowSidebar(true);
          }}
          title={t('nav.directMessages')}
        >
          <span className="pill" />
          <Icon name="message" size={21} />
          {homeNotifications > 0 ? (
            <span className="rail-badge">{homeNotifications > 99 ? '99+' : homeNotifications}</span>
          ) : null}
        </button>

        <div className="rail-sep" />

        {chat.groups.map((group) => {
          const mentions = groupMentions(group.id);
          const unread = groupUnread(group.id);
          return (
            <button
              key={group.id}
              className={`rail-item${activeGroupId === group.id && view === 'group' ? ' active' : ''}${unread > 0 ? ' has-unread' : ''}`}
              onClick={() => void openGroup(group.id)}
              title={group.name}
              style={
                activeGroupId === group.id && view === 'group'
                  ? undefined
                  : { background: group.accentColor ?? undefined }
              }
            >
              <span className="pill" />
              {group.iconUrl ? (
                <img src={group.iconUrl} alt="" style={{ width: '100%', height: '100%', borderRadius: 'inherit' }} />
              ) : (
                group.name.slice(0, 2).toUpperCase()
              )}
              {mentions > 0 ? <span className="rail-badge">{mentions > 99 ? '99+' : mentions}</span> : null}
            </button>
          );
        })}

        {canCreateGroup ? (
          <button className="rail-item" onClick={() => setCreateOpen(true)} title={t('nav.createGroup')}>
            <Icon name="add" size={22} />
          </button>
        ) : null}
        <button className="rail-item" onClick={() => setJoinOpen(true)} title={t('nav.joinGroup')}>
          <Icon name="link" size={19} />
        </button>
        <button className="rail-item" onClick={() => setDiscoverOpen(true)} title="Discover servers">
          <Icon name="discover" size={20} />
        </button>

        <div className="rail-spacer" />

        <ThemeSwitcher compact onOpenStudio={() => setThemeStudioOpen(true)} />
        <LanguageSwitcher compact />

        <button
          className="rail-item"
          onClick={() => setNotificationsOpen(true)}
          title={t('nav.notifications')}
        >
          <Icon name="bell" size={20} />
        </button>

        {user.role === 'admin' || user.badges.some((badge) => badge.id === 'staff') ? (
          <button className="rail-item" onClick={() => setView('admin')} title={t('nav.admin')}>
            <Icon name="shield" size={20} />
          </button>
        ) : null}
      </nav>

      {/* ------------------------------------------------------ sidebar */}
      {view === 'group' && activeGroup ? (
        <GroupSidebar
          group={activeGroup.group}
          channels={activeGroup.channels}
          categories={activeGroup.categories}
          members={activeGroup.members}
          invites={activeGroup.invites}
          roles={activeGroup.roles}
          permissions={activeGroup.permissions}
          activeChannelId={target?.kind === 'channel' ? target.channelId : null}
          onSelectChannel={selectChannel}
          onRefresh={() => void chat.loadGroup(activeGroup.group.id)}
          footer={selfFooter}
        />
      ) : (
        <HomeSidebar
          activeConversationId={target?.kind === 'conversation' ? target.conversationId : null}
          onSelectConversation={selectConversation}
          onOpenDirectory={() => {
            setView('directory');
            setShowSidebar(false);
          }}
          directoryOpen={view === 'directory'}
          onOpenFriends={() => {
            setView('friends');
            setShowSidebar(false);
          }}
          friendsOpen={view === 'friends'}
          onOpenNetwork={() => {
            setView('network');
            setShowSidebar(false);
          }}
          networkOpen={view === 'network'}
          footer={selfFooter}
        />
      )}

      {/* --------------------------------------------------------- main */}
      <MainArea
        view={view}
        target={target}
        activeGroup={activeGroup}
        activeChannel={activeChannel}
        activeConversation={activeConversation}
        membersOpen={membersOpen}
        onToggleMembers={() => setMembersOpen((open) => !open)}
        onSelectConversation={selectConversation}
        onBack={() => setShowSidebar(true)}
      />

      <DirectCallLayer
        conversations={chat.conversations}
        onOpenConversation={selectConversation}
      />

      {/* ------------------------------------------------------ members */}
      {showMembersPanel && activeGroup ? (
        <aside className="members">
          <div className="section-label">{fa ? 'آنلاین' : 'Online'} — {onlineCount(activeGroup.members)}</div>
          {activeGroup.members
            .filter((member) => member.presence !== 'offline')
            .map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          <div className="section-label">{fa ? 'آفلاین' : 'Offline'}</div>
          {activeGroup.members
            .filter((member) => member.presence === 'offline')
            .map((member) => (
              <MemberRow key={member.id} member={member} offline />
            ))}
        </aside>
      ) : null}

      {selfOpen ? <SelfPanel onClose={() => setSelfOpen(false)} /> : null}
      {notificationsOpen ? (
        <NotificationsPanel onClose={() => setNotificationsOpen(false)} />
      ) : null}
      {themeStudioOpen ? <ThemeStudio onClose={() => setThemeStudioOpen(false)} /> : null}

      {createOpen ? (
        <CreateGroupModal
          onClose={() => setCreateOpen(false)}
          onCreated={(group) => {
            chat.upsertGroup(group);
            setCreateOpen(false);
            void openGroup(group.id);
          }}
        />
      ) : null}

      {joinOpen ? (
        <JoinGroupModal
          initialCode={initialInvite}
          onClose={() => setJoinOpen(false)}
          onJoined={(group) => {
            chat.upsertGroup(group);
            setJoinOpen(false);
            void openGroup(group.id);
          }}
        />
      ) : null}
      {discoverOpen ? (
        <DiscoverModal
          onClose={() => setDiscoverOpen(false)}
          onJoined={(group) => {
            chat.upsertGroup(group);
            setDiscoverOpen(false);
            void openGroup(group.id);
          }}
        />
      ) : null}
    </div>
  );
}

function onlineCount(members: PublicUser[]) {
  return members.filter((member) => member.presence !== 'offline').length;
}

function MemberRow({ member, offline }: { member: PublicUser & { memberRole?: string }; offline?: boolean }) {
  const openDm = useChat((state) => state.openDm);
  const setTarget = useChat((state) => state.setTarget);
  const me = useSession((state) => state.user)!;

  return (
    <button
      className={`member-row${offline ? ' offline' : ''}`}
      onClick={async () => {
        if (member.id === me.id) return;
        try {
          const conversation = await openDm(member.id);
          setTarget({ kind: 'conversation', conversationId: conversation.id });
        } catch (error) {
          toast.error(error instanceof ApiError ? error.message : 'Could not open a conversation.');
        }
      }}
      title={member.id === me.id ? 'This is you' : `Message ${member.displayName}`}
    >
      <Avatar
        name={member.displayName}
        id={member.id}
        src={member.avatarUrl}
        color={member.bannerColor}
        size={30}
        presence={member.presence}
      />
      <span className="info">
        <span className="name" style={{ color: member.bannerColor ?? undefined }}>
          {member.displayName}
        </span>
        <span className="sub">{member.customStatus ?? `@${member.username}`}</span>
      </span>
      {member.memberRole && member.memberRole !== 'member' ? (
        <span className="badge" style={{ fontSize: 9 }}>
          {member.memberRole}
        </span>
      ) : null}
    </button>
  );
}

function SidebarFooter({
  onOpenSelf,
  connected,
  onLogout,
}: {
  onOpenSelf: () => void;
  connected: boolean;
  onLogout: () => void;
}) {
  const { t } = useI18n();
  const user = useSession((state) => state.user)!;
  return (
    <div className="sidebar-foot">
      <Avatar
        name={user.displayName}
        id={user.id}
        src={user.avatarUrl}
        color={user.bannerColor}
        size={32}
        presence={connected ? user.presence : 'offline'}
      />
      <div className="who">
        <div className="name">{user.displayName}</div>
        <div className="sub">{connected ? `@${user.username}` : t('status.reconnecting')}</div>
      </div>
      <button className="head-btn" onClick={onOpenSelf} title={t('nav.account')}>
        <Icon name="settings" size={17} />
      </button>
      <button className="head-btn" onClick={onLogout} title={t('nav.logout')}>
        <Icon name="logout" size={17} />
      </button>
    </div>
  );
}

function MainArea({
  view,
  target,
  activeGroup,
  activeChannel,
  activeConversation,
  membersOpen,
  onToggleMembers,
  onSelectConversation,
  onBack,
}: {
  view: string;
  target: Target;
  activeGroup: ReturnType<typeof useChat.getState>['groupDetail'][string] | null;
  activeChannel: Channel | null;
  activeConversation: Conversation | null;
  membersOpen: boolean;
  onToggleMembers: () => void;
  onSelectConversation: (conversation: Conversation) => void;
  onBack: () => void;
}) {
  const { t, locale } = useI18n();
  const fa = locale === 'fa';
  const me = useSession((state) => state.user)!;

  if (view === 'directory') {
    return <Directory onOpenConversation={onSelectConversation} />;
  }
  if (view === 'friends') {
    return <Friends onOpenConversation={onSelectConversation} />;
  }
  if (view === 'network') {
    return <Network />;
  }

  if (!target) {
    return (
      <div className="main">
        <EmptyState icon={<Icon name="message" size={38} />} title={t('welcome.title', { name: me.displayName })}>
          {t('welcome.body')}
        </EmptyState>
      </div>
    );
  }

  if (target.kind === 'channel' && activeGroup && activeChannel) {
    if (activeChannel.type === 'forum') {
      return (
        <ForumView
          channel={activeChannel}
          canModerate={activeGroup.permissions.deleteAnyMessage}
          onBack={onBack}
        />
      );
    }
    return (
      <ChatView
        target={target}
        title={activeChannel.name}
        glyph={
          activeChannel.type === 'voice'
            ? '🔊 '
            : activeChannel.type === 'stage'
              ? '🎙 '
              : activeChannel.type === 'announcement'
                ? '📢 '
              : activeChannel.isPrivate
                ? '🔒 '
                : '# '
        }
        topic={activeChannel.topic}
        members={activeGroup.members}
        canModerate={activeGroup.permissions.deleteAnyMessage}
        canPin={activeGroup.permissions.pinMessage}
        voiceChannel={activeChannel.type === 'voice' || activeChannel.type === 'stage' ? activeChannel : null}
        onOpenMembers={onToggleMembers}
        membersOpen={membersOpen}
        headerExtra={
          <button className="head-btn" onClick={onBack} title={fa ? 'بازگشت' : 'Back'}>
            <Icon name="menu" size={19} />
          </button>
        }
      />
    );
  }

  if (target.kind === 'conversation' && activeConversation) {
    const others = activeConversation.members.filter((member) => member.id !== me.id);
    const title =
      activeConversation.type === 'group_dm'
        ? activeConversation.name || others.map((member) => member.displayName).join(', ')
        : others[0]?.displayName ?? (fa ? 'پیام خصوصی' : 'Direct message');

    return (
      <ChatView
        target={target}
        title={title}
        glyph={activeConversation.type === 'group_dm' ? '👥 ' : '@'}
        topic={
          activeConversation.type === 'group_dm'
            ? (fa ? `${activeConversation.members.length} نفر` : `${activeConversation.members.length} people`)
            : others[0]
              ? `@${others[0].username}`
              : null
        }
        members={activeConversation.members}
        canModerate={activeConversation.ownerId === me.id}
        canPin
        headerExtra={
          <>
            <button className="head-btn mobile-chat-back" onClick={onBack} title={fa ? 'بازگشت' : 'Back'}>
              <Icon name="menu" size={19} />
            </button>
            <DirectMessageActions conversation={activeConversation} />
          </>
        }
      />
    );
  }

  return (
    <div className="main">
      <div className="center-screen">
        <span className="spinner" />
      </div>
    </div>
  );
}

function CreateGroupModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (group: Group) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  async function create() {
    setBusy(true);
    try {
      const data = await api.post<{ group: Group }>('/api/groups', {
        name: name.trim(),
        description: description.trim() || null,
      });
      toast.success(fa ? 'گروه ساخته شد.' : 'Group created.');
      onCreated(data.group);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'ساخت گروه انجام نشد.' : 'Could not create the group.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={fa ? 'ساخت گروه' : 'Create a group'}
      description={fa ? 'فضای اختصاصی شما؛ مالک گروه هستید و اعضا را انتخاب می‌کنید.' : 'Your own space. You become its owner and decide who gets in.'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {fa ? 'انصراف' : 'Cancel'}
          </button>
          <button className="btn primary" onClick={create} disabled={busy || name.trim().length < 2}>
            {busy ? (fa ? 'در حال ساخت…' : 'Creating…') : (fa ? 'ساخت گروه' : 'Create group')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="group-name">{fa ? 'نام' : 'Name'}</label>
        <input
          id="group-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={fa ? 'مثلاً تیم تولید محتوا' : "Sam's Channel HQ"}
          maxLength={64}
        />
      </div>
      <div className="field">
        <label htmlFor="group-description">{fa ? 'توضیحات (اختیاری)' : 'Description (optional)'}</label>
        <textarea
          id="group-description"
          className="textarea"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={fa ? 'فضایی برای برنامه‌ریزی و همکاری تیم.' : 'Where the editing team plans uploads.'}
          maxLength={300}
        />
      </div>
      <p className="muted small">
        {fa ? 'گروه با کانال عمومی، اعلان‌ها و یک اتاق صوتی ساخته می‌شود و بعداً می‌توانید همه را تغییر دهید.' : 'It starts with a #general channel, an #announcements channel and a voice lounge. You can change all of that afterwards.'}
      </p>
      <div style={{ height: 12 }} />
    </Modal>
  );
}

function JoinGroupModal({
  initialCode = '',
  onClose,
  onJoined,
}: {
  initialCode?: string;
  onClose: () => void;
  onJoined: (group: Group) => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  async function join() {
    setBusy(true);
    try {
      const data = await api.post<{ group: Group }>(`/api/groups/join/${code.trim()}`);
      toast.success(fa ? `به ${data.group.name} پیوستید.` : `You joined ${data.group.name}.`);
      onJoined(data.group);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'استفاده از دعوت‌نامه انجام نشد.' : 'Could not use that invite.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={fa ? 'پیوستن به گروه' : 'Join a group'}
      description={fa ? 'کد دعوتی را که دریافت کرده‌اید وارد کنید.' : 'Paste the invite code someone shared with you.'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {fa ? 'انصراف' : 'Cancel'}
          </button>
          <button className="btn primary" onClick={join} disabled={busy || code.trim().length < 4}>
            {busy ? (fa ? 'در حال پیوستن…' : 'Joining…') : (fa ? 'پیوستن به گروه' : 'Join group')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="invite-code">{fa ? 'کد دعوت' : 'Invite code'}</label>
        <input
          id="invite-code"
          className="input mono"
          value={code}
          onChange={(event) => setCode(event.target.value.trim())}
          placeholder="a1b2c3d4"
          autoFocus
        />
      </div>
      <div style={{ height: 12 }} />
    </Modal>
  );
}

function DiscoverModal({ onClose, onJoined }: { onClose: () => void; onJoined: (group: Group) => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(true);
  const load = async (query = '') => {
    setBusy(true);
    try {
      const data = await api.get<{ groups: Group[] }>(`/api/groups/discover?search=${encodeURIComponent(query)}`);
      setGroups(data.groups);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(); }, []);
  return (
    <Modal title="Discover servers" description="Verified public communities approved by the platform administrator." onClose={onClose} wide>
      <div className="row">
        <input className="input" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or description" />
        <button className="btn" onClick={() => void load(search)}>Search</button>
      </div>
      <div className="col mt-16">
        {busy ? <span className="spinner" /> : null}
        {!busy && !groups.length ? <div className="empty">No discoverable servers found.</div> : null}
        {groups.map((group) => (
          <div className="row between" key={group.id} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 10 }}>
            <div>
              <strong>{group.name}</strong>
              <div className="faint small">{group.description || 'No description'} · {group.memberCount ?? 0} members</div>
            </div>
            <button className="btn primary small" onClick={async () => {
              const data = await api.post<{ group: Group }>(`/api/groups/discover/${group.id}/join`);
              onJoined(data.group);
            }}>Join</button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ToastStack() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((item) => (
        <div key={item.id} className={`toast ${item.kind}`} onClick={() => dismiss(item.id)}>
          {item.message}
        </div>
      ))}
    </div>
  );
}
