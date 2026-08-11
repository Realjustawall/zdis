import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { Avatar, BadgeList, Modal, RoleBadge } from '../components/ui';
import { useSession } from '../store/session';
import { useChat } from '../store/chat';
import { toast } from '../store/toast';
import type {
  AccessRequest,
  Badge,
  Collab,
  Friendship,
  LinkedAccount,
  PublicUser,
} from '../types';
import { Icon } from '../components/Icon';

interface NetworkData {
  friendships: Friendship[];
  collabs: Collab[];
  accessRequests: AccessRequest[];
  linkedAccounts: LinkedAccount[];
}

const empty: NetworkData = {
  friendships: [],
  collabs: [],
  accessRequests: [],
  linkedAccounts: [],
};

export function Network() {
  const me = useSession((state) => state.user)!;
  const directory = useChat((state) => state.directory);
  const loadDirectory = useChat((state) => state.loadDirectory);
  const loadInitial = useChat((state) => state.loadInitial);
  const [data, setData] = useState<NetworkData>(empty);
  const [roster, setRoster] = useState<PublicUser[]>([]);
  const [rosterQuota, setRosterQuota] = useState<{ used: number; limit: number | null }>({
    used: 0,
    limit: 10,
  });
  const [catalogue, setCatalogue] = useState<Badge[]>([]);
  const [runtime, setRuntime] = useState<{
    database: string;
    cache: string;
    uptimeSeconds: number;
    node: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [rosterOpen, setRosterOpen] = useState(false);

  const canStream =
    me.role === 'admin' || me.role === 'youtuber' || me.badges.some((badge) => badge.id === 'streamer');
  const canDebug =
    me.role === 'admin' || me.badges.some((badge) => badge.id === 'developer');

  async function refresh() {
    setLoading(true);
    try {
      const [network, badgeData] = await Promise.all([
        api.get<NetworkData>('/api/network'),
        api.get<{ badges: Badge[] }>('/api/network/badges'),
        loadDirectory(),
      ]);
      setData(network);
      setCatalogue(badgeData.badges);
      if (canStream) {
        const rosterData = await api.get<{
          users: PublicUser[];
          quota: { used: number; limit: number | null };
        }>('/api/network/roster');
        setRoster(rosterData.users);
        setRosterQuota(rosterData.quota);
      }
      if (canDebug) {
        setRuntime(
          await api.get<{
            database: string;
            cache: string;
            uptimeSeconds: number;
            node: string;
          }>('/api/network/runtime'),
        );
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not load your network.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function action<T>(request: () => Promise<T>, success: string) {
    try {
      await request();
      toast.success(success);
      await refresh();
      await loadInitial();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'That action failed.');
    }
  }

  const otherPeople = directory.filter((person) => person.id !== me.id && person.isActive);
  const streamers = otherPeople.filter(
    (person) =>
      person.role === 'admin' ||
      person.role === 'youtuber' ||
      person.badges.some((badge) => badge.id === 'streamer'),
  );
  const scopedPeople = otherPeople.filter((person) => person.ownerStreamerId);

  return (
    <div className="main">
      <div className="main-head">
        <div className="title">
          <span className="glyph channel-glyph"><Icon name="compass" size={18} /></span>
          <span>Network</span>
        </div>
        <div className="topic">Friends, collaborations, roster and public profiles</div>
        <div className="spacer" />
        <button className="btn small" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="directory-content network-content">
        {runtime ? (
          <section className="settings-group">
            <h3>Developer runtime</h3>
            <div className="row wrap" style={{ gap: 18 }}>
              <span>Database: <strong>{runtime.database}</strong></span>
              <span>Cache: <strong>{runtime.cache}</strong></span>
              <span>Node: <strong>{runtime.node}</strong></span>
              <span>Uptime: <strong>{Math.round(runtime.uptimeSeconds / 60)} min</strong></span>
            </div>
          </section>
        ) : null}
        <section className="settings-group">
          <div className="row between">
            <div>
              <h3>Friends</h3>
              <p className="desc">Connect with another account without opening a group.</p>
            </div>
            <RequestPicker
              label="Add friend"
              people={otherPeople}
              onPick={(userId) =>
                action(() => api.post(`/api/network/friends/${userId}`), 'Friend request sent.')
              }
            />
          </div>
          <NetworkRows
            emptyText="No friend activity yet."
            rows={data.friendships.map((item) => ({
              key: item.id,
              person: item.user,
              detail:
                item.status === 'pending'
                  ? `${item.direction} request`
                  : item.status === 'accepted'
                    ? 'Friend'
                    : 'Request declined',
              actions:
                item.status === 'pending' && item.direction === 'incoming' ? (
                  <>
                    <button
                      className="btn small primary"
                      onClick={() =>
                        void action(
                          () => api.patch(`/api/network/friends/${item.id}`, { status: 'accepted' }),
                          'Friend request accepted.',
                        )
                      }
                    >
                      Accept
                    </button>
                    <button
                      className="btn small"
                      onClick={() =>
                        void action(
                          () => api.patch(`/api/network/friends/${item.id}`, { status: 'rejected' }),
                          'Friend request declined.',
                        )
                      }
                    >
                      Decline
                    </button>
                  </>
                ) : (
                  <button
                    className="btn small danger"
                    onClick={() =>
                      void action(
                        () => api.del(`/api/network/friends/${item.id}`),
                        item.status === 'accepted' ? 'Friend removed.' : 'Request removed.',
                      )
                    }
                  >
                    Remove
                  </button>
                ),
            }))}
          />
        </section>

        {canStream ? (
          <section className="settings-group">
            <div className="row between">
              <div>
                <h3>Collaborations</h3>
                <p className="desc">An accepted request creates a shared group automatically.</p>
              </div>
              <RequestPicker
                label="New collab"
                people={streamers}
                onPick={(partnerId) =>
                  action(
                    () => api.post('/api/network/collabs', { partnerId }),
                    'Collaboration request sent.',
                  )
                }
              />
            </div>
            <NetworkRows
              emptyText="No collaborations yet."
              rows={data.collabs.map((item) => {
                const incoming = item.partner?.id === me.id && item.status === 'pending';
                const person = item.initiator?.id === me.id ? item.partner : item.initiator;
                return {
                  key: item.id,
                  person,
                  detail: `${item.title ?? 'Collaboration'} · ${item.status}`,
                  actions: incoming ? (
                    <>
                      <button
                        className="btn small primary"
                        onClick={() =>
                          void action(
                            () => api.patch(`/api/network/collabs/${item.id}`, { status: 'accepted' }),
                            'Collaboration accepted and group created.',
                          )
                        }
                      >
                        Accept
                      </button>
                      <button
                        className="btn small"
                        onClick={() =>
                          void action(
                            () => api.patch(`/api/network/collabs/${item.id}`, { status: 'rejected' }),
                            'Collaboration declined.',
                          )
                        }
                      >
                        Decline
                      </button>
                    </>
                  ) : item.status === 'pending' && item.initiator?.id === me.id ? (
                    <button
                      className="btn small danger"
                      onClick={() =>
                        void action(
                          () => api.del(`/api/network/collabs/${item.id}`),
                          'Collaboration request cancelled.',
                        )
                      }
                    >
                      Cancel
                    </button>
                  ) : null,
                };
              })}
            />
          </section>
        ) : null}

        <section className="settings-group">
          <div className="row between">
            <div>
              <h3>Roster access</h3>
              <p className="desc">Members decide which additional streamer may invite or label them.</p>
            </div>
            {canStream ? (
              <RequestPicker
                label="Request access"
                people={scopedPeople}
                onPick={(userId) =>
                  action(
                    () => api.post('/api/network/access-requests', { userId }),
                    'Access request sent.',
                  )
                }
              />
            ) : null}
          </div>
          <NetworkRows
            emptyText="No roster access requests."
            rows={data.accessRequests.map((item) => {
              const incoming = item.user?.id === me.id && item.status === 'pending';
              const person = item.streamer?.id === me.id ? item.user : item.streamer;
              return {
                key: item.id,
                person,
                detail: `Roster access · ${item.status}`,
                actions: incoming ? (
                  <>
                    <button
                      className="btn small primary"
                      onClick={() =>
                        void action(
                          () =>
                            api.patch(`/api/network/access-requests/${item.id}`, {
                              status: 'accepted',
                            }),
                          'Roster access granted.',
                        )
                      }
                    >
                      Accept
                    </button>
                    <button
                      className="btn small"
                      onClick={() =>
                        void action(
                          () =>
                            api.patch(`/api/network/access-requests/${item.id}`, {
                              status: 'rejected',
                            }),
                          'Roster access declined.',
                        )
                      }
                    >
                      Decline
                    </button>
                  </>
                ) : (
                  <button
                    className="btn small danger"
                    onClick={() =>
                      void action(
                        () => api.del(`/api/network/access-requests/${item.id}`),
                        'Access record removed.',
                      )
                    }
                  >
                    Remove
                  </button>
                ),
              };
            })}
          />
        </section>

        {canStream ? (
          <section className="settings-group">
            <div className="row between">
              <div>
                <h3>Your roster</h3>
                <p className="desc">
                  Accounts you provision are scoped to your groups.{' '}
                  {rosterQuota.limit === null
                    ? `${rosterQuota.used} created · unlimited for administrators`
                    : `${rosterQuota.used} of ${rosterQuota.limit} used`}
                </p>
              </div>
              <button
                className="btn small primary"
                onClick={() => setRosterOpen(true)}
                disabled={rosterQuota.limit !== null && rosterQuota.used >= rosterQuota.limit}
              >
                Provision account
              </button>
            </div>
            <NetworkRows
              emptyText="Your roster is empty."
              rows={roster.map((person) => ({
                key: person.id,
                person,
                detail: 'Scoped roster account',
                actions: (
                  <SecondaryBadges
                    person={person}
                    catalogue={catalogue.filter((badge) => badge.kind === 'secondary')}
                    onSaved={refresh}
                  />
                ),
              }))}
            />
          </section>
        ) : null}

        <LinkedAccounts accounts={data.linkedAccounts} onChanged={refresh} />
      </div>

      {rosterOpen ? (
        <RosterModal
          onClose={() => setRosterOpen(false)}
          onCreated={() => {
            setRosterOpen(false);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function RequestPicker({
  label,
  people,
  onPick,
}: {
  label: string;
  people: PublicUser[];
  onPick: (id: string) => Promise<unknown>;
}) {
  const [selected, setSelected] = useState('');
  return (
    <div className="row">
      <select className="select" value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">Choose account…</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.displayName} (@{person.username})
          </option>
        ))}
      </select>
      <button
        className="btn small"
        disabled={!selected}
        onClick={() => {
          if (selected) void onPick(selected).then(() => setSelected(''));
        }}
      >
        {label}
      </button>
    </div>
  );
}

interface Row {
  key: string;
  person: PublicUser | null;
  detail: string;
  actions: ReactNode;
}

function NetworkRows({ rows, emptyText }: { rows: Row[]; emptyText: string }) {
  if (!rows.length) return <p className="faint small">{emptyText}</p>;
  return (
    <div className="col" style={{ gap: 8 }}>
      {rows.map((row) => (
        <div className="stat-card row between" key={row.key}>
          <div className="identity">
            <Avatar
              name={row.person?.displayName ?? 'Deleted account'}
              id={row.person?.id}
              src={row.person?.avatarUrl}
              color={row.person?.bannerColor}
              size={34}
            />
            <div className="who">
              <div className="name">{row.person?.displayName ?? 'Deleted account'}</div>
              <div className="sub">{row.detail}</div>
              {row.person ? <RoleBadge role={row.person.role} /> : null}
              <BadgeList badges={row.person?.badges} />
            </div>
          </div>
          <div className="row">{row.actions}</div>
        </div>
      ))}
    </div>
  );
}

function SecondaryBadges({
  person,
  catalogue,
  onSaved,
}: {
  person: PublicUser;
  catalogue: Badge[];
  onSaved: () => Promise<void>;
}) {
  const current = useMemo(
    () => new Set(person.badges.filter((badge) => badge.kind === 'secondary').map((badge) => badge.id)),
    [person.badges],
  );
  return (
    <div className="row wrap">
      {catalogue.map((badge) => (
        <label className="checkbox" key={badge.id}>
          <input
            type="checkbox"
            checked={current.has(badge.id)}
            onChange={async (event) => {
              const next = new Set(current);
              if (event.target.checked) next.add(badge.id);
              else next.delete(badge.id);
              try {
                await api.put(`/api/network/badges/${person.id}/secondary`, {
                  badgeIds: [...next],
                });
                toast.success('Roster labels updated.');
                await onSaved();
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'Could not update labels.');
              }
            }}
          />
          <span style={{ color: badge.color }}>{badge.label}</span>
        </label>
      ))}
    </div>
  );
}

function LinkedAccounts({
  accounts,
  onChanged,
}: {
  accounts: LinkedAccount[];
  onChanged: () => Promise<void>;
}) {
  const [platform, setPlatform] = useState('youtube');
  const [handle, setHandle] = useState('');
  const [url, setUrl] = useState('');
  return (
    <section className="settings-group">
      <h3>Linked profiles</h3>
      <p className="desc">Add public creator profiles. An administrator may verify them.</p>
      <div className="row wrap">
        <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {['youtube', 'twitch', 'kick', 'instagram', 'tiktok', 'x', 'website', 'github'].map(
            (item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ),
          )}
        </select>
        <input
          className="input"
          placeholder="Handle"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
        <input
          className="input"
          placeholder="https://… (optional)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          className="btn"
          disabled={!handle.trim()}
          onClick={async () => {
            try {
              await api.post('/api/network/linked-accounts', {
                platform,
                handle: handle.trim(),
                url: url.trim() || null,
              });
              setHandle('');
              setUrl('');
              toast.success('Profile linked.');
              await onChanged();
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not link profile.');
            }
          }}
        >
          Add
        </button>
      </div>
      <div className="col mt-16">
        {accounts.map((account) => (
          <div className="row between" key={account.id}>
            <span>
              <strong>{account.platform}</strong> · {account.handle}{' '}
              {account.verified ? <span className="badge moderator">verified</span> : null}
            </span>
            <button
              className="btn small danger"
              onClick={async () => {
                await api.del(`/api/network/linked-accounts/${account.id}`);
                await onChanged();
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function RosterModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    displayName: '',
    username: '',
    email: '',
    password: '',
    mustChangePassword: true,
  });
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <Modal
      title="Provision roster account"
      description="This account can join your spaces and any streamer spaces they explicitly approve."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy || !form.email || !form.username || !form.displayName || !form.password}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/network/roster', form);
                toast.success('Roster account created.');
                onCreated();
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'Could not create account.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field">
          <label>Display name</label>
          <input className="input" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} />
        </div>
        <div className="field">
          <label>Username</label>
          <input className="input" value={form.username} onChange={(e) => set('username', e.target.value.toLowerCase())} />
        </div>
      </div>
      <div className="field">
        <label>Email</label>
        <input className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
      </div>
      <div className="field">
        <label>Temporary password</label>
        <div className="row">
          <input className="input mono" value={form.password} onChange={(e) => set('password', e.target.value)} />
          <button
            className="btn"
            onClick={async () => {
              const result = await api.get<{ password: string }>('/api/network/roster/suggest-password');
              set('password', result.password);
            }}
          >
            Generate
          </button>
        </div>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.mustChangePassword}
          onChange={(e) => set('mustChangePassword', e.target.checked)}
        />
        <span>Require password change on first sign-in</span>
      </label>
    </Modal>
  );
}
