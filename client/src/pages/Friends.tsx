import { useEffect, useMemo, useState } from 'react';
import { Avatar, EmptyState } from '../components/ui';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useChat } from '../store/chat';
import { useRealtime } from '../store/realtime';
import { useSession } from '../store/session';
import { toast } from '../store/toast';
import { useFriends } from '../store/friends';
import type { Conversation, PublicUser } from '../types';

type FriendTab = 'online' | 'all' | 'pending' | 'add' | 'blocked';

export function Friends({
  onOpenConversation,
}: {
  onOpenConversation: (conversation: Conversation) => void;
}) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const directory = useChat((state) => state.directory);
  const currentUserId = useSession((state) => state.user?.id);
  const loadDirectory = useChat((state) => state.loadDirectory);
  const openDm = useChat((state) => state.openDm);
  const presence = useRealtime((state) => state.presence);
  const [tab, setTab] = useState<FriendTab>('online');
  const friendships = useFriends((state) => state.friendships);
  const friendsLoading = useFriends((state) => state.loading);
  const refreshFriends = useFriends((state) => state.refresh);
  const [blocked, setBlocked] = useState<PublicUser[]>([]);
  const [query, setQuery] = useState('');
  const [loadingExtras, setLoadingExtras] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoadingExtras(true);
    try {
      const [, blocks] = await Promise.all([
        refreshFriends(),
        api.get<{ blocked: PublicUser[] }>('/api/users/me/blocks'),
        loadDirectory(),
      ]);
      setBlocked(blocks.blocked);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'بارگذاری دوستان انجام نشد.' : 'Could not load friends.'));
    } finally {
      setLoadingExtras(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accepted = friendships.filter((item) => item.status === 'accepted');
  const pending = friendships.filter((item) => item.status === 'pending');
  const visible = (tab === 'online'
    ? accepted.filter((item) => (presence[item.user.id] ?? item.user.presence) !== 'offline')
    : tab === 'all'
      ? accepted
      : tab === 'pending'
        ? pending
        : []
  ).filter((item) => {
    const term = query.trim().toLowerCase();
    return !term || item.user.displayName.toLowerCase().includes(term) || item.user.username.includes(term);
  });

  const relationshipByUser = useMemo(
    () => new Map(friendships.map((item) => [item.user.id, item])),
    [friendships],
  );
  const addMatches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    return directory
      .filter(
        (person) =>
          person.id !== currentUserId &&
          person.isActive &&
          !blocked.some((item) => item.id === person.id) &&
          (person.username.includes(term) || person.displayName.toLowerCase().includes(term)),
      )
      .slice(0, 12);
  }, [blocked, currentUserId, directory, query]);

  async function perform(id: string, request: () => Promise<unknown>, success: string) {
    setBusyId(id);
    try {
      await request();
      toast.success(success);
      await refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'این کار انجام نشد.' : 'That action failed.'));
    } finally {
      setBusyId(null);
    }
  }

  async function message(person: PublicUser) {
    setBusyId(person.id);
    try {
      onOpenConversation(await openDm(person.id));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'باز کردن گفتگو انجام نشد.' : 'Could not open that conversation.'));
    } finally {
      setBusyId(null);
    }
  }

  async function addByUsername(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = query.trim();
    if (!username) return;
    setBusyId('username');
    try {
      await api.post('/api/network/friends', { username });
      toast.success(fa ? 'درخواست دوستی ارسال شد.' : `Friend request sent to ${username.startsWith('@') ? username : `@${username}`}.`);
      setQuery('');
      await refreshFriends();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'ارسال درخواست دوستی انجام نشد.' : 'Could not send that friend request.'));
    } finally {
      setBusyId(null);
    }
  }

  const tabs: { id: FriendTab; label: string; count?: number }[] = [
    { id: 'online', label: fa ? 'آنلاین' : 'Online' },
    { id: 'all', label: fa ? 'همه' : 'All' },
    { id: 'pending', label: fa ? 'در انتظار' : 'Pending', count: pending.length },
    { id: 'blocked', label: fa ? 'مسدودشده' : 'Blocked', count: blocked.length },
    { id: 'add', label: fa ? 'افزودن دوست' : 'Add Friend' },
  ];

  return (
    <div className="main friends-page">
      <header className="friends-head">
        <div className="friends-title"><Icon name="users" size={20} /><strong>{fa ? 'دوستان' : 'Friends'}</strong></div>
        <nav className="friends-tabs" aria-label={fa ? 'فهرست دوستان' : 'Friend lists'}>
          {tabs.map((item) => (
            <button
              key={item.id}
              className={`${tab === item.id ? 'active ' : ''}${item.id === 'add' ? 'add' : ''}`}
              onClick={() => { setTab(item.id); setQuery(''); }}
            >
              {item.label}{item.count ? <span>{item.count}</span> : null}
            </button>
          ))}
        </nav>
        <button className="head-btn friends-refresh" onClick={() => void refresh()} title={fa ? 'تازه‌سازی' : 'Refresh'}>
          <Icon name="system" size={17} />
        </button>
      </header>

      <div className="friends-body">
        <section className="friends-list-panel">
          <div className="friends-intro">
            <span className="eyebrow">
              {tab === 'add' ? (fa ? 'افزودن دوست' : 'ADD FRIEND') : tab === 'pending' ? (fa ? 'درخواست‌ها' : 'FRIEND REQUESTS') : (fa ? 'دوستان شما' : 'YOUR FRIENDS')}
            </span>
            <h1>{tab === 'online' ? (fa ? 'چه کسانی الآن اینجا هستند؟' : 'Who’s around right now?') : tab === 'add' ? (fa ? 'پیدا کردن دوست' : 'Find your people') : (fa ? 'در ارتباط بمانید' : 'Stay connected')}</h1>
            <p>{tab === 'add' ? (fa ? 'نام نمایشی یا نام کاربری دقیق را جست‌وجو کنید.' : 'Search by display name or username, then send a request.') : (fa ? 'پیام خصوصی، تماس صوتی و ویدیویی فقط یک کلیک فاصله دارند.' : 'Direct messages, voice, and video are one click away.')}</p>
          </div>

          {tab === 'add' ? (
            <form className="friends-search friend-add-form" onSubmit={(event) => void addByUsername(event)}>
              <Icon name="search" size={18} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value.toLowerCase())}
                placeholder={fa ? 'نام کاربری دقیق را وارد کنید…' : 'Enter an exact username…'}
                aria-label={fa ? 'نام کاربری دوست' : 'Friend username'}
                autoFocus
              />
              <button className="btn primary small" type="submit" disabled={!query.trim() || busyId === 'username'}>
                {busyId === 'username' ? <span className="spinner" /> : <Icon name="add" size={15} />}
                {fa ? 'ارسال درخواست' : 'Send Friend Request'}
              </button>
            </form>
          ) : tab !== 'blocked' ? (
            <label className="friends-search">
              <Icon name="search" size={18} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value.toLowerCase())}
                placeholder={fa ? 'جست‌وجوی دوستان…' : 'Search friends…'}
              />
              {query ? <button onClick={() => setQuery('')}><Icon name="close" size={15} /></button> : null}
            </label>
          ) : null}

          {friendsLoading || loadingExtras ? (
            <div className="friends-loading"><span className="spinner" /></div>
          ) : tab === 'add' ? (
            <div className="friend-cards">
              {!query ? (
                <EmptyState icon={<Icon name="search" size={32} />} title={fa ? 'جست‌وجو را شروع کنید' : 'Start with a name'}>
                  {fa ? 'افراد این سامانه را پیدا کنید و درخواست دوستی بفرستید.' : 'Find anyone on this platform and send a friend request.'}
                </EmptyState>
              ) : addMatches.length ? addMatches.map((person) => {
                const relation = relationshipByUser.get(person.id);
                return (
                  <PersonRow key={person.id} person={person} presence={presence[person.id] ?? person.presence}>
                    {relation?.status === 'accepted' ? (
                      <button className="friend-icon-btn primary" onClick={() => void message(person)} title={fa ? 'پیام' : 'Message'}><Icon name="message" size={18} /></button>
                    ) : relation?.status === 'pending' ? (
                      <span className="friend-state">{relation.direction === 'incoming' ? (fa ? 'درخواست دریافتی' : 'Incoming request') : (fa ? 'ارسال شد' : 'Request sent')}</span>
                    ) : (
                      <button className="btn primary small" disabled={busyId === person.id} onClick={() => void perform(person.id, () => api.post(`/api/network/friends/${person.id}`), fa ? 'درخواست دوستی ارسال شد.' : 'Friend request sent.')}>
                        <Icon name="add" size={16} /> {fa ? 'افزودن دوست' : 'Add Friend'}
                      </button>
                    )}
                  </PersonRow>
                );
              }) : (
                <EmptyState icon={<Icon name="users" size={32} />} title={fa ? 'کسی پیدا نشد' : 'No one found'}>
                  {fa ? 'نام کاربری را بررسی کنید و دوباره تلاش کنید.' : 'Check the username and try again.'}
                </EmptyState>
              )}
            </div>
          ) : tab === 'blocked' ? (
            <div className="friend-cards">
              {blocked.length ? blocked.map((person) => (
                <PersonRow key={person.id} person={person} presence="offline">
                  <button className="btn small" disabled={busyId === person.id} onClick={() => void perform(person.id, () => api.del(`/api/users/${person.id}/block`), fa ? 'مسدودیت برداشته شد.' : 'User unblocked.')}>{fa ? 'رفع مسدودیت' : 'Unblock'}</button>
                </PersonRow>
              )) : <FriendEmpty tab={tab} fa={fa} />}
            </div>
          ) : (
            <div className="friend-cards">
              <div className="friend-list-label">{visible.length} {fa ? 'نفر' : visible.length === 1 ? 'person' : 'people'}</div>
              {visible.length ? visible.map((item) => (
                <PersonRow key={item.id} person={item.user} presence={presence[item.user.id] ?? item.user.presence}>
                  {item.status === 'pending' && item.direction === 'incoming' ? (
                    <>
                      <button className="friend-icon-btn success" disabled={busyId === item.id} onClick={() => void perform(item.id, () => api.patch(`/api/network/friends/${item.id}`, { status: 'accepted' }), fa ? 'درخواست پذیرفته شد.' : 'Friend request accepted.')} title={fa ? 'پذیرفتن' : 'Accept'}><Icon name="check" size={18} /></button>
                      <button className="friend-icon-btn danger" disabled={busyId === item.id} onClick={() => void perform(item.id, () => api.patch(`/api/network/friends/${item.id}`, { status: 'rejected' }), fa ? 'درخواست رد شد.' : 'Friend request declined.')} title={fa ? 'رد کردن' : 'Decline'}><Icon name="close" size={18} /></button>
                    </>
                  ) : item.status === 'pending' ? (
                    <>
                      <span className="friend-state">{fa ? 'درخواست ارسال‌شده' : 'Outgoing request'}</span>
                      <button className="friend-icon-btn danger" disabled={busyId === item.id} onClick={() => void perform(item.id, () => api.del(`/api/network/friends/${item.id}`), fa ? 'درخواست لغو شد.' : 'Request cancelled.')} title={fa ? 'لغو' : 'Cancel'}><Icon name="close" size={18} /></button>
                    </>
                  ) : (
                    <>
                      <button className="friend-icon-btn primary" disabled={busyId === item.user.id} onClick={() => void message(item.user)} title={fa ? 'پیام' : 'Message'}><Icon name="message" size={18} /></button>
                      <button className="friend-icon-btn" disabled={busyId === item.id} onClick={() => void perform(item.id, () => api.del(`/api/network/friends/${item.id}`), fa ? 'دوست حذف شد.' : 'Friend removed.')} title={fa ? 'حذف دوست' : 'Remove friend'}><Icon name="close" size={18} /></button>
                    </>
                  )}
                </PersonRow>
              )) : <FriendEmpty tab={tab} fa={fa} />}
            </div>
          )}
        </section>

        <aside className="friends-activity">
          <div className="activity-orb"><Icon name="message" size={30} /></div>
          <h3>{fa ? 'همین حالا فعال' : 'Active now'}</h3>
          <p>{fa ? 'وقتی دوستان شما در تماس یا یک کانال صوتی باشند، اینجا نمایش داده می‌شوند.' : 'When friends are in calls or voice channels, their activity will appear here.'}</p>
          <div className="activity-stats">
            <span><strong>{accepted.length}</strong>{fa ? 'دوست' : 'friends'}</span>
            <span><strong>{accepted.filter((item) => (presence[item.user.id] ?? item.user.presence) !== 'offline').length}</strong>{fa ? 'آنلاین' : 'online'}</span>
            <span><strong>{pending.filter((item) => item.direction === 'incoming').length}</strong>{fa ? 'درخواست' : 'requests'}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PersonRow({
  person,
  presence,
  children,
}: {
  person: PublicUser;
  presence: PublicUser['presence'];
  children: React.ReactNode;
}) {
  return (
    <div className="friend-row">
      <Avatar name={person.displayName} id={person.id} src={person.avatarUrl} color={person.bannerColor} size={42} presence={presence} />
      <div className="friend-who">
        <strong>{person.displayName}</strong>
        <span>@{person.username} · {presence === 'offline' ? 'Offline' : presence === 'dnd' ? 'Do Not Disturb' : presence[0].toUpperCase() + presence.slice(1)}</span>
      </div>
      <div className="friend-actions">{children}</div>
    </div>
  );
}

function FriendEmpty({ tab, fa }: { tab: FriendTab; fa: boolean }) {
  const title = tab === 'online' ? (fa ? 'فعلاً کسی آنلاین نیست' : 'Quiet for the moment') : tab === 'pending' ? (fa ? 'درخواستی ندارید' : 'No pending requests') : tab === 'blocked' ? (fa ? 'فهرست مسدود خالی است' : 'Your block list is empty') : (fa ? 'هنوز دوستی ندارید' : 'No friends here yet');
  return <EmptyState icon={<Icon name="users" size={34} />} title={title}>{fa ? 'از بخش افزودن دوست شروع کنید.' : 'Use Add Friend to start building your circle.'}</EmptyState>;
}
