import { useEffect, useState } from 'react';
import { Avatar, BadgeList, EmptyState, RoleBadge } from '../components/ui';
import { useChat } from '../store/chat';
import { useRealtime } from '../store/realtime';
import { useSession } from '../store/session';
import { toast } from '../store/toast';
import { ApiError } from '../lib/api';
import { formatRelative } from '../lib/format';
import type { Conversation } from '../types';
import { useI18n } from '../lib/i18n';
import { Icon } from '../components/Icon';

/**
 * The member directory. Every account can see every other account — that is a
 * deliberate product decision for this server, not an oversight.
 */
export function Directory({ onOpenConversation }: { onOpenConversation: (c: Conversation) => void }) {
  const me = useSession((state) => state.user)!;
  const settings = useSession((state) => state.settings);
  const directory = useChat((state) => state.directory);
  const loadDirectory = useChat((state) => state.loadDirectory);
  const openDm = useChat((state) => state.openDm);
  const presence = useRealtime((state) => state.presence);

  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      void loadDirectory(search).finally(() => setLoading(false));
    }, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [search, loadDirectory]);

  return (
    <div className="main">
      <div className="main-head">
        <div className="title">
          <span className="glyph channel-glyph"><Icon name="directory" size={18} /></span>
          <span>{fa ? 'فهرست اعضا' : 'Member directory'}</span>
        </div>
        <div className="topic">{fa ? `${directory.length} حساب در این سرور` : `${directory.length} account(s) on this server`}</div>
        <div className="spacer" />
        <input
          className="head-search"
          placeholder={fa ? 'جست‌وجو…' : 'Search…'}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="directory-content">
        {loading && directory.length === 0 ? (
          <div className="center-screen">
            <span className="spinner" />
          </div>
        ) : directory.length === 0 ? (
          <EmptyState icon={<Icon name="search" size={34} />} title={fa ? 'نتیجه‌ای پیدا نشد' : 'Nobody matched'}>
            {fa ? 'نام یا نام کاربری دیگری را امتحان کنید.' : 'Try a different name or username.'}
          </EmptyState>
        ) : (
          <div className="directory-grid">
            {directory.map((person) => {
              const live = presence[person.id] ?? person.presence;
              return (
                <div
                  key={person.id}
                  className="stat-card directory-card"
                >
                  <Avatar
                    name={person.displayName}
                    id={person.id}
                    src={person.avatarUrl}
                    color={person.bannerColor}
                    size={44}
                    presence={live}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {person.displayName}
                      </strong>
                      <BadgeList badges={person.badges} compact />
                    </div>
                    <div className="faint small">@{person.username}</div>
                    <div style={{ marginTop: 5 }}>
                      <RoleBadge role={person.role} />
                      <BadgeList badges={person.badges} />
                    </div>
                    {person.customStatus ? (
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {person.customStatus}
                      </div>
                    ) : null}
                    <div className="faint small" style={{ marginTop: 4 }}>
                      {live === 'offline'
                        ? `${fa ? 'آخرین بازدید' : 'Last seen'} ${formatRelative(person.lastSeenAt)}`
                        : (fa ? ({ online: 'آنلاین', idle: 'بیکار', dnd: 'مزاحم نشوید' }[live] ?? live) : live)}
                    </div>

                    {person.id !== me.id && settings?.allow_dms ? (
                      <button
                        className="btn small mt-16"
                        onClick={async () => {
                          try {
                            onOpenConversation(await openDm(person.id));
                          } catch (error) {
                            toast.error(
                              error instanceof ApiError ? error.message : (fa ? 'بازکردن گفتگو انجام نشد.' : 'Could not open a conversation.'),
                            );
                          }
                        }}
                      >
                        <Icon name="message" size={15} /> {fa ? 'پیام' : 'Message'}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
