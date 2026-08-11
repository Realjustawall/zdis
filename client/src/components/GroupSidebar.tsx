import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Modal, Confirm, EmptyState } from './ui';
import { useChat } from '../store/chat';
import { useRealtime } from '../store/realtime';
import { useSession } from '../store/session';
import { useVoice } from '../store/voice';
import { toast } from '../store/toast';
import { api, ApiError } from '../lib/api';
import type {
  Channel,
  ChannelCategory,
  Group,
  GroupExpression,
  GroupMember,
  GroupPermissions,
  Invite,
  ServerPermission,
  ServerRole,
} from '../types';
import type { CSSProperties, DragEvent, ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';
import { storageGet, storageSet } from '../lib/storage';

interface Props {
  group: Group;
  channels: Channel[];
  categories: ChannelCategory[];
  members: GroupMember[];
  invites: Invite[];
  roles: ServerRole[];
  permissions: GroupPermissions;
  activeChannelId: string | null;
  onSelectChannel: (channel: Channel) => void;
  onRefresh: () => void;
  footer: ReactNode;
}

interface ChannelPermissionOverride {
  channelId: string;
  groupId: string;
  targetType: 'everyone' | 'role' | 'member';
  targetId: string;
  allow: ServerPermission[];
  deny: ServerPermission[];
}

export function GroupSidebar({
  group,
  channels,
  categories,
  members,
  invites,
  roles,
  permissions,
  activeChannelId,
  onSelectChannel,
  onRefresh,
  footer,
}: Props) {
  const user = useSession((state) => state.user)!;
  const unread = useChat((state) => state.unreadChannels);
  const voiceRooms = useRealtime((state) => state.voice);
  const voiceChannelId = useVoice((state) => state.channelId);
  const removeGroup = useChat((state) => state.removeGroup);
  const directory = useChat((state) => state.directory);
  const loadDirectory = useChat((state) => state.loadDirectory);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  const [menu, setMenu] = useState<
    null | 'channel' | 'category' | 'invite' | 'members' | 'roles' | 'settings' | 'delete' | 'leave'
  >(null);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [permissionChannel, setPermissionChannel] = useState<Channel | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(storageGet(`zdis.collapsed-categories:${group.id}`) ?? '[]'));
    } catch {
      return new Set();
    }
  });

  const textChannels = useMemo(
    () => channels.filter((c) => !c.categoryId && (c.type === 'text' || c.type === 'announcement')),
    [channels],
  );
  const forumChannels = useMemo(() => channels.filter((c) => !c.categoryId && c.type === 'forum'), [channels]);
  const voiceChannels = useMemo(
    () => channels.filter((c) => !c.categoryId && (c.type === 'voice' || c.type === 'stage')),
    [channels],
  );

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const candidates = useMemo(
    () => directory.filter((person) => !memberIds.has(person.id) && person.isActive),
    [directory, memberIds],
  );

  function toggleCategory(categoryId: string) {
    setCollapsedCategories((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      storageSet(`zdis.collapsed-categories:${group.id}`, JSON.stringify([...next]));
      return next;
    });
  }

  function renderCategorizedChannel(channel: Channel) {
    const counts = unread[channel.id];
    const isActive = channel.id === activeChannelId;
    const inRoom = voiceRooms[channel.id] ?? [];
    const icon = channel.type === 'announcement'
      ? 'announcement'
      : channel.type === 'forum'
        ? 'forum'
        : channel.type === 'stage'
          ? 'microphone'
          : channel.type === 'voice'
            ? 'speaker'
            : channel.isPrivate
              ? 'lock'
              : 'hash';
    return (
      <div className="category-channel" key={channel.id}>
        <div className="channel-nav-row">
          <button
            className={`nav-item${isActive ? ' active' : ''}${counts?.unread && !isActive ? ' unread' : ''}`}
            onClick={() => onSelectChannel(channel)}
          >
            <span className="glyph"><Icon name={icon} size={17} /></span>
            <span className="label">{channel.name}</span>
            {counts?.mentions ? <span className="count">{counts.mentions > 99 ? '99+' : counts.mentions}</span> : null}
            {voiceChannelId === channel.id ? <span className="badge moderator">{fa ? 'فعال' : 'live'}</span> : null}
          </button>
          {permissions.manageChannels ? (
            <button className="channel-manage-btn" title={`Edit ${channel.name}`} onClick={() => setEditingChannel(channel)}>
              <Icon name="settings" size={14} />
            </button>
          ) : null}
        </div>
        {inRoom.length ? (
          <div className="voice-members">
            {inRoom.map((participant) => {
              const member = members.find((item) => item.id === participant.userId);
              return (
                <div className={`voice-member${participant.speaking ? ' speaking' : ''}`} key={participant.userId}>
                  <Avatar name={member?.displayName ?? (fa ? 'یک نفر' : 'Someone')} id={participant.userId} color={member?.bannerColor} size={20} />
                  <span>{member?.displayName ?? (fa ? 'یک نفر' : 'Someone')}</span>
                  <span className="flags">
                    {participant.muted ? <Icon name="volumeOff" size={13} /> : null}
                    {participant.video ? <Icon name="video" size={13} /> : null}
                    {participant.screen ? <Icon name="screen" size={13} /> : null}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <h2 title={group.name}>{group.name}</h2>
        <div className="row" style={{ gap: 2 }}>
          {permissions.createInvite ? (
            <button className="head-btn" title={fa ? 'دعوت افراد' : 'Invite people'} onClick={() => setMenu('invite')}>
              <Icon name="link" size={17} />
            </button>
          ) : null}
          {permissions.manageMembers ? (
            <button
              className="head-btn"
              title={fa ? 'افزودن عضو' : 'Add a member'}
              onClick={() => {
                void loadDirectory();
                setMenu('members');
              }}
            >
              <Icon name="add" size={18} />
            </button>
          ) : null}
          {permissions.manageGroup ||
          permissions.manageRoles ||
          permissions.manageMembers ||
            permissions.manageChannels ? (
            <button className="head-btn" title={fa ? 'تنظیمات گروه' : 'Group settings'} onClick={() => setMenu('settings')}>
              <Icon name="settings" size={18} />
            </button>
          ) : null}
        </div>
      </div>

      {permissions.manageGroup || permissions.manageRoles || permissions.manageChannels ? (
        <div className="sidebar-admin-actions">
          {permissions.manageGroup ||
          permissions.manageMembers ||
          permissions.manageChannels ? (
            <button onClick={() => setMenu('settings')}><Icon name="settings" size={15} /> <span>Server Settings</span></button>
          ) : null}
          {permissions.manageRoles ? (
            <button onClick={() => setMenu('roles')}><Icon name="tag" size={15} /> <span>Roles</span></button>
          ) : null}
          {permissions.manageChannels ? (
            <button onClick={() => setMenu('channel')}><Icon name="add" size={15} /> <span>Channel</span></button>
          ) : null}
          {permissions.manageChannels ? (
            <button onClick={() => setMenu('category')}><Icon name="add" size={15} /> <span>Category</span></button>
          ) : null}
        </div>
      ) : null}

      <div className="sidebar-body">
        {categories.map((category) => {
          const categoryChannels = channels
            .filter((channel) => channel.categoryId === category.id)
            .sort((a, b) => a.position - b.position);
          const collapsed = collapsedCategories.has(category.id);
          const categoryUnread = categoryChannels.reduce((sum, channel) => sum + (unread[channel.id]?.unread ?? 0), 0);
          const categoryMentions = categoryChannels.reduce((sum, channel) => sum + (unread[channel.id]?.mentions ?? 0), 0);
          return (
            <section className={`channel-category${collapsed ? ' collapsed' : ''}${categoryUnread ? ' has-unread' : ''}`} key={category.id}>
              <div className="section-label category-label">
                <button className="category-toggle" onClick={() => toggleCategory(category.id)} title={collapsed ? (fa ? 'باز کردن' : 'Expand') : (fa ? 'بستن' : 'Collapse')}>
                  <span className="category-chevron">›</span>
                  <span>{category.name}</span>
                </button>
                {collapsed && categoryMentions > 0 ? <span className="category-mention-count">{categoryMentions > 99 ? '99+' : categoryMentions}</span> : null}
                {collapsed && categoryUnread > 0 && categoryMentions === 0 ? <span className="category-unread-dot" /> : null}
                {permissions.manageChannels ? (
                  <button title={fa ? 'کانال جدید' : 'New channel'} onClick={() => setMenu('channel')}><Icon name="add" size={14} /></button>
                ) : null}
              </div>
              {!collapsed ? categoryChannels.map(renderCategorizedChannel) : null}
            </section>
          );
        })}

        <div className="section-label">
          <span>{fa ? 'کانال‌های متنی' : 'Text channels'}</span>
          {permissions.manageChannels ? (
            <button title={fa ? 'کانال جدید' : 'New channel'} onClick={() => setMenu('channel')}>
              <Icon name="add" size={14} />
            </button>
          ) : null}
        </div>
        {textChannels.map((channel) => {
          const counts = unread[channel.id];
          const isActive = channel.id === activeChannelId;
          return (
            <div className="channel-nav-row" key={channel.id}>
              <button
                className={`nav-item${isActive ? ' active' : ''}${counts?.unread && !isActive ? ' unread' : ''}`}
                onClick={() => onSelectChannel(channel)}
              >
                <span className="glyph">
                  <Icon name={channel.type === 'announcement' ? 'announcement' : channel.isPrivate ? 'lock' : 'hash'} size={17} />
                </span>
                <span className="label">{channel.name}</span>
                {counts?.mentions ? <span className="count">{counts.mentions > 99 ? '99+' : counts.mentions}</span> : null}
              </button>
              {permissions.manageChannels ? (
                <button
                  className="channel-manage-btn"
                  title={`Edit #${channel.name}`}
                  onClick={() => setEditingChannel(channel)}
                >
                  <Icon name="settings" size={14} />
                </button>
              ) : null}
            </div>
          );
        })}

        {forumChannels.length || permissions.manageChannels ? (
          <div className="section-label">
            <span>{fa ? 'انجمن‌ها' : 'Forums'}</span>
          </div>
        ) : null}
        {forumChannels.map((channel) => {
          const counts = unread[channel.id];
          const isActive = channel.id === activeChannelId;
          return <div className="channel-nav-row" key={channel.id}>
            <button
              className={`nav-item${isActive ? ' active' : ''}${counts?.unread && !isActive ? ' unread' : ''}`}
              onClick={() => onSelectChannel(channel)}
            >
              <span className="glyph"><Icon name="forum" size={17} /></span>
              <span className="label">{channel.name}</span>
              {counts?.mentions ? <span className="count">{counts.mentions > 99 ? '99+' : counts.mentions}</span> : null}
            </button>
            {permissions.manageChannels ? (
              <button
                className="channel-manage-btn"
                title={`Edit ${channel.name}`}
                onClick={() => setEditingChannel(channel)}
              >
                <Icon name="settings" size={14} />
              </button>
            ) : null}
          </div>;
        })}

        <div className="section-label">
          <span>{fa ? 'کانال‌های صوتی' : 'Voice channels'}</span>
        </div>
        {voiceChannels.map((channel) => {
          const inRoom = voiceRooms[channel.id] ?? [];
          const counts = unread[channel.id];
          const isActive = channel.id === activeChannelId;
          return (
            <div key={channel.id}>
              <div className="channel-nav-row">
                <button
                  className={`nav-item${isActive ? ' active' : ''}${counts?.unread && !isActive ? ' unread' : ''}`}
                  onClick={() => onSelectChannel(channel)}
                >
                  <span className="glyph"><Icon name={channel.type === 'stage' ? 'microphone' : 'speaker'} size={17} /></span>
                  <span className="label">{channel.name}</span>
                  {counts?.mentions ? <span className="count">{counts.mentions > 99 ? '99+' : counts.mentions}</span> : null}
                  {voiceChannelId === channel.id ? <span className="badge moderator">{fa ? 'فعال' : 'live'}</span> : null}
                </button>
                {permissions.manageChannels ? (
                  <button
                    className="channel-manage-btn"
                    title={`Edit ${channel.name}`}
                    onClick={() => setEditingChannel(channel)}
                  >
                    <Icon name="settings" size={14} />
                  </button>
                ) : null}
              </div>
              {inRoom.length > 0 ? (
                <div className="voice-members">
                  {inRoom.map((participant) => {
                    const member = members.find((m) => m.id === participant.userId);
                    return (
                      <div
                        className={`voice-member${participant.speaking ? ' speaking' : ''}`}
                        key={participant.userId}
                      >
                        <Avatar
                          name={member?.displayName ?? (fa ? 'یک نفر' : 'Someone')}
                          id={participant.userId}
                          color={member?.bannerColor}
                          size={20}
                        />
                        <span>{member?.displayName ?? (fa ? 'یک نفر' : 'Someone')}</span>
                        <span className="flags">
                          {participant.muted ? <Icon name="volumeOff" size={13} /> : null}
                          {participant.video ? <Icon name="video" size={13} /> : null}
                          {participant.screen ? <Icon name="screen" size={13} /> : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="section-label">
          <span>{fa ? 'اعضا' : 'Members'} — {members.length}</span>
        </div>
        {members.slice(0, 40).map((member) => (
          <div className={`nav-item${member.presence === 'offline' ? '' : ''}`} key={member.id}>
            <Avatar
              name={member.displayName}
              id={member.id}
              color={member.bannerColor}
              size={22}
              presence={member.presence}
            />
            <span className="label">{member.nickname ?? member.displayName}</span>
            {member.memberRole === 'owner' ? (
              <span className="badge owner" style={{ fontSize: 9 }}>owner</span>
            ) : member.serverRoles[0] ? (
              <span className="server-role-chip" style={{ borderColor: member.serverRoles[0].color ?? undefined }}>
                <span className="role-dot" style={{ background: member.serverRoles[0].color ?? '#99aab5' }} />
                {member.serverRoles[0].name}
              </span>
            ) : null}
          </div>
        ))}

        {group.ownerId !== user.id && user.role !== 'admin' ? (
          <button className="btn ghost small block mt-16" onClick={() => setMenu('leave')}>
            Leave group
          </button>
        ) : null}
      </div>

      {footer}

      {menu === 'channel' ? (
        <NewChannelModal
          groupId={group.id}
          categories={categories}
          members={members}
          onClose={() => setMenu(null)}
          onDone={onRefresh}
        />
      ) : null}

      {menu === 'category' ? (
        <NewCategoryModal
          groupId={group.id}
          onClose={() => setMenu(null)}
          onDone={onRefresh}
        />
      ) : null}

      {menu === 'invite' ? (
        <InviteModal
          groupId={group.id}
          invites={invites}
          onClose={() => setMenu(null)}
          onDone={onRefresh}
        />
      ) : null}

      {menu === 'members' ? (
        <Modal
          title="Add people to this group"
          description="Anyone you add gets immediate access to every open channel here."
          onClose={() => setMenu(null)}
        >
          <input
            className="input"
            placeholder="Search accounts…"
            onChange={(event) => void loadDirectory(event.target.value)}
          />
          <div className="picker-list">
            {candidates.length === 0 ? (
              <div style={{ padding: 16 }} className="muted small">
                Everyone matching is already in this group.
              </div>
            ) : (
              candidates.map((person) => (
                <button
                  key={person.id}
                  className="picker-row"
                  onClick={async () => {
                    try {
                      await api.post(`/api/groups/${group.id}/members`, { userId: person.id });
                      toast.success(`${person.displayName} was added.`);
                      onRefresh();
                    } catch (error) {
                      toast.error(error instanceof ApiError ? error.message : 'Could not add them.');
                    }
                  }}
                >
                  <Avatar name={person.displayName} id={person.id} color={person.bannerColor} size={32} />
                  <span className="info">
                    <span className="name">{person.displayName}</span>
                    <span className="sub">@{person.username}</span>
                  </span>
                  <span className="badge">add</span>
                </button>
              ))
            )}
          </div>
          <div style={{ height: 16 }} />
        </Modal>
      ) : null}

      {menu === 'settings' ? (
        <GroupSettingsModal
          group={group}
          channels={channels}
          categories={categories}
          members={members}
          invites={invites}
          roles={roles}
          permissions={permissions}
          onClose={() => setMenu(null)}
          onDone={onRefresh}
          onDelete={() => setMenu('delete')}
        />
      ) : null}

      {menu === 'roles' ? (
        <RolesManagementModal
          groupId={group.id}
          roles={roles}
          members={members}
          highestRolePosition={permissions.highestRolePosition}
          onClose={() => setMenu(null)}
          onDone={onRefresh}
        />
      ) : null}

      {editingChannel ? (
        <ChannelSettingsModal
          groupId={group.id}
          channel={editingChannel}
          categories={categories}
          members={members}
          onClose={() => setEditingChannel(null)}
          onDone={() => {
            setEditingChannel(null);
            onRefresh();
          }}
          onPermissions={() => {
            setPermissionChannel(editingChannel);
            setEditingChannel(null);
          }}
        />
      ) : null}

      {permissionChannel ? (
        <ChannelPermissionsModal
          groupId={group.id}
          channel={permissionChannel}
          roles={roles}
          members={members}
          onClose={() => setPermissionChannel(null)}
          onDone={onRefresh}
        />
      ) : null}

      {menu === 'delete' ? (
        <Confirm
          title={`Delete ${group.name}?`}
          message="Every channel, message and file in this group is permanently removed. This cannot be undone."
          confirmLabel="Delete group"
          danger
          onCancel={() => setMenu(null)}
          onConfirm={async () => {
            try {
              await api.del(`/api/groups/${group.id}`);
              removeGroup(group.id);
              toast.success('Group deleted.');
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not delete the group.');
            }
            setMenu(null);
          }}
        />
      ) : null}

      {menu === 'leave' ? (
        <Confirm
          title={`Leave ${group.name}?`}
          message="You will need a new invite to come back."
          confirmLabel="Leave"
          danger
          onCancel={() => setMenu(null)}
          onConfirm={async () => {
            try {
              await api.del(`/api/groups/${group.id}/members/${user.id}`);
              removeGroup(group.id);
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not leave.');
            }
            setMenu(null);
          }}
        />
      ) : null}
    </div>
  );
}

function NewChannelModal({
  groupId,
  categories,
  members,
  onClose,
  onDone,
}: {
  groupId: string;
  categories: ChannelCategory[];
  members: GroupMember[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [type, setType] = useState<'text' | 'voice' | 'forum' | 'stage' | 'announcement'>('text');
  const [isPrivate, setIsPrivate] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [slowmode, setSlowmode] = useState('0');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await api.post(`/api/groups/${groupId}/channels`, {
        name: name.trim(),
        type,
        isPrivate,
        topic: topic.trim() || null,
        slowmode: Number(slowmode) || 0,
        memberIds: isPrivate ? memberIds : [],
        categoryId: categoryId || null,
      });
      toast.success('Channel created.');
      onDone();
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the channel.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New channel"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy || name.trim().length < 1}>
            {busy ? 'Creating…' : 'Create channel'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Channel type</label>
        <div className="channel-type-picker">
          <button
            className={`channel-type-option${type === 'text' ? ' active' : ''}`}
            onClick={() => setType('text')}
            type="button"
          >
            <Icon name="hash" size={19} /><span>Text</span>
          </button>
          <button
            className={`channel-type-option${type === 'voice' ? ' active' : ''}`}
            onClick={() => setType('voice')}
            type="button"
          >
            <Icon name="speaker" size={19} /><span>Voice</span>
          </button>
          <button
            className={`channel-type-option${type === 'forum' ? ' active' : ''}`}
            onClick={() => setType('forum')}
            type="button"
          >
            <Icon name="forum" size={19} /><span>Forum</span>
          </button>
          <button
            className={`channel-type-option${type === 'stage' ? ' active' : ''}`}
            onClick={() => setType('stage')}
            type="button"
          >
            <Icon name="microphone" size={19} /><span>Stage</span>
          </button>
          <button
            className={`channel-type-option${type === 'announcement' ? ' active' : ''}`}
            onClick={() => setType('announcement')}
            type="button"
          >
            <Icon name="announcement" size={19} /><span>Announcement</span>
          </button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="channel-name">Name</label>
        <input
          id="channel-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={
            type === 'text'
              ? 'video-ideas'
              : type === 'forum'
                ? 'community-help'
                : type === 'stage'
                  ? 'Town Hall'
                  : 'Recording Booth'
          }
          maxLength={48}
        />
      </div>
      {['text', 'forum', 'announcement'].includes(type) ? (
        <div className="field">
          <label htmlFor="new-channel-topic">Topic / description</label>
          <textarea
            id="new-channel-topic"
            className="textarea"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            maxLength={200}
            placeholder="What is this channel for?"
          />
        </div>
      ) : null}
      {['text', 'forum', 'announcement'].includes(type) ? (
        <div className="field">
          <label htmlFor="new-channel-slowmode">Slowmode</label>
          <select
            id="new-channel-slowmode"
            className="select"
            value={slowmode}
            onChange={(event) => setSlowmode(event.target.value)}
          >
            <option value="0">Off</option>
            <option value="5">5 seconds</option>
            <option value="10">10 seconds</option>
            <option value="30">30 seconds</option>
            <option value="60">1 minute</option>
            <option value="300">5 minutes</option>
            <option value="900">15 minutes</option>
            <option value="3600">1 hour</option>
          </select>
        </div>
      ) : null}
      <label className="checkbox">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
        <span>
          Private channel
          <br />
          <span className="hint">Only people you invite to it can see this channel.</span>
        </span>
      </label>
      {isPrivate ? (
        <div className="field">
          <label>Who can access this channel?</label>
          <div className="picker-list" style={{ maxHeight: 220 }}>
            {members.map((member) => (
              <label className="picker-row" key={member.id}>
                <Avatar
                  name={member.displayName}
                  id={member.id}
                  color={member.bannerColor}
                  size={30}
                />
                <span className="info">
                  <span className="name">{member.displayName}</span>
                  <span className="sub">@{member.username}</span>
                </span>
                <input
                  type="checkbox"
                  checked={memberIds.includes(member.id)}
                  onChange={(event) =>
                    setMemberIds((current) =>
                      event.target.checked
                        ? [...new Set([...current, member.id])]
                        : current.filter((id) => id !== member.id),
                    )
                  }
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <div className="field">
        <label>Category</label>
        <select
          className="select"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
        >
          <option value="">No category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>
      <div style={{ height: 12 }} />
    </Modal>
  );
}

function ChannelSettingsModal({
  groupId,
  channel,
  categories,
  members,
  onClose,
  onDone,
  onPermissions,
}: {
  groupId: string;
  channel: Channel;
  categories: ChannelCategory[];
  members: GroupMember[];
  onClose: () => void;
  onDone: () => void;
  onPermissions: () => void;
}) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [categoryId, setCategoryId] = useState(channel.categoryId ?? '');
  const [slowmode, setSlowmode] = useState(String(channel.slowmode));
  const [isPrivate, setIsPrivate] = useState(channel.isPrivate);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!channel.isPrivate) {
      setMemberIds(new Set());
      return;
    }
    let active = true;
    void api
      .get<{ memberIds: string[] }>(
        `/api/groups/${groupId}/channels/${channel.id}/members`,
      )
      .then((result) => {
        if (active) setMemberIds(new Set(result.memberIds));
      })
      .catch(() => {
        if (active) setMemberIds(new Set());
      });
    return () => {
      active = false;
    };
  }, [channel.id, channel.isPrivate, groupId]);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/groups/${groupId}/channels/${channel.id}`, {
        name: name.trim(),
        topic: topic.trim() || null,
        categoryId: categoryId || null,
        slowmode: Number(slowmode) || 0,
        isPrivate,
      });
      toast.success('Channel settings updated.');
      onDone();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not update the channel.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleMember(userId: string, granted: boolean) {
    try {
      if (granted) {
        await api.post(`/api/groups/${groupId}/channels/${channel.id}/members`, {
          userId,
        });
      } else {
        await api.del(
          `/api/groups/${groupId}/channels/${channel.id}/members/${userId}`,
        );
      }
      setMemberIds((current) => {
        const next = new Set(current);
        if (granted) next.add(userId);
        else next.delete(userId);
        return next;
      });
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : 'Could not update private channel access.',
      );
    }
  }

  async function syncPermissions() {
    try {
      await api.post(
        `/api/groups/${groupId}/channels/${channel.id}/permissions/sync`,
      );
      toast.success('Channel permissions synced with its category.');
      onDone();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not sync permissions.',
      );
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Delete #${channel.name}? Its messages and files will be permanently removed.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.del(`/api/groups/${groupId}/channels/${channel.id}`);
      toast.success('Channel deleted.');
      onDone();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not delete the channel.',
      );
      setBusy(false);
    }
  }

  const supportsTopic = ['text', 'forum', 'announcement'].includes(channel.type);
  const supportsSlowmode = ['text', 'forum', 'announcement'].includes(channel.type);

  return (
    <Modal
      title={`Edit channel — ${channel.name}`}
      description={`${channel.type[0].toUpperCase()}${channel.type.slice(1)} channel · configure its overview, access, and permission overwrites.`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn danger" disabled={busy} onClick={() => void remove()}>
            Delete Channel
          </button>
          <button className="btn" onClick={onPermissions}>
            Permission Overrides
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save Changes'}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field">
          <label htmlFor="edit-channel-name">Channel name</label>
          <input
            id="edit-channel-name"
            className="input"
            value={name}
            maxLength={48}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="edit-channel-category">Category</label>
          <select
            id="edit-channel-category"
            className="select"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {supportsTopic ? (
        <div className="field">
          <label htmlFor="edit-channel-topic">Topic / description</label>
          <textarea
            id="edit-channel-topic"
            className="textarea"
            value={topic}
            maxLength={200}
            onChange={(event) => setTopic(event.target.value)}
          />
        </div>
      ) : null}
      {supportsSlowmode ? (
        <div className="field">
          <label htmlFor="edit-channel-slowmode">Slowmode</label>
          <select
            id="edit-channel-slowmode"
            className="select"
            value={slowmode}
            onChange={(event) => setSlowmode(event.target.value)}
          >
            <option value="0">Off</option>
            <option value="5">5 seconds</option>
            <option value="10">10 seconds</option>
            <option value="30">30 seconds</option>
            <option value="60">1 minute</option>
            <option value="300">5 minutes</option>
            <option value="900">15 minutes</option>
            <option value="3600">1 hour</option>
          </select>
        </div>
      ) : null}
      <label className="discord-setting-row">
        <span>
          <strong>Private channel</strong>
          <small>
            Only explicitly added members and users with management access can see it.
          </small>
        </span>
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(event) => setIsPrivate(event.target.checked)}
        />
      </label>
      <div className="discord-setting-row">
        <span>
          <strong>Category permissions</strong>
          <small>
            {channel.categoryId
              ? channel.permissionsSynced
                ? 'Synced — category changes automatically apply here.'
                : 'Not synced — this channel has its own overwrites.'
              : 'Move this channel into a category to inherit its overwrites.'}
          </small>
        </span>
        {channel.categoryId && !channel.permissionsSynced ? (
          <button className="btn small" onClick={() => void syncPermissions()}>
            Sync now
          </button>
        ) : null}
      </div>
      {channel.isPrivate ? (
        <>
          <div className="section-label" style={{ padding: '18px 0 6px' }}>
            Private channel members
          </div>
          <div className="picker-list" style={{ maxHeight: 260 }}>
            {members.map((member) => (
              <label className="picker-row" key={member.id}>
                <Avatar
                  name={member.displayName}
                  id={member.id}
                  color={member.bannerColor}
                  size={30}
                />
                <span className="info">
                  <span className="name">{member.displayName}</span>
                  <span className="sub">@{member.username}</span>
                </span>
                <input
                  type="checkbox"
                  checked={memberIds.has(member.id)}
                  onChange={(event) =>
                    void toggleMember(member.id, event.target.checked)
                  }
                />
              </label>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function InviteModal({
  groupId,
  invites,
  onClose,
  onDone,
}: {
  groupId: string;
  invites: Invite[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const [expiresIn, setExpiresIn] = useState('168');

  async function create() {
    setBusy(true);
    try {
      await api.post(`/api/groups/${groupId}/invites`, {
        maxUses: maxUses ? Number(maxUses) : null,
        expiresInHours: expiresIn ? Number(expiresIn) : null,
      });
      onDone();
      toast.success('Invite created.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the invite.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Invite people"
      description="Share a code with someone who already has an account on this server."
      onClose={onClose}
    >
      <div className="grid-2">
        <div className="field">
          <label htmlFor="max-uses">Maximum uses</label>
          <input
            id="max-uses"
            className="input"
            type="number"
            min={1}
            max={1000}
            value={maxUses}
            onChange={(event) => setMaxUses(event.target.value)}
            placeholder="Unlimited"
          />
        </div>
        <div className="field">
          <label htmlFor="expires">Expires after (hours)</label>
          <input
            id="expires"
            className="input"
            type="number"
            min={1}
            value={expiresIn}
            onChange={(event) => setExpiresIn(event.target.value)}
            placeholder="Never"
          />
        </div>
      </div>
      <button className="btn primary block" onClick={create} disabled={busy}>
        {busy ? 'Creating…' : 'Create a new invite'}
      </button>

      {invites.length > 0 ? (
        <>
          <div className="section-label" style={{ padding: '18px 0 6px' }}>
            Active invites
          </div>
          <div className="col" style={{ paddingBottom: 16 }}>
            {invites.map((invite) => (
              <div className="copy-row" key={invite.id}>
                <code>{invite.code}</code>
                <button
                  className="btn small"
                  onClick={() => {
                    const url = new URL(window.location.origin);
                    url.searchParams.set('invite', invite.code);
                    void navigator.clipboard.writeText(url.toString());
                    toast.success('Invite link copied.');
                  }}
                >
                  Copy link
                </button>
                <button
                  className="btn small danger"
                  onClick={async () => {
                    await api.del(`/api/groups/${groupId}/invites/${invite.id}`);
                    onDone();
                  }}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function ServerInvitesSection({
  groupId,
  invites,
  canCreate,
  onDone,
}: {
  groupId: string;
  invites: Invite[];
  canCreate: boolean;
  onDone: () => void;
}) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const [busy, setBusy] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const [expiresIn, setExpiresIn] = useState('168');

  async function create() {
    setBusy(true);
    try {
      await api.post(`/api/groups/${groupId}/invites`, {
        maxUses: maxUses ? Number(maxUses) : null,
        expiresInHours: expiresIn ? Number(expiresIn) : null,
      });
      toast.success(fa ? 'دعوت جدید ساخته شد.' : 'A new invite is ready.');
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'ساخت دعوت انجام نشد.' : 'Could not create the invite.'));
    } finally {
      setBusy(false);
    }
  }

  function copyInvite(code: string) {
    const url = new URL(window.location.origin);
    url.searchParams.set('invite', code);
    void navigator.clipboard.writeText(url.toString());
    toast.success(fa ? 'پیوند دعوت کپی شد.' : 'Invite link copied.');
  }

  return (
    <div className="server-invites-page">
      <div className="settings-feature-card invite-feature-card">
        <div className="settings-feature-icon"><Icon name="link" size={24} /></div>
        <div>
          <span className="eyebrow">{fa ? 'دسترسی گروه' : 'SERVER ACCESS'}</span>
          <h3>{fa ? 'افراد مناسب را دعوت کنید' : 'Bring the right people in'}</h3>
          <p>{fa ? 'دعوت‌های محدود یا زمان‌دار بسازید و تمام پیوندهای فعال را از یک‌جا مدیریت کنید.' : 'Create expiring or limited-use invites and manage every active link in one place.'}</p>
        </div>
        <span className="settings-feature-count"><strong>{invites.length}</strong>{fa ? 'فعال' : 'active'}</span>
      </div>

      {canCreate ? (
        <section className="settings-panel invite-builder">
          <div className="settings-panel-heading">
            <div><h3>{fa ? 'ساخت دعوت' : 'Create an invite'}</h3><p>{fa ? 'برای دعوت دائمی هر دو محدودیت را خالی بگذارید.' : 'Leave both limits empty for a permanent invite.'}</p></div>
          </div>
          <div className="grid-2">
            <label className="field">
              <span>{fa ? 'حداکثر استفاده' : 'Maximum uses'}</span>
              <input className="input" type="number" min={1} max={1000} value={maxUses} onChange={(event) => setMaxUses(event.target.value)} placeholder={fa ? 'نامحدود' : 'Unlimited'} />
            </label>
            <label className="field">
              <span>{fa ? 'انقضا پس از' : 'Expire after'}</span>
              <select className="select" value={expiresIn} onChange={(event) => setExpiresIn(event.target.value)}>
                <option value="1">1 hour</option>
                <option value="6">6 hours</option>
                <option value="24">1 day</option>
                <option value="168">7 days</option>
                <option value="720">30 days</option>
                <option value="">Never</option>
              </select>
            </label>
          </div>
          <button className="btn primary" disabled={busy} onClick={() => void create()}><Icon name="add" size={16} />{busy ? (fa ? 'در حال ساخت…' : 'Creating…') : (fa ? 'ساخت پیوند دعوت' : 'Create invite link')}</button>
        </section>
      ) : (
        <EmptyState icon={<Icon name="lock" size={32} />} title={fa ? 'دعوت‌ها محدود هستند' : 'Invites are restricted'}>
          {fa ? 'برای مدیریت این بخش به مجوز ساخت دعوت نیاز دارید.' : 'You need the Create Invite permission to manage this area.'}
        </EmptyState>
      )}

      {canCreate ? (
        <section className="settings-panel active-invites">
          <div className="settings-panel-heading"><div><h3>{fa ? 'دعوت‌های فعال' : 'Active invites'}</h3><p>{fa ? 'استفاده، سازنده و زمان انقضای هر پیوند را بررسی کنید.' : 'Review usage, creator, and expiration for every link.'}</p></div></div>
          {invites.length ? (
            <div className="invite-table">
              {invites.map((invite) => {
                const expired = Boolean(invite.expiresAt && invite.expiresAt <= Date.now());
                return (
                  <div className={`invite-row${expired ? ' expired' : ''}`} key={invite.id}>
                    <div className="invite-code"><Icon name="link" size={16} /><code>{invite.code}</code></div>
                    <div className="invite-meta">
                      <span>{invite.uses} / {invite.maxUses ?? '∞'} {fa ? 'استفاده' : 'uses'}</span>
                      <span>{invite.expiresAt ? (expired ? (fa ? 'منقضی' : 'Expired') : new Date(invite.expiresAt).toLocaleString()) : (fa ? 'بدون انقضا' : 'Never expires')}</span>
                      <span>{invite.creatorDisplayName ?? (fa ? 'عضو سابق' : 'Former member')}</span>
                    </div>
                    <div className="invite-actions">
                      <button className="btn small" onClick={() => copyInvite(invite.code)}>{fa ? 'کپی' : 'Copy'}</button>
                      <button className="btn small danger" onClick={async () => {
                        try {
                          await api.del(`/api/groups/${groupId}/invites/${invite.id}`);
                          toast.success(fa ? 'دعوت لغو شد.' : 'Invite revoked.');
                          onDone();
                        } catch (error) {
                          toast.error(error instanceof ApiError ? error.message : (fa ? 'لغو دعوت انجام نشد.' : 'Could not revoke the invite.'));
                        }
                      }}>{fa ? 'لغو' : 'Revoke'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <EmptyState icon={<Icon name="link" size={30} />} title={fa ? 'دعوت فعالی نیست' : 'No active invites'}>{fa ? 'اولین پیوند دعوت این گروه را بسازید.' : 'Create the first invite link for this server.'}</EmptyState>}
        </section>
      ) : null}
    </div>
  );
}

function NewCategoryModal({
  groupId,
  onClose,
  onDone,
}: {
  groupId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await api.post(`/api/groups/${groupId}/categories`, { name: name.trim() });
      toast.success('Category created.');
      onDone();
      onClose();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not create the category.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create Category"
      description="Channels placed here can synchronize the category’s permission overwrites."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create Category'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="new-category-name">Category name</label>
        <input
          id="new-category-name"
          className="input"
          value={name}
          maxLength={48}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </div>
    </Modal>
  );
}

function InlineCategoryCreator({
  groupId,
  onDone,
}: {
  groupId: string;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  return (
    <div className="row">
      <input
        className="input"
        placeholder="New category"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={48}
      />
      <button
        className="btn small"
        disabled={!name.trim()}
        onClick={async () => {
          try {
            await api.post(`/api/groups/${groupId}/categories`, { name: name.trim() });
            setName('');
            toast.success('Category created.');
            onDone();
          } catch (error) {
            toast.error(error instanceof ApiError ? error.message : 'Could not create the category.');
          }
        }}
      >
        Add category
      </button>
    </div>
  );
}

type PermissionCategory = 'General' | 'Membership' | 'Text' | 'Voice' | 'Events' | 'Apps';

const SERVER_PERMISSION_OPTIONS: {
  key: ServerPermission;
  label: string;
  description: string;
  category: PermissionCategory;
  dangerous?: boolean;
}[] = [
  { key: 'administrator', label: 'Administrator', description: 'Grants every permission and bypasses all channel restrictions.', category: 'General', dangerous: true },
  { key: 'manageGroup', label: 'Manage Server', description: 'Edit server identity, discovery, AutoMod, and server-wide settings.', category: 'General', dangerous: true },
  { key: 'viewAuditLog', label: 'View Audit Log', description: 'Review moderation and administrative actions.', category: 'General' },
  { key: 'manageChannels', label: 'Manage Channels', description: 'Create, edit, delete, and configure channels and categories.', category: 'General', dangerous: true },
  { key: 'manageRoles', label: 'Manage Roles', description: 'Create, edit, reorder, and assign roles below this role.', category: 'General', dangerous: true },
  { key: 'manageExpressions', label: 'Manage Expressions', description: 'Create and remove emoji, stickers, and soundboard items.', category: 'General' },
  { key: 'createExpressions', label: 'Create Expressions', description: 'Upload new emoji, stickers, and soundboard items and remove their own.', category: 'General' },
  { key: 'manageWebhooks', label: 'Manage Webhooks', description: 'Create, edit, and delete server webhooks.', category: 'General', dangerous: true },
  { key: 'viewServerInsights', label: 'View Server Insights', description: 'View server growth, activity, and engagement analytics.', category: 'General' },
  { key: 'viewCreatorMonetizationAnalytics', label: 'View Monetization Analytics', description: 'View subscription and creator revenue analytics.', category: 'General' },
  { key: 'createInvite', label: 'Create Invite', description: 'Create and revoke invitation links.', category: 'Membership' },
  { key: 'changeNickname', label: 'Change Nickname', description: 'Change their own server nickname.', category: 'Membership' },
  { key: 'manageNicknames', label: 'Manage Nicknames', description: 'Change nicknames of members below this role.', category: 'Membership' },
  { key: 'manageMembers', label: 'Manage Members', description: 'Add existing platform accounts to this server.', category: 'Membership', dangerous: true },
  { key: 'kickMember', label: 'Kick Members', description: 'Remove members below this role from the server.', category: 'Membership', dangerous: true },
  { key: 'banMembers', label: 'Ban Members', description: 'Ban members below this role and manage the ban list.', category: 'Membership', dangerous: true },
  { key: 'moderateMembers', label: 'Timeout Members', description: 'Temporarily prevent members below this role from interacting.', category: 'Membership', dangerous: true },
  { key: 'viewChannel', label: 'View Channels', description: 'See a channel and its name in the channel list.', category: 'Text' },
  { key: 'sendMessages', label: 'Send Messages', description: 'Post messages in text channels.', category: 'Text' },
  { key: 'sendTtsMessages', label: 'Send Text-to-Speech Messages', description: 'Send /tts messages that can be read aloud.', category: 'Text' },
  { key: 'sendMessagesInThreads', label: 'Send Messages in Threads', description: 'Reply in forum posts and channel threads.', category: 'Text' },
  { key: 'createPublicThreads', label: 'Create Public Threads', description: 'Create threads that everyone with channel access can see.', category: 'Text' },
  { key: 'createPrivateThreads', label: 'Create Private Threads', description: 'Create invitation-only threads.', category: 'Text' },
  { key: 'embedLinks', label: 'Embed Links', description: 'Display rich previews for links posted in messages.', category: 'Text' },
  { key: 'attachFiles', label: 'Attach Files', description: 'Upload images and files with messages.', category: 'Text' },
  { key: 'addReactions', label: 'Add Reactions', description: 'Add new emoji reactions to messages.', category: 'Text' },
  { key: 'useExternalEmojis', label: 'Use External Emoji', description: 'Use emoji from other servers.', category: 'Text' },
  { key: 'useExternalStickers', label: 'Use External Stickers', description: 'Use stickers from other servers.', category: 'Text' },
  { key: 'mentionEveryone', label: 'Mention @everyone and Roles', description: 'Notify @everyone, @here, and all members of a role.', category: 'Text', dangerous: true },
  { key: 'deleteAnyMessage', label: 'Manage Messages', description: 'Delete messages posted by other members.', category: 'Text', dangerous: true },
  { key: 'pinMessage', label: 'Pin Messages', description: 'Pin and unpin messages in a channel.', category: 'Text' },
  { key: 'readMessageHistory', label: 'Read Message History', description: 'Read messages sent before opening the channel.', category: 'Text' },
  { key: 'manageThreads', label: 'Manage Threads and Posts', description: 'Rename, archive, lock, and delete other members’ threads.', category: 'Text', dangerous: true },
  { key: 'bypassSlowmode', label: 'Bypass Slowmode', description: 'Send without waiting for a channel slowmode timer.', category: 'Text' },
  { key: 'sendVoiceMessages', label: 'Send Voice Messages', description: 'Record and send voice messages.', category: 'Text' },
  { key: 'sendPolls', label: 'Create Polls', description: 'Create polls in text channels and threads.', category: 'Text' },
  { key: 'connectVoice', label: 'Connect', description: 'Join voice and stage channels.', category: 'Voice' },
  { key: 'speak', label: 'Speak', description: 'Transmit microphone audio in voice channels.', category: 'Voice' },
  { key: 'video', label: 'Video', description: 'Share camera video and screen content.', category: 'Voice' },
  { key: 'useVoiceActivity', label: 'Use Voice Activity', description: 'Speak without push-to-talk.', category: 'Voice' },
  { key: 'prioritySpeaker', label: 'Priority Speaker', description: 'Lower other speakers while using push-to-talk.', category: 'Voice' },
  { key: 'muteMembers', label: 'Mute Members', description: 'Mute other members for everyone in a voice channel.', category: 'Voice', dangerous: true },
  { key: 'deafenMembers', label: 'Deafen Members', description: 'Prevent other members from hearing voice audio.', category: 'Voice', dangerous: true },
  { key: 'moveMembers', label: 'Move Members', description: 'Move or disconnect members from voice channels.', category: 'Voice', dangerous: true },
  { key: 'requestToSpeak', label: 'Request to Speak', description: 'Request microphone access in stage channels.', category: 'Voice' },
  { key: 'useSoundboard', label: 'Use Soundboard', description: 'Play sounds from this server’s soundboard.', category: 'Voice' },
  { key: 'useExternalSounds', label: 'Use External Sounds', description: 'Play soundboard sounds originating in another server.', category: 'Voice' },
  { key: 'setVoiceChannelStatus', label: 'Set Voice Channel Status', description: 'Set or clear the status shown on a voice channel.', category: 'Voice' },
  { key: 'useEmbeddedActivities', label: 'Use Activities', description: 'Start or join embedded activities in voice channels.', category: 'Apps' },
  { key: 'useApplicationCommands', label: 'Use Application Commands', description: 'Use commands supplied by apps and bots.', category: 'Apps' },
  { key: 'useExternalApps', label: 'Use External Apps', description: 'Allow external app responses to be visible to other members.', category: 'Apps' },
  { key: 'createEvents', label: 'Create Events', description: 'Schedule server events.', category: 'Events' },
  { key: 'manageEvents', label: 'Manage Events', description: 'Edit and cancel events created by other members.', category: 'Events', dangerous: true },
];

const PERMISSION_FA: Record<ServerPermission, { label: string; description: string }> = {
  administrator: { label: 'مدیر کل', description: 'همه مجوزها را می‌دهد و تمام محدودیت‌های کانال را نادیده می‌گیرد.' },
  manageGroup: { label: 'مدیریت گروه', description: 'هویت، فهرست عمومی، مدیریت خودکار و تنظیمات کلی گروه را ویرایش می‌کند.' },
  viewAuditLog: { label: 'مشاهده گزارش فعالیت', description: 'عملیات مدیریتی و نظارتی را بررسی می‌کند.' },
  manageChannels: { label: 'مدیریت کانال‌ها', description: 'کانال‌ها و دسته‌ها را می‌سازد، ویرایش، حذف و پیکربندی می‌کند.' },
  manageRoles: { label: 'مدیریت نقش‌ها', description: 'نقش‌های پایین‌تر را می‌سازد، ویرایش، مرتب و واگذار می‌کند.' },
  manageExpressions: { label: 'مدیریت شکلک‌ها', description: 'شکلک، استیکر و صدای گروه را می‌سازد یا حذف می‌کند.' },
  createExpressions: { label: 'ساخت شکلک‌ها', description: 'شکلک، استیکر و صدا بارگذاری می‌کند و موارد ساخته‌شده خود را حذف می‌کند.' },
  manageWebhooks: { label: 'مدیریت وب‌هوک‌ها', description: 'وب‌هوک‌های گروه را می‌سازد، ویرایش و حذف می‌کند.' },
  viewServerInsights: { label: 'مشاهده آمار گروه', description: 'رشد، فعالیت و مشارکت اعضای گروه را مشاهده می‌کند.' },
  viewCreatorMonetizationAnalytics: { label: 'مشاهده آمار درآمد', description: 'آمار اشتراک‌ها و درآمد سازنده را مشاهده می‌کند.' },
  createInvite: { label: 'ساخت دعوت‌نامه', description: 'پیوندهای دعوت را می‌سازد و لغو می‌کند.' },
  changeNickname: { label: 'تغییر نام مستعار', description: 'نام مستعار خود در گروه را تغییر می‌دهد.' },
  manageNicknames: { label: 'مدیریت نام‌های مستعار', description: 'نام مستعار اعضای پایین‌تر را تغییر می‌دهد.' },
  manageMembers: { label: 'مدیریت اعضا', description: 'حساب‌های موجود سامانه را به این گروه اضافه می‌کند.' },
  kickMember: { label: 'اخراج اعضا', description: 'اعضای پایین‌تر را از گروه خارج می‌کند.' },
  banMembers: { label: 'مسدودکردن اعضا', description: 'اعضای پایین‌تر را مسدود و فهرست مسدودی را مدیریت می‌کند.' },
  moderateMembers: { label: 'محدودکردن اعضا', description: 'تعامل اعضای پایین‌تر را برای مدت مشخص متوقف می‌کند.' },
  viewChannel: { label: 'مشاهده کانال‌ها', description: 'کانال و نام آن را در فهرست کانال‌ها مشاهده می‌کند.' },
  sendMessages: { label: 'ارسال پیام', description: 'در کانال‌های متنی پیام ارسال می‌کند.' },
  sendTtsMessages: { label: 'ارسال پیام صوتی متنی', description: 'پیام‌های /tts قابل خواندن با صدا ارسال می‌کند.' },
  sendMessagesInThreads: { label: 'ارسال پیام در رشته‌ها', description: 'در پست‌های انجمن و رشته‌های کانال پاسخ می‌دهد.' },
  createPublicThreads: { label: 'ساخت رشته عمومی', description: 'رشته‌ای می‌سازد که همه افراد دارای دسترسی کانال می‌بینند.' },
  createPrivateThreads: { label: 'ساخت رشته خصوصی', description: 'رشته‌های فقط با دعوت می‌سازد.' },
  embedLinks: { label: 'نمایش پیش‌نمایش پیوند', description: 'برای پیوندهای پیام پیش‌نمایش غنی نمایش می‌دهد.' },
  attachFiles: { label: 'پیوست فایل', description: 'تصویر و فایل را همراه پیام بارگذاری می‌کند.' },
  addReactions: { label: 'افزودن واکنش', description: 'واکنش شکلکی تازه به پیام‌ها اضافه می‌کند.' },
  useExternalEmojis: { label: 'استفاده از شکلک بیرونی', description: 'از شکلک گروه‌های دیگر استفاده می‌کند.' },
  useExternalStickers: { label: 'استفاده از استیکر بیرونی', description: 'از استیکر گروه‌های دیگر استفاده می‌کند.' },
  mentionEveryone: { label: 'اشاره به همه و نقش‌ها', description: 'به همه، افراد حاضر و اعضای یک نقش اعلان می‌فرستد.' },
  deleteAnyMessage: { label: 'مدیریت پیام‌ها', description: 'پیام‌های ارسال‌شده توسط اعضای دیگر را حذف می‌کند.' },
  pinMessage: { label: 'سنجاق‌کردن پیام‌ها', description: 'پیام‌ها را در کانال سنجاق یا از سنجاق خارج می‌کند.' },
  readMessageHistory: { label: 'خواندن تاریخچه پیام‌ها', description: 'پیام‌های پیش از بازکردن کانال را می‌خواند.' },
  manageThreads: { label: 'مدیریت رشته‌ها و پست‌ها', description: 'رشته‌های دیگران را تغییرنام، بایگانی، قفل و حذف می‌کند.' },
  bypassSlowmode: { label: 'عبور از حالت آهسته', description: 'بدون انتظار برای زمان‌سنج حالت آهسته پیام می‌فرستد.' },
  sendVoiceMessages: { label: 'ارسال پیام صوتی', description: 'پیام صوتی ضبط و ارسال می‌کند.' },
  sendPolls: { label: 'ساخت نظرسنجی', description: 'در کانال‌ها و رشته‌های متنی نظرسنجی می‌سازد.' },
  connectVoice: { label: 'اتصال', description: 'به کانال‌های صوتی و صحنه می‌پیوندد.' },
  speak: { label: 'صحبت‌کردن', description: 'صدای میکروفون را در کانال صوتی پخش می‌کند.' },
  video: { label: 'ویدیو', description: 'دوربین و صفحه‌نمایش خود را به اشتراک می‌گذارد.' },
  useVoiceActivity: { label: 'استفاده از فعالیت صوتی', description: 'بدون فشردن دکمه برای صحبت، صدا ارسال می‌کند.' },
  prioritySpeaker: { label: 'گوینده اولویت‌دار', description: 'هنگام صحبت صدای دیگر گویندگان را کاهش می‌دهد.' },
  muteMembers: { label: 'بی‌صداکردن اعضا', description: 'اعضای دیگر را برای همه در کانال صوتی بی‌صدا می‌کند.' },
  deafenMembers: { label: 'ناشنواکردن اعضا', description: 'از شنیدن صدای کانال توسط اعضای دیگر جلوگیری می‌کند.' },
  moveMembers: { label: 'جابجایی اعضا', description: 'اعضا را میان کانال‌های صوتی جابجا یا قطع می‌کند.' },
  requestToSpeak: { label: 'درخواست صحبت', description: 'در کانال صحنه درخواست دسترسی میکروفون می‌دهد.' },
  useSoundboard: { label: 'استفاده از صفحه صدا', description: 'صداهای صفحه صدای این گروه را پخش می‌کند.' },
  useExternalSounds: { label: 'استفاده از صدای بیرونی', description: 'صداهای متعلق به گروه دیگر را پخش می‌کند.' },
  setVoiceChannelStatus: { label: 'تنظیم وضعیت کانال صوتی', description: 'وضعیت نمایش‌داده‌شده روی کانال صوتی را تنظیم یا پاک می‌کند.' },
  useEmbeddedActivities: { label: 'استفاده از فعالیت‌ها', description: 'فعالیت‌های تعاملی کانال صوتی را آغاز می‌کند یا به آن‌ها می‌پیوندد.' },
  useApplicationCommands: { label: 'استفاده از فرمان برنامه‌ها', description: 'از فرمان‌های ارائه‌شده توسط برنامه‌ها و ربات‌ها استفاده می‌کند.' },
  useExternalApps: { label: 'استفاده از برنامه‌های بیرونی', description: 'پاسخ برنامه بیرونی را برای اعضای دیگر قابل مشاهده می‌کند.' },
  createEvents: { label: 'ساخت رویداد', description: 'برای گروه رویداد زمان‌بندی‌شده می‌سازد.' },
  manageEvents: { label: 'مدیریت رویدادها', description: 'رویدادهای ساخته‌شده توسط دیگران را ویرایش یا لغو می‌کند.' },
};

const PERMISSION_CATEGORY_FA: Record<PermissionCategory, string> = {
  General: 'عمومی',
  Membership: 'عضویت',
  Text: 'متنی',
  Voice: 'صوتی',
  Events: 'رویدادها',
  Apps: 'برنامه‌ها',
};

function permissionCopy(permission: (typeof SERVER_PERMISSION_OPTIONS)[number], fa: boolean) {
  return fa ? PERMISSION_FA[permission.key] : permission;
}

const PERMISSION_API_META: Record<
  ServerPermission,
  { flag: string; scope: string; official: boolean }
> = {
  createInvite: { flag: 'CREATE_INSTANT_INVITE', scope: 'Text · Voice · Stage', official: true },
  kickMember: { flag: 'KICK_MEMBERS', scope: 'Server', official: true },
  banMembers: { flag: 'BAN_MEMBERS', scope: 'Server', official: true },
  administrator: { flag: 'ADMINISTRATOR', scope: 'Server', official: true },
  manageChannels: { flag: 'MANAGE_CHANNELS', scope: 'Text · Voice · Stage', official: true },
  manageGroup: { flag: 'MANAGE_GUILD', scope: 'Server', official: true },
  addReactions: { flag: 'ADD_REACTIONS', scope: 'Text · Voice · Stage', official: true },
  viewAuditLog: { flag: 'VIEW_AUDIT_LOG', scope: 'Server', official: true },
  prioritySpeaker: { flag: 'PRIORITY_SPEAKER', scope: 'Voice', official: true },
  video: { flag: 'STREAM', scope: 'Voice · Stage', official: true },
  viewChannel: { flag: 'VIEW_CHANNEL', scope: 'Text · Voice · Stage', official: true },
  sendMessages: { flag: 'SEND_MESSAGES', scope: 'Text · Voice · Stage', official: true },
  sendTtsMessages: { flag: 'SEND_TTS_MESSAGES', scope: 'Text · Voice · Stage', official: true },
  deleteAnyMessage: { flag: 'MANAGE_MESSAGES', scope: 'Text · Voice · Stage', official: true },
  embedLinks: { flag: 'EMBED_LINKS', scope: 'Text · Voice · Stage', official: true },
  attachFiles: { flag: 'ATTACH_FILES', scope: 'Text · Voice · Stage', official: true },
  readMessageHistory: { flag: 'READ_MESSAGE_HISTORY', scope: 'Text · Voice · Stage', official: true },
  mentionEveryone: { flag: 'MENTION_EVERYONE', scope: 'Text · Voice · Stage', official: true },
  useExternalEmojis: { flag: 'USE_EXTERNAL_EMOJIS', scope: 'Text · Voice · Stage', official: true },
  viewServerInsights: { flag: 'VIEW_GUILD_INSIGHTS', scope: 'Server', official: true },
  connectVoice: { flag: 'CONNECT', scope: 'Voice · Stage', official: true },
  speak: { flag: 'SPEAK', scope: 'Voice', official: true },
  muteMembers: { flag: 'MUTE_MEMBERS', scope: 'Voice · Stage', official: true },
  deafenMembers: { flag: 'DEAFEN_MEMBERS', scope: 'Voice', official: true },
  moveMembers: { flag: 'MOVE_MEMBERS', scope: 'Voice · Stage', official: true },
  useVoiceActivity: { flag: 'USE_VAD', scope: 'Voice', official: true },
  changeNickname: { flag: 'CHANGE_NICKNAME', scope: 'Server', official: true },
  manageNicknames: { flag: 'MANAGE_NICKNAMES', scope: 'Server', official: true },
  manageRoles: { flag: 'MANAGE_ROLES', scope: 'Text · Voice · Stage', official: true },
  manageWebhooks: { flag: 'MANAGE_WEBHOOKS', scope: 'Text · Voice · Stage', official: true },
  manageExpressions: { flag: 'MANAGE_GUILD_EXPRESSIONS', scope: 'Server', official: true },
  useApplicationCommands: { flag: 'USE_APPLICATION_COMMANDS', scope: 'Text · Voice · Stage', official: true },
  requestToSpeak: { flag: 'REQUEST_TO_SPEAK', scope: 'Stage', official: true },
  manageEvents: { flag: 'MANAGE_EVENTS', scope: 'Voice · Stage', official: true },
  manageThreads: { flag: 'MANAGE_THREADS', scope: 'Text', official: true },
  createPublicThreads: { flag: 'CREATE_PUBLIC_THREADS', scope: 'Text', official: true },
  createPrivateThreads: { flag: 'CREATE_PRIVATE_THREADS', scope: 'Text', official: true },
  useExternalStickers: { flag: 'USE_EXTERNAL_STICKERS', scope: 'Text · Voice · Stage', official: true },
  sendMessagesInThreads: { flag: 'SEND_MESSAGES_IN_THREADS', scope: 'Text', official: true },
  useEmbeddedActivities: { flag: 'USE_EMBEDDED_ACTIVITIES', scope: 'Text · Voice', official: true },
  moderateMembers: { flag: 'MODERATE_MEMBERS', scope: 'Server', official: true },
  viewCreatorMonetizationAnalytics: { flag: 'VIEW_CREATOR_MONETIZATION_ANALYTICS', scope: 'Server', official: true },
  useSoundboard: { flag: 'USE_SOUNDBOARD', scope: 'Voice', official: true },
  createExpressions: { flag: 'CREATE_GUILD_EXPRESSIONS', scope: 'Server', official: true },
  createEvents: { flag: 'CREATE_EVENTS', scope: 'Voice · Stage', official: true },
  useExternalSounds: { flag: 'USE_EXTERNAL_SOUNDS', scope: 'Voice', official: true },
  sendVoiceMessages: { flag: 'SEND_VOICE_MESSAGES', scope: 'Text · Voice · Stage', official: true },
  setVoiceChannelStatus: { flag: 'SET_VOICE_CHANNEL_STATUS', scope: 'Voice', official: true },
  sendPolls: { flag: 'SEND_POLLS', scope: 'Text · Voice · Stage', official: true },
  useExternalApps: { flag: 'USE_EXTERNAL_APPS', scope: 'Text · Voice · Stage', official: true },
  pinMessage: { flag: 'PIN_MESSAGES', scope: 'Text', official: true },
  bypassSlowmode: { flag: 'BYPASS_SLOWMODE', scope: 'Text · Voice · Stage', official: true },
  manageMembers: { flag: 'MANAGE_MEMBERS', scope: 'sahsha extension', official: false },
};

const PERMISSION_CATEGORIES: PermissionCategory[] = ['General', 'Membership', 'Text', 'Voice', 'Events', 'Apps'];
const CHANNEL_SCOPED_GENERAL_PERMISSIONS = new Set<ServerPermission>([
  'manageChannels',
  'manageRoles',
  'manageWebhooks',
  'createInvite',
  'createEvents',
  'manageEvents',
]);
const CHANNEL_PERMISSION_OPTIONS = SERVER_PERMISSION_OPTIONS.filter(
  (permission) =>
    CHANNEL_SCOPED_GENERAL_PERMISSIONS.has(permission.key) ||
    permission.category === 'Text' ||
    permission.category === 'Voice' ||
    permission.category === 'Apps',
);
const CHANNEL_PERMISSION_CATEGORIES: PermissionCategory[] = [
  'General',
  'Membership',
  'Text',
  'Voice',
  'Events',
  'Apps',
];

function ServerRolesSection({
  groupId,
  roles,
  members,
  canManage,
  highestRolePosition,
  onDone,
}: {
  groupId: string;
  roles: ServerRole[];
  members: GroupMember[];
  canManage: boolean;
  highestRolePosition: number;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState<ServerRole | 'new' | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  async function dropRole(event: DragEvent<HTMLButtonElement>, targetId: string) {
    event.preventDefault();
    if (!dragging || dragging === targetId) return;
    if (roles.find((role) => role.id === targetId)?.isDefault) return;
    const ordered = roles.map((role) => role.id);
    const from = ordered.indexOf(dragging);
    const to = ordered.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
    setDragging(null);
    try {
      await api.put(`/api/groups/${groupId}/roles/reorder`, { roleIds: ordered });
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not reorder roles.');
    }
  }

  return (
    <>
      <div className="section-label server-settings-heading">
        <span>Roles — {roles.filter((role) => !role.isDefault).length}</span>
        {canManage ? (
          <button className="btn small primary" onClick={() => setEditing('new')}>
            Create Role
          </button>
        ) : null}
      </div>
      <p className="muted small">
        Drag roles to set the hierarchy. Members inherit @everyone, and permissions from all assigned roles combine.
      </p>
      <div className="permission-coverage-card">
        <span className="permission-coverage-icon"><Icon name="shield" size={23} /></span>
        <span>
          <strong>Complete Discord permission model</strong>
          <small>52 official Discord flags, hierarchy rules, implicit denies, and channel overwrites are available one by one.</small>
        </span>
        <span className="permission-coverage-score"><strong>52 / 52</strong><small>official flags</small></span>
        <span className="permission-coverage-score extension"><strong>+1</strong><small>platform ability</small></span>
      </div>
      <div className="server-role-list">
        {roles.length ? (
          roles.map((role) => {
            const memberCount = role.isDefault
              ? members.length
              : members.filter((member) =>
                  member.serverRoles.some((assigned) => assigned.id === role.id),
                ).length;
            const editable =
              canManage && (role.isDefault || role.position < highestRolePosition);
            return (
            <button
              type="button"
              className="server-role-card"
              key={role.id}
              draggable={editable && !role.isDefault}
              onDragStart={() => !role.isDefault && setDragging(role.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void dropRole(event, role.id)}
              onClick={() => editable && !role.managed && setEditing(role)}
              disabled={!editable}
            >
              <span className="muted" title={role.isDefault ? 'Base role' : 'Drag to reorder'}>
                {role.isDefault ? '◎' : '⠿'}
              </span>
              {role.iconUrl ? (
                <img className="custom-emoji" src={role.iconUrl} alt="" />
              ) : role.unicodeEmoji ? (
                <span className="large">{role.unicodeEmoji}</span>
              ) : (
                <span
                  className="role-dot large"
                  style={{
                    background: role.secondaryColor
                      ? `linear-gradient(120deg, ${role.color ?? '#99aab5'}, ${role.secondaryColor}${role.tertiaryColor ? `, ${role.tertiaryColor}` : ''})`
                      : role.color ?? '#99aab5',
                  }}
                />
              )}
              <span className="server-role-card-main">
                <strong>{role.name}</strong>
                <small>
                  {role.isDefault ? 'Base permissions for every server member · ' : ''}
                  {role.permissions.length
                    ? role.permissions
                        .map((permission) => SERVER_PERMISSION_OPTIONS.find((item) => item.key === permission)?.label)
                        .filter(Boolean)
                        .join(' · ')
                    : 'No permissions'}
                </small>
              </span>
              <span className="role-card-meta">
                <span title={`${memberCount} member${memberCount === 1 ? '' : 's'}`}>
                  {memberCount} members
                </span>
                {role.hoist ? <span title="Displayed separately">Hoisted</span> : null}
                {role.mentionable ? <span title="Can be mentioned">@</span> : null}
                {role.inPrompt ? <span title="Shown in onboarding">Onboarding</span> : null}
                {role.managed ? <span title="Managed by an integration">Managed</span> : null}
                {!role.isDefault ? <span className="muted small">#{role.position}</span> : null}
              </span>
            </button>
            );
          })
        ) : (
          <div className="empty-role-state">
            No custom roles yet. Members currently use the default @everyone access.
          </div>
        )}
      </div>
      {editing ? (
        <ServerRoleEditor
          groupId={groupId}
          role={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            onDone();
          }}
        />
      ) : null}
    </>
  );
}

function RolesManagementModal({
  groupId,
  roles,
  members,
  highestRolePosition,
  onClose,
  onDone,
}: {
  groupId: string;
  roles: ServerRole[];
  members: GroupMember[];
  highestRolePosition: number;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal
      title="Server Roles"
      description="Create roles, set the hierarchy, and configure all server-wide Discord permissions."
      onClose={onClose}
      wide
    >
      <ServerRolesSection
        groupId={groupId}
        roles={roles}
        members={members}
        canManage
        highestRolePosition={highestRolePosition}
        onDone={onDone}
      />
    </Modal>
  );
}

function ServerRoleEditor({
  groupId,
  role,
  onClose,
  onDone,
}: {
  groupId: string;
  role: ServerRole | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const [name, setName] = useState(role?.name ?? '');
  const [color, setColor] = useState(role?.color ?? '#99aab5');
  const [secondaryColor, setSecondaryColor] = useState(role?.secondaryColor ?? '');
  const [tertiaryColor, setTertiaryColor] = useState(role?.tertiaryColor ?? '');
  const [unicodeEmoji, setUnicodeEmoji] = useState(role?.unicodeEmoji ?? '');
  const [iconAttachmentId, setIconAttachmentId] = useState(role?.iconAttachmentId ?? '');
  const [iconUrl, setIconUrl] = useState(role?.iconUrl ?? '');
  const [inPrompt, setInPrompt] = useState(role?.inPrompt ?? false);
  const roleIconInput = useRef<HTMLInputElement>(null);
  const [hoist, setHoist] = useState(role?.hoist ?? false);
  const [mentionable, setMentionable] = useState(role?.mentionable ?? false);
  const [selected, setSelected] = useState<ServerPermission[]>(role?.permissions ?? []);
  const [permissionSearch, setPermissionSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const isDefault = Boolean(role?.isDefault);

  const visiblePermissions = useMemo(() => {
    const query = permissionSearch.trim().toLowerCase();
    if (!query) return SERVER_PERMISSION_OPTIONS;
    return SERVER_PERMISSION_OPTIONS.filter(
      (permission) =>
        permission.label.toLowerCase().includes(query) ||
        permission.description.toLowerCase().includes(query) ||
        PERMISSION_FA[permission.key].label.includes(query) ||
        PERMISSION_FA[permission.key].description.includes(query) ||
        permission.category.toLowerCase().includes(query) ||
        PERMISSION_API_META[permission.key].flag.toLowerCase().includes(query) ||
        PERMISSION_API_META[permission.key].scope.toLowerCase().includes(query),
    );
  }, [permissionSearch]);

  function toggle(permission: ServerPermission) {
    setSelected((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  }

  async function save() {
    setBusy(true);
    try {
      const body = {
        ...(!isDefault
          ? {
              name: name.trim(),
              color,
              secondaryColor: secondaryColor || null,
              tertiaryColor: tertiaryColor || null,
              unicodeEmoji: unicodeEmoji.trim() || null,
              iconAttachmentId: iconAttachmentId || null,
              hoist,
              mentionable,
              inPrompt,
            }
          : {}),
        permissions: selected,
      };
      if (role) await api.patch(`/api/groups/${groupId}/roles/${role.id}`, body);
      else await api.post(`/api/groups/${groupId}/roles`, body);
      toast.success(role ? 'Role updated.' : 'Role created.');
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not save the role.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!role || role.isDefault || !window.confirm(`Delete the role “${role.name}”? Members will lose it immediately.`)) return;
    setBusy(true);
    try {
      await api.del(`/api/groups/${groupId}/roles/${role.id}`);
      toast.success('Role deleted.');
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not delete the role.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isDefault ? 'Default permissions — @everyone' : role ? `Edit role — ${role.name}` : 'Create a server role'}
      description={
        isDefault
          ? 'Every server member receives these base permissions. Channel overrides can allow or deny them.'
          : 'Permissions combine across roles. Administrator bypasses every channel restriction.'
      }
      onClose={onClose}
      wide
      footer={
        <>
          {role && !isDefault ? <button className="btn danger" onClick={remove} disabled={busy}>Delete Role</button> : null}
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || (!isDefault && !name.trim())}>
            {busy ? 'Saving…' : role ? 'Save Changes' : 'Create Role'}
          </button>
        </>
      }
    >
      {!isDefault ? <>
      <div className="role-editor-basics">
        <div className="field role-name-preview-field">
          <label htmlFor="server-role-name">Role name</label>
          <input
            id="server-role-name"
            className="input"
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="server-role-color">Role color</label>
          <div className="role-color-control">
            <input
              id="server-role-color"
              className="role-color-input"
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
            />
            <code>{color.toUpperCase()}</code>
          </div>
        </div>
        <div className="field">
          <label htmlFor="server-role-secondary">Gradient color</label>
          <div className="role-color-control">
            <input
              id="server-role-secondary"
              className="role-color-input"
              type="color"
              value={secondaryColor || color}
              onChange={(event) => setSecondaryColor(event.target.value)}
            />
            <button className="btn small" onClick={() => setSecondaryColor('')} type="button">
              {secondaryColor ? 'Clear' : 'Off'}
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="server-role-tertiary">Holographic accent</label>
          <div className="role-color-control">
            <input
              id="server-role-tertiary"
              className="role-color-input"
              type="color"
              value={tertiaryColor || secondaryColor || color}
              onChange={(event) => setTertiaryColor(event.target.value)}
            />
            <button className="btn small" onClick={() => setTertiaryColor('')} type="button">
              {tertiaryColor ? 'Clear' : 'Off'}
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="server-role-icon">Role icon</label>
          <input
            id="server-role-icon"
            className="input"
            value={unicodeEmoji}
            maxLength={16}
            onChange={(event) => setUnicodeEmoji(event.target.value)}
            placeholder="Emoji, e.g. 🛡️"
          />
        </div>
        <div className="field">
          <label>Role image icon</label>
          <input
            ref={roleIconInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              try {
                const form = new FormData();
                form.append('file', file);
                const uploaded = await api.post<{ attachment: { id: string; url: string } }>(
                  '/api/files',
                  form,
                );
                setIconAttachmentId(uploaded.attachment.id);
                setIconUrl(uploaded.attachment.url);
                setUnicodeEmoji('');
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'Could not upload role icon.');
              }
            }}
          />
          <div className="row">
            <button className="btn small" type="button" onClick={() => roleIconInput.current?.click()}>
              Upload icon
            </button>
            {iconAttachmentId ? (
              <button className="btn danger small" type="button" onClick={() => {
                setIconAttachmentId('');
                setIconUrl('');
              }}>
                Remove
              </button>
            ) : null}
          </div>
        </div>
        <div
          className="role-preview"
          style={{
            borderColor: color,
            background: secondaryColor
              ? `linear-gradient(120deg, ${color}, ${secondaryColor}${tertiaryColor ? `, ${tertiaryColor}` : ''})`
              : undefined,
          }}
        >
          {iconUrl ? (
            <img className="custom-emoji" src={iconUrl} alt="" />
          ) : unicodeEmoji ? (
            <span className="large">{unicodeEmoji}</span>
          ) : (
            <span className="role-dot large" style={{ background: color }} />
          )}
          <strong>{name || 'New role'}</strong>
        </div>
      </div>
      <div className="role-display-options">
        <label className="discord-setting-row">
          <span>
            <strong>Display role members separately</strong>
            <small>Show members with this role in a separate member-list group.</small>
          </span>
          <input type="checkbox" checked={hoist} onChange={(event) => setHoist(event.target.checked)} />
        </label>
        <label className="discord-setting-row">
          <span>
            <strong>Show in onboarding role picker</strong>
            <small>Members can add or remove this role for themselves.</small>
          </span>
          <input type="checkbox" checked={inPrompt} onChange={(event) => setInPrompt(event.target.checked)} />
        </label>
        <label className="discord-setting-row">
          <span>
            <strong>Allow anyone to @mention this role</strong>
            <small>Members can notify everyone assigned to this role.</small>
          </span>
          <input type="checkbox" checked={mentionable} onChange={(event) => setMentionable(event.target.checked)} />
        </label>
      </div>
      </> : null}

      <div className="permission-toolbar">
        <div>
          <div className="section-label">Permissions</div>
          <small>{selected.length} of {SERVER_PERMISSION_OPTIONS.length} enabled</small>
        </div>
        <input
          className="input permission-search"
          value={permissionSearch}
          onChange={(event) => setPermissionSearch(event.target.value)}
          placeholder="Search permissions"
        />
        <button
          className="btn small"
          type="button"
          onClick={() =>
            setSelected((current) => [
              ...new Set([...current, ...visiblePermissions.map((permission) => permission.key)]),
            ])
          }
        >
          Enable shown
        </button>
        <button
          className="btn small ghost"
          type="button"
          onClick={() =>
            setSelected((current) =>
              current.filter(
                (key) => !visiblePermissions.some((permission) => permission.key === key),
              ),
            )
          }
        >
          Clear shown
        </button>
      </div>
      {selected.includes('administrator') ? (
        <div className="permission-danger-banner">
          <strong>Administrator is enabled</strong>
          <span>This role bypasses every permission and channel override. Assign it with extreme care.</span>
        </div>
      ) : null}
      <div className="permission-groups">
        {PERMISSION_CATEGORIES.map((category) => {
          const options = visiblePermissions.filter((permission) => permission.category === category);
          if (!options.length) return null;
          return <section className="permission-group" key={category}>
            <h4>{fa ? PERMISSION_CATEGORY_FA[category] : category}</h4>
            <div className="permission-picker">
              {options.map((permission) => (
          <label
            className={`${selected.includes(permission.key) ? 'selected' : ''}${permission.dangerous ? ' dangerous-permission' : ''}`}
            key={permission.key}
          >
            <input
              type="checkbox"
              checked={selected.includes(permission.key)}
              onChange={() => toggle(permission.key)}
            />
            <span>{permissionCopy(permission, fa).label}</span>
            <small>{permissionCopy(permission, fa).description}</small>
            <span className="permission-api-meta">
              <code>{PERMISSION_API_META[permission.key].flag}</code>
              <i>{PERMISSION_API_META[permission.key].scope}</i>
              {!PERMISSION_API_META[permission.key].official ? <b>Platform extension</b> : null}
            </span>
          </label>
              ))}
            </div>
          </section>;
        })}
      </div>
      <div style={{ height: 16 }} />
    </Modal>
  );
}

function ChannelPermissionsModal({
  groupId,
  channel,
  categoryMode = false,
  roles,
  members,
  onClose,
  onDone,
}: {
  groupId: string;
  channel: Channel | ChannelCategory;
  categoryMode?: boolean;
  roles: ServerRole[];
  members: GroupMember[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  const [overrides, setOverrides] = useState<ChannelPermissionOverride[]>([]);
  const [target, setTarget] = useState(`everyone:${groupId}`);
  const [values, setValues] = useState<Record<ServerPermission, 'inherit' | 'allow' | 'deny'>>(
    () => Object.fromEntries(CHANNEL_PERMISSION_OPTIONS.map(({ key }) => [key, 'inherit'])) as Record<
      ServerPermission,
      'inherit' | 'allow' | 'deny'
    >,
  );
  const [busy, setBusy] = useState(false);
  const resourcePath = categoryMode ? 'categories' : 'channels';

  useEffect(() => {
    void api
      .get<{ overrides: ChannelPermissionOverride[] }>(
        `/api/groups/${groupId}/${resourcePath}/${channel.id}/overrides`,
      )
      .then((data) => setOverrides(data.overrides))
      .catch((error) =>
        toast.error(error instanceof ApiError ? error.message : 'Could not load channel permissions.'),
      );
  }, [channel.id, groupId, resourcePath]);

  useEffect(() => {
    const [targetType, targetId] = target.split(':') as [
      ChannelPermissionOverride['targetType'],
      string,
    ];
    const existing = overrides.find(
      (item) => item.targetType === targetType && item.targetId === targetId,
    );
    setValues(
      Object.fromEntries(
        CHANNEL_PERMISSION_OPTIONS.map(({ key }) => [
          key,
          existing?.allow.includes(key) ? 'allow' : existing?.deny.includes(key) ? 'deny' : 'inherit',
        ]),
      ) as Record<ServerPermission, 'inherit' | 'allow' | 'deny'>,
    );
  }, [overrides, target]);

  const [targetType, targetId] = target.split(':') as [
    ChannelPermissionOverride['targetType'],
    string,
  ];
  const existing = overrides.find(
    (item) => item.targetType === targetType && item.targetId === targetId,
  );

  async function save() {
    setBusy(true);
    try {
      const data = await api.put<{ overrides: ChannelPermissionOverride[] }>(
        `/api/groups/${groupId}/${resourcePath}/${channel.id}/overrides`,
        {
          targetType,
          targetId,
          allow: CHANNEL_PERMISSION_OPTIONS.filter(({ key }) => values[key] === 'allow').map(({ key }) => key),
          deny: CHANNEL_PERMISSION_OPTIONS.filter(({ key }) => values[key] === 'deny').map(({ key }) => key),
        },
      );
      setOverrides(data.overrides);
      toast.success('Channel permissions updated.');
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not save channel permissions.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    try {
      await api.del(
        `/api/groups/${groupId}/${resourcePath}/${channel.id}/overrides/${targetType}/${targetId}`,
      );
      setOverrides((current) => current.filter((item) => item !== existing));
      toast.success('Channel override removed.');
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove the override.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`${categoryMode ? 'Category' : 'Channel'} permissions — ${channel.name}`}
      description={`${categoryMode ? 'Synced channels inherit these category permissions.' : 'Set channel-specific access.'} @everyone applies first, combined role overrides second, and member overrides last.`}
      onClose={onClose}
      wide
      footer={
        <>
          {existing ? <button className="btn danger" onClick={remove} disabled={busy}>Remove Override</button> : null}
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save Permissions'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="permission-target">Role or member</label>
        <select
          id="permission-target"
          className="select"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value={`everyone:${groupId}`}>@everyone</option>
          <optgroup label="Roles">
            {roles.filter((role) => !role.isDefault).map((role) => <option value={`role:${role.id}`} key={role.id}>{role.name}</option>)}
          </optgroup>
          <optgroup label="Members">
            {members.map((member) => (
              <option value={`member:${member.id}`} key={member.id}>
                {member.nickname ?? member.displayName}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="channel-override-legend">
        <span><i className="neutral">/</i> Inherit</span>
        <span><i className="allow">✓</i> Allow</span>
        <span><i className="deny">×</i> Deny</span>
      </div>
      <div className="channel-permission-list">
        {CHANNEL_PERMISSION_CATEGORIES.map((category) => (
          <section className="channel-permission-group" key={category}>
            <h4>{fa ? `مجوزهای کانال ${PERMISSION_CATEGORY_FA[category]}` : `${category} channel permissions`}</h4>
            {CHANNEL_PERMISSION_OPTIONS.filter((permission) => permission.category === category).map((permission) => (
              <div className="channel-permission-row" key={permission.key}>
                <span>
                  <strong>{permissionCopy(permission, fa).label}</strong>
                  <small>{permissionCopy(permission, fa).description}</small>
                  <span className="permission-api-meta compact">
                    <code>{PERMISSION_API_META[permission.key].flag}</code>
                    <i>{PERMISSION_API_META[permission.key].scope}</i>
                  </span>
                </span>
                <div className="permission-tristate" role="group" aria-label={permissionCopy(permission, fa).label}>
                  {(['inherit', 'allow', 'deny'] as const).map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={`${value}${values[permission.key] === value ? ' active' : ''}`}
                      title={value === 'inherit' ? 'Inherit' : value === 'allow' ? 'Allow' : 'Deny'}
                      aria-pressed={values[permission.key] === value}
                      onClick={() => setValues((current) => ({ ...current, [permission.key]: value }))}
                    >
                      {value === 'inherit' ? '/' : value === 'allow' ? '✓' : '×'}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}

function AnnouncementFollowsSection({ groupId, channels }: { groupId: string; channels: Channel[] }) {
  const [follows, setFollows] = useState<
    { sourceChannelId: string; sourceName: string; targetChannelId: string; targetName: string }[]
  >([]);

  async function refresh() {
    try {
      const data = await api.get<{ follows: typeof follows }>(`/api/groups/${groupId}/channel-follows`);
      setFollows(data.follows);
    } catch {
      setFollows([]);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="section-label" style={{ padding: '22px 0 6px' }}>Announcement follows</div>
      {follows.map((follow) => (
        <div className="row between" key={`${follow.sourceChannelId}:${follow.targetChannelId}`}>
          <span>📢 {follow.sourceName} → #{follow.targetName}</span>
          <button className="btn danger small" onClick={async () => {
            await api.del(`/api/groups/${groupId}/channel-follows/${follow.sourceChannelId}/${follow.targetChannelId}`);
            await refresh();
          }}>Unfollow</button>
        </div>
      ))}
      <button className="btn small" onClick={async () => {
        const sourceChannelId = window.prompt('Announcement channel ID to follow:');
        const targets = channels.filter((channel) => channel.type === 'text');
        const targetName = sourceChannelId ? window.prompt(`Target text channel: ${targets.map((channel) => channel.name).join(', ')}`) : null;
        const target = targets.find((channel) => channel.name === targetName);
        if (!sourceChannelId || !target) return;
        try {
          await api.post(`/api/groups/${groupId}/channel-follows`, {
            sourceChannelId,
            targetChannelId: target.id,
          });
          await refresh();
        } catch (error) {
          toast.error(error instanceof ApiError ? error.message : 'Could not follow that channel.');
        }
      }}>Follow announcement channel</button>
    </div>
  );
}

interface ServerModerationData {
  bans: { userId: string; displayName: string; username: string; reason: string | null }[];
  timeouts: { userId: string; displayName: string; username: string; reason: string | null; expiresAt: number }[];
  rules: { id: string; name: string; triggerType: string; triggerValue: string; action: string }[];
  actions: { id: string; displayName: string; ruleName: string | null; action: string; createdAt: number }[];
  audit: { id: string; action: string; actorDisplayName: string | null; createdAt: number }[];
}

function ServerModerationSection({
  groupId,
  members,
  canManageRules,
}: {
  groupId: string;
  members: GroupMember[];
  canManageRules: boolean;
}) {
  const [data, setData] = useState<ServerModerationData | null>(null);

  async function refresh() {
    try {
      setData(await api.get<ServerModerationData>(`/api/groups/${groupId}/moderation`));
    } catch {
      setData(null);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  const pickMember = () => {
    const username = window.prompt('Member username:')?.trim().toLowerCase();
    return members.find((member) => member.username.toLowerCase() === username);
  };

  return (
    <div className="col" style={{ gap: 9 }}>
      <div className="section-label" style={{ padding: '22px 0 6px' }}>Moderation & AutoMod</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn small"
          onClick={async () => {
            const member = pickMember();
            if (!member) return;
            const minutes = Number(window.prompt('Timeout minutes (0 removes timeout):', '10'));
            try {
              await api.put(`/api/groups/${groupId}/members/${member.id}/timeout`, {
                durationSeconds: Math.max(0, Math.round(minutes * 60)),
                reason: window.prompt('Reason:', '') || null,
              });
              await refresh();
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not update timeout.');
            }
          }}
        >
          Timeout member
        </button>
        <button
          className="btn danger small"
          onClick={async () => {
            const member = pickMember();
            if (!member || !window.confirm(`Ban @${member.username} from this server?`)) return;
            try {
              await api.put(`/api/groups/${groupId}/bans/${member.id}`, {
                reason: window.prompt('Ban reason:', '') || null,
              });
              await refresh();
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not ban that member.');
            }
          }}
        >
          Ban member
        </button>
      </div>
      {data?.timeouts.map((item) => (
        <div className="row between" key={`timeout-${item.userId}`}>
          <span>⏱ {item.displayName} · until {new Date(item.expiresAt).toLocaleString()}</span>
          <button className="btn small" onClick={async () => {
            await api.put(`/api/groups/${groupId}/members/${item.userId}/timeout`, { durationSeconds: 0 });
            await refresh();
          }}>Remove</button>
        </div>
      ))}
      {data?.bans.map((item) => (
        <div className="row between" key={`ban-${item.userId}`}>
          <span>⛔ {item.displayName} {item.reason ? `· ${item.reason}` : ''}</span>
          <button className="btn small" onClick={async () => {
            await api.del(`/api/groups/${groupId}/bans/${item.userId}`);
            await refresh();
          }}>Unban</button>
        </div>
      ))}
      {canManageRules ? (
        <button
          className="btn small"
          onClick={async () => {
            const triggerValue = window.prompt('Blocked keyword or phrase:');
            if (!triggerValue) return;
            try {
              await api.post(`/api/groups/${groupId}/automod-rules`, {
                name: `Block ${triggerValue.slice(0, 32)}`,
                triggerType: 'keyword',
                triggerValue,
                action: window.confirm('Timeout matching members too?') ? 'timeout' : 'block',
                timeoutSeconds: 600,
              });
              await refresh();
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not create AutoMod rule.');
            }
          }}
        >
          Create AutoMod rule
        </button>
      ) : null}
      {data?.rules.map((rule) => (
        <div className="row between" key={rule.id}>
          <span>🛡 {rule.name} · {rule.action}</span>
          {canManageRules ? <button className="btn small danger" onClick={async () => {
            await api.del(`/api/groups/${groupId}/automod-rules/${rule.id}`);
            await refresh();
          }}>Delete</button> : null}
        </div>
      ))}
      {data?.actions.length ? (
        <details>
          <summary>AutoMod actions & server audit</summary>
          <div className="compact-list">
            {data.actions.slice(0, 20).map((item) => (
              <div key={item.id}><span>{item.displayName} · {item.ruleName ?? 'Deleted rule'}</span><small>{item.action}</small></div>
            ))}
            {data.audit.slice(0, 20).map((item) => (
              <div key={item.id}><span>{item.action}</span><small>{new Date(item.createdAt).toLocaleString()}</small></div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

interface ServerCommunity {
  events: {
    id: string;
    name: string;
    description: string | null;
    startsAt: number;
    location: string | null;
    goingCount: number;
    interestedCount: number;
    viewerStatus: 'going' | 'interested' | null;
  }[];
  boosts: {
    count: number;
    level: number;
    viewerBoosting: boolean;
    supporters: { userId: string; displayName: string; expiresAt: number }[];
  };
  tiers: {
    id: string;
    name: string;
    description: string | null;
    priceMonthly: number;
    benefits: string[];
  }[];
  subscriptions: {
    id: string;
    tierId: string;
    tierName: string;
    currentPeriodEnd: number;
  }[];
  monetization: {
    activeSubscriptions: number;
    monthlyRevenue: number;
  } | null;
}

function ServerCommunitySection({
  groupId,
  channels,
  canManage,
}: {
  groupId: string;
  channels: Channel[];
  canManage: boolean;
}) {
  const [community, setCommunity] = useState<ServerCommunity | null>(null);

  async function refresh() {
    try {
      setCommunity(await api.get<ServerCommunity>(`/api/groups/${groupId}/community`));
    } catch {
      setCommunity(null);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  async function createEvent() {
    const name = window.prompt('Event name:', 'Community meetup');
    const date = name ? window.prompt('Start date and time (YYYY-MM-DD HH:mm):') : null;
    if (!name || !date) return;
    const startsAt = new Date(date.replace(' ', 'T')).getTime();
    if (!Number.isFinite(startsAt)) {
      toast.error('Enter a valid event date.');
      return;
    }
    try {
      await api.post(`/api/groups/${groupId}/events`, {
        name,
        description: window.prompt('Event description:', '') || null,
        channelId: channels.find((channel) => channel.type === 'voice' || channel.type === 'stage')?.id ?? null,
        location: null,
        startsAt,
      });
      await refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the event.');
    }
  }

  async function createTier() {
    const name = window.prompt('Subscription tier name:', 'Supporter');
    if (!name) return;
    const price = Number(window.prompt('Monthly price in the smallest currency unit (0 for free):', '0'));
    try {
      await api.post(`/api/groups/${groupId}/subscription-tiers`, {
        name,
        description: window.prompt('Tier description:', 'Support this community') || null,
        priceMonthly: Number.isFinite(price) ? Math.max(0, Math.round(price)) : 0,
        benefits: ['Supporter badge', 'Community recognition'],
      });
      await refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the tier.');
    }
  }

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="section-label" style={{ padding: '22px 0 6px' }}>
        Events, boosts & subscriptions
      </div>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span>
          <strong>Server boost level {community?.boosts.level ?? 0}</strong>
          <small className="muted"> · {community?.boosts.count ?? 0} active boosts</small>
        </span>
        <button
          className={`btn small${community?.boosts.viewerBoosting ? ' danger' : ' primary'}`}
          onClick={async () => {
            try {
              if (community?.boosts.viewerBoosting) await api.del(`/api/groups/${groupId}/boosts/mine`);
              else await api.post(`/api/groups/${groupId}/boosts`);
              await refresh();
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not change the boost.');
            }
          }}
        >
          {community?.boosts.viewerBoosting ? 'Remove my boost' : 'Boost this server'}
        </button>
      </div>
      {community?.monetization ? (
        <div className="community-card">
          <div>
            <strong>Creator monetization</strong>
            <small>
              {community.monetization.activeSubscriptions} active subscriptions ·{' '}
              {community.monetization.monthlyRevenue.toLocaleString()} monthly revenue
            </small>
          </div>
        </div>
      ) : null}
      {community?.events.map((event) => (
        <div className="community-card" key={event.id}>
          <div>
            <strong>📅 {event.name}</strong>
            <small>{new Date(event.startsAt).toLocaleString()} · {event.goingCount} going · {event.interestedCount} interested</small>
          </div>
          <div className="row">
            {(['interested', 'going'] as const).map((status) => (
              <button
                className={`btn small${event.viewerStatus === status ? ' primary' : ''}`}
                key={status}
                onClick={async () => {
                  await api.put(`/api/groups/${groupId}/events/${event.id}/rsvp`, {
                    status: event.viewerStatus === status ? null : status,
                  });
                  await refresh();
                }}
              >
                {status === 'going' ? 'Going' : 'Interested'}
              </button>
            ))}
          </div>
        </div>
      ))}
      {canManage ? <button className="btn small" onClick={() => void createEvent()}>Create event</button> : null}
      {community?.tiers.map((tier) => {
        const current = community.subscriptions.find((subscription) => subscription.tierId === tier.id);
        return (
          <div className="community-card" key={tier.id}>
            <div>
              <strong>★ {tier.name}</strong>
              <small>{tier.description ?? 'Community subscription'} · {tier.priceMonthly.toLocaleString()} / month</small>
            </div>
            <button
              className={`btn small${current ? ' danger' : ' primary'}`}
              onClick={async () => {
                try {
                  if (current) await api.del(`/api/groups/${groupId}/subscriptions/${current.id}`);
                  else await api.post(`/api/groups/${groupId}/subscriptions`, { tierId: tier.id });
                  await refresh();
                } catch (error) {
                  toast.error(error instanceof ApiError ? error.message : 'Could not change the subscription.');
                }
              }}
            >
              {current ? 'Cancel' : 'Subscribe'}
            </button>
          </div>
        );
      })}
      {canManage ? <button className="btn small" onClick={() => void createTier()}>Create subscription tier</button> : null}
    </div>
  );
}

function ServerInsightsSection({ groupId }: { groupId: string }) {
  const [insights, setInsights] = useState<{
    memberCount: number;
    channelCount: number;
    messagesLast7Days: number;
    activeMembersLast7Days: number;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .get<{ insights: NonNullable<typeof insights> }>(`/api/groups/${groupId}/insights`)
      .then((data) => {
        if (active) setInsights(data.insights);
      })
      .catch(() => {
        if (active) setInsights(null);
      });
    return () => {
      active = false;
    };
  }, [groupId]);

  if (!insights) return null;
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="section-label" style={{ padding: '22px 0 6px' }}>Server insights</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="badge">{insights.memberCount} members</span>
        <span className="badge">{insights.channelCount} channels</span>
        <span className="badge">{insights.messagesLast7Days} messages / 7d</span>
        <span className="badge">{insights.activeMembersLast7Days} active members / 7d</span>
      </div>
    </div>
  );
}

function OnboardingRolesSection({
  groupId,
  roles,
  member,
  onDone,
}: {
  groupId: string;
  roles: ServerRole[];
  member: GroupMember | undefined;
  onDone: () => void;
}) {
  const choices = roles.filter((role) => role.inPrompt && !role.isDefault);
  const [assigned, setAssigned] = useState(
    () => new Set(member?.serverRoles.map((role) => role.id) ?? []),
  );
  useEffect(() => {
    setAssigned(new Set(member?.serverRoles.map((role) => role.id) ?? []));
  }, [member]);
  if (!choices.length) return null;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="section-label" style={{ padding: '22px 0 6px' }}>
        Customize your server
      </div>
      <span className="muted small">Choose the onboarding roles that describe you.</span>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {choices.map((role) => {
          const active = assigned.has(role.id);
          return (
            <button
              className={`btn small${active ? ' primary' : ''}`}
              key={role.id}
              style={{ borderColor: role.color ?? undefined }}
              onClick={async () => {
                try {
                  await api.put(`/api/groups/${groupId}/onboarding/roles/${role.id}`, {
                    assigned: !active,
                  });
                  setAssigned((current) => {
                    const next = new Set(current);
                    if (active) next.delete(role.id);
                    else next.add(role.id);
                    return next;
                  });
                  onDone();
                } catch (error) {
                  toast.error(error instanceof ApiError ? error.message : 'Could not update onboarding role.');
                }
              }}
            >
              {role.iconUrl ? (
                <img className="custom-emoji" src={role.iconUrl} alt="" />
              ) : (
                role.unicodeEmoji ?? '🏷️'
              )}{' '}
              {role.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ServerExpressionsSection({
  groupId,
  canManage,
  canCreate,
}: {
  groupId: string;
  canManage: boolean;
  canCreate: boolean;
}) {
  const userId = useSession((state) => state.user?.id);
  const [expressions, setExpressions] = useState<GroupExpression[]>([]);
  const [name, setName] = useState('');
  const [type, setType] = useState<GroupExpression['type']>('emoji');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const data = await api.get<{ expressions: GroupExpression[] }>(
        `/api/groups/${groupId}/expressions`,
      );
      setExpressions(data.expressions);
    } catch {
      setExpressions([]);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  async function create() {
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const uploaded = await api.post<{ attachment: { id: string } }>('/api/files', form);
      await api.post(`/api/groups/${groupId}/expressions`, {
        name: name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        type,
        attachmentId: uploaded.attachment.id,
      });
      setName('');
      setFile(null);
      await refresh();
      toast.success(`${type} added to this server.`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not add the server asset.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="section-label" style={{ padding: '22px 0 6px' }}>
        Emojis, stickers & soundboard
      </div>
      {expressions.length ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {expressions.map((expression) => (
            <div className="server-expression-chip" key={expression.id}>
              {expression.type === 'sound' ? (
                <span>🔊</span>
              ) : (
                <img src={expression.url} alt={expression.name} />
              )}
              <span>:{expression.name}:</span>
              <small>{expression.type}</small>
              {canManage || (canCreate && expression.createdBy === userId) ? (
                <button
                  title="Delete"
                  onClick={async () => {
                    try {
                      await api.del(`/api/groups/${groupId}/expressions/${expression.id}`);
                      await refresh();
                    } catch (error) {
                      toast.error(error instanceof ApiError ? error.message : 'Could not delete the asset.');
                    }
                  }}
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <span className="muted small">This server has no custom assets yet.</span>
      )}
      {canCreate ? (
        <div className="row" style={{ gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
          <label className="field" style={{ margin: 0 }}>
            <span>Name</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="party_parrot"
              maxLength={32}
            />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Type</span>
            <select className="select" value={type} onChange={(event) => setType(event.target.value as GroupExpression['type'])}>
              <option value="emoji">Emoji</option>
              <option value="sticker">Sticker</option>
              <option value="sound">Soundboard</option>
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Server-owned file</span>
            <input
              className="input"
              type="file"
              accept={type === 'sound' ? 'audio/*' : 'image/png,image/jpeg,image/gif,image/webp'}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button className="btn primary" onClick={() => void create()} disabled={busy || !file || name.trim().length < 2}>
            {busy ? 'Uploading…' : 'Add asset'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MemberManagementModal({
  groupId,
  member,
  roles,
  permissions,
  onClose,
  onDone,
}: {
  groupId: string;
  member: GroupMember;
  roles: ServerRole[];
  permissions: GroupPermissions;
  onClose: () => void;
  onDone: () => void;
}) {
  const assignableRoles = roles.filter((role) => !role.isDefault);
  const originalRoleIds = new Set(member.serverRoles.map((role) => role.id));
  const [nickname, setNickname] = useState(member.nickname ?? '');
  const [roleIds, setRoleIds] = useState(() => new Set(originalRoleIds));
  const [timeoutSeconds, setTimeoutSeconds] = useState(600);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const updates: Promise<unknown>[] = [];
      if (permissions.manageNicknames && nickname.trim() !== (member.nickname ?? '')) {
        updates.push(
          api.patch(`/api/groups/${groupId}/members/${member.id}`, {
            nickname: nickname.trim() || null,
          }),
        );
      }
      if (permissions.manageRoles) {
        for (const role of assignableRoles) {
          const hadRole = originalRoleIds.has(role.id);
          const hasRole = roleIds.has(role.id);
          if (hadRole !== hasRole) {
            updates.push(
              api.put(`/api/groups/${groupId}/members/${member.id}/roles/${role.id}`, {
                granted: hasRole,
              }),
            );
          }
        }
      }
      await Promise.all(updates);
      toast.success('Member updated.');
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update the member.');
    } finally {
      setBusy(false);
    }
  }

  async function timeout(durationSeconds: number) {
    setBusy(true);
    try {
      await api.put(`/api/groups/${groupId}/members/${member.id}/timeout`, {
        durationSeconds,
        reason: reason.trim() || null,
      });
      toast.success(durationSeconds ? 'Member timed out.' : 'Timeout removed.');
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update the timeout.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(kind: 'kick' | 'ban') {
    const confirmed = window.confirm(
      kind === 'ban'
        ? `Ban @${member.username}? They will not be able to rejoin until unbanned.`
        : `Kick @${member.username} from this server?`,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      if (kind === 'ban') {
        await api.put(`/api/groups/${groupId}/bans/${member.id}`, {
          reason: reason.trim() || null,
        });
      } else {
        await api.del(`/api/groups/${groupId}/members/${member.id}`);
      }
      toast.success(kind === 'ban' ? 'Member banned.' : 'Member kicked.');
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : `Could not ${kind} the member.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Manage ${member.nickname ?? member.displayName}`}
      description={`@${member.username} · joined ${new Date(member.joinedAt).toLocaleDateString()}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save Changes'}
          </button>
        </>
      }
    >
      <div className="member-management-identity">
        <Avatar
          name={member.displayName}
          id={member.id}
          src={member.avatarUrl}
          color={member.bannerColor}
          size={52}
        />
        <div>
          <strong>{member.displayName}</strong>
          <span>@{member.username}</span>
        </div>
        <span className={`presence-dot ${member.presence}`} title={member.presence} />
      </div>

      {permissions.manageNicknames ? (
        <div className="field">
          <label htmlFor="member-server-nickname">Server nickname</label>
          <input
            id="member-server-nickname"
            className="input"
            value={nickname}
            maxLength={32}
            placeholder={member.displayName}
            onChange={(event) => setNickname(event.target.value)}
          />
        </div>
      ) : null}

      <div className="section-label" style={{ padding: '14px 0 6px' }}>Roles</div>
      <div className="member-role-grid">
        <div className="member-role-option locked">
          <span className="role-dot" style={{ background: '#99aab5' }} />
          <span><strong>@everyone</strong><small>Assigned to every member</small></span>
          <input type="checkbox" checked readOnly />
        </div>
        {assignableRoles.map((role) => {
          const canAssign =
            permissions.manageRoles && role.position < permissions.highestRolePosition;
          return (
          <label className={`member-role-option${roleIds.has(role.id) ? ' selected' : ''}${!canAssign ? ' locked' : ''}`} key={role.id}>
            <span className="role-dot" style={{ background: role.color ?? '#99aab5' }} />
            <span>
              <strong>{role.name}</strong>
              <small>Position {role.position} · {role.permissions.length} permissions</small>
            </span>
            <input
              type="checkbox"
              checked={roleIds.has(role.id)}
              disabled={!canAssign}
              onChange={(event) =>
                setRoleIds((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(role.id);
                  else next.delete(role.id);
                  return next;
                })
              }
            />
          </label>
          );
        })}
      </div>

      {permissions.moderateMembers || permissions.kickMember || permissions.banMembers ? (
        <div className="member-danger-zone">
          <div>
            <strong>Moderation</strong>
            <small>Actions are hierarchy checked and recorded in the audit log.</small>
          </div>
          <input
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (optional)"
            maxLength={300}
          />
          {permissions.moderateMembers ? (
            <div className="row wrap">
              <select
                className="select"
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(Number(event.target.value))}
              >
                <option value={60}>1 minute</option>
                <option value={600}>10 minutes</option>
                <option value={3600}>1 hour</option>
                <option value={86400}>1 day</option>
                <option value={604800}>1 week</option>
              </select>
              <button className="btn" disabled={busy} onClick={() => void timeout(timeoutSeconds)}>Timeout</button>
              <button className="btn ghost" disabled={busy} onClick={() => void timeout(0)}>Remove Timeout</button>
            </div>
          ) : null}
          <div className="row wrap">
            {permissions.kickMember ? (
              <button className="btn danger" disabled={busy} onClick={() => void remove('kick')}>Kick Member</button>
            ) : null}
            {permissions.banMembers ? (
              <button className="btn danger" disabled={busy} onClick={() => void remove('ban')}>Ban Member</button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

type CommandPermissionTarget = 'role' | 'member' | 'channel';

interface AppCommand {
  id: string;
  name: string;
  description: string | null;
  botName: string;
}

interface AppCommandPermission {
  targetType: 'everyone' | CommandPermissionTarget;
  targetId: string;
  enabled: boolean;
}

function AppCommandPermissionsSection({
  groupId,
  channels,
  members,
  roles,
}: {
  groupId: string;
  channels: Channel[];
  members: GroupMember[];
  roles: ServerRole[];
}) {
  const [commands, setCommands] = useState<AppCommand[]>([]);
  const [commandId, setCommandId] = useState('');
  const [overrides, setOverrides] = useState<AppCommandPermission[]>([]);
  const [everyoneEnabled, setEveryoneEnabled] = useState(true);
  const [targetType, setTargetType] = useState<CommandPermissionTarget>('role');
  const [targetId, setTargetId] = useState('');
  const [targetEnabled, setTargetEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api
      .get<{ commands: AppCommand[] }>(`/api/integrations/groups/${groupId}/commands`)
      .then((result) => {
        if (!active) return;
        setCommands(result.commands);
        setCommandId((current) =>
          result.commands.some((command) => command.id === current)
            ? current
            : result.commands[0]?.id ?? '',
        );
      })
      .catch(() => {
        if (active) setCommands([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [groupId]);

  useEffect(() => {
    if (!commandId) {
      setOverrides([]);
      setEveryoneEnabled(true);
      return;
    }
    let active = true;
    setLoading(true);
    void api
      .get<{ permissions: AppCommandPermission[] }>(
        `/api/integrations/commands/${commandId}/permissions`,
      )
      .then((result) => {
        if (!active) return;
        const everyone = result.permissions.find(
          (permission) => permission.targetType === 'everyone',
        );
        setEveryoneEnabled(everyone?.enabled ?? true);
        setOverrides(
          result.permissions.filter(
            (permission): permission is AppCommandPermission =>
              permission.targetType !== 'everyone',
          ),
        );
      })
      .catch((error) => {
        if (active) {
          setOverrides([]);
          toast.error(
            error instanceof ApiError
              ? error.message
              : 'Could not load command permissions.',
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [commandId]);

  const targetOptions = useMemo(() => {
    if (targetType === 'role') {
      return roles
        .filter((role) => !role.isDefault)
        .map((role) => ({ id: role.id, label: `@${role.name}` }));
    }
    if (targetType === 'member') {
      return members.map((member) => ({
        id: member.id,
        label: `${member.displayName} (@${member.username})`,
      }));
    }
    return channels.map((channel) => ({
      id: channel.id,
      label: `${channel.type === 'voice' || channel.type === 'stage' ? '🔊' : '#'} ${channel.name}`,
    }));
  }, [channels, members, roles, targetType]);

  useEffect(() => {
    if (!targetOptions.some((option) => option.id === targetId)) {
      setTargetId(targetOptions[0]?.id ?? '');
    }
  }, [targetId, targetOptions]);

  function labelFor(permission: AppCommandPermission) {
    if (permission.targetType === 'role') {
      return `@${roles.find((role) => role.id === permission.targetId)?.name ?? 'Deleted role'}`;
    }
    if (permission.targetType === 'member') {
      const member = members.find((item) => item.id === permission.targetId);
      return member ? `${member.displayName} (@${member.username})` : 'Former member';
    }
    return `#${channels.find((channel) => channel.id === permission.targetId)?.name ?? 'deleted-channel'}`;
  }

  function addOverride() {
    if (!targetId) return;
    setOverrides((current) => {
      const next = current.filter(
        (permission) =>
          !(
            permission.targetType === targetType &&
            permission.targetId === targetId
          ),
      );
      return [
        ...next,
        { targetType, targetId, enabled: targetEnabled },
      ];
    });
  }

  async function save() {
    if (!commandId) return;
    setSaving(true);
    try {
      await api.put(`/api/integrations/commands/${commandId}/permissions`, {
        permissions: [
          {
            targetType: 'everyone',
            targetId: groupId,
            enabled: everyoneEnabled,
          },
          ...overrides,
        ],
      });
      toast.success('Application command access updated.');
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : 'Could not save command permissions.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-group" style={{ marginTop: 22 }}>
      <div className="row between">
        <div>
          <h3>Application command permissions</h3>
          <p className="desc">
            Enable or disable each slash command for everyone, then override individual
            roles, members, or channels.
          </p>
        </div>
        <button
          className="btn primary small"
          disabled={!commandId || saving || loading}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save access'}
        </button>
      </div>
      {!commands.length && !loading ? (
        <p className="muted">No application commands are installed in this server.</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="app-command-select">Command</label>
            <select
              id="app-command-select"
              className="select"
              value={commandId}
              onChange={(event) => setCommandId(event.target.value)}
            >
              {commands.map((command) => (
                <option value={command.id} key={command.id}>
                  /{command.name} — {command.botName}
                </option>
              ))}
            </select>
          </div>
          <label className="discord-setting-row">
            <span>
              <strong>@everyone</strong>
              <small>Default access for all members before the overrides below.</small>
            </span>
            <input
              type="checkbox"
              checked={everyoneEnabled}
              onChange={(event) => setEveryoneEnabled(event.target.checked)}
            />
          </label>
          <div className="compact-list">
            {overrides.map((permission) => (
              <div key={`${permission.targetType}:${permission.targetId}`}>
                <span>
                  <strong>{labelFor(permission)}</strong>
                  <small>{permission.targetType}</small>
                </span>
                <label className="row small">
                  <input
                    type="checkbox"
                    checked={permission.enabled}
                    onChange={(event) =>
                      setOverrides((current) =>
                        current.map((item) =>
                          item.targetType === permission.targetType &&
                          item.targetId === permission.targetId
                            ? { ...item, enabled: event.target.checked }
                            : item,
                        ),
                      )
                    }
                  />
                  {permission.enabled ? 'Allowed' : 'Denied'}
                </label>
                <button
                  className="icon-danger"
                  title="Remove override"
                  onClick={() =>
                    setOverrides((current) =>
                      current.filter((item) => item !== permission),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="row wrap" style={{ marginTop: 10 }}>
            <select
              className="select"
              value={targetType}
              onChange={(event) =>
                setTargetType(event.target.value as CommandPermissionTarget)
              }
            >
              <option value="role">Role</option>
              <option value="member">Member</option>
              <option value="channel">Channel</option>
            </select>
            <select
              className="select"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              {targetOptions.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="select"
              value={targetEnabled ? 'allow' : 'deny'}
              onChange={(event) => setTargetEnabled(event.target.value === 'allow')}
            >
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>
            <button
              className="btn small"
              disabled={!targetId}
              onClick={addOverride}
            >
              Add override
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function GroupSettingsModal({
  group,
  channels,
  categories,
  members,
  invites,
  roles,
  permissions,
  onClose,
  onDone,
  onDelete,
}: {
  group: Group;
  channels: Channel[];
  categories: ChannelCategory[];
  members: GroupMember[];
  invites: Invite[];
  roles: ServerRole[];
  permissions: GroupPermissions;
  onClose: () => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  const { locale } = useI18n();
  const fa = locale === 'fa';
  type SettingsPage =
    | 'overview'
    | 'roles'
    | 'onboarding'
    | 'members'
    | 'invites'
    | 'channels'
    | 'expressions'
    | 'apps'
    | 'community'
    | 'safety'
    | 'insights';
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [iconUrl, setIconUrl] = useState(group.iconUrl ?? '');
  const [accentColor, setAccentColor] = useState(group.accentColor ?? '#5865f2');
  const groupIconInput = useRef<HTMLInputElement>(null);
  const initialDiscovery = Boolean(group.discoverable || group.discoveryRequested);
  const [requestDiscovery, setRequestDiscovery] = useState(initialDiscovery);
  const [require2faModeration, setRequire2faModeration] = useState(
    Boolean(group.require2faModeration),
  );
  const [busy, setBusy] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const currentUserId = useSession((state) => state.user?.id);
  const selfTotpEnabled = useSession((state) => state.user?.totpEnabled ?? false);
  const [permissionChannel, setPermissionChannel] = useState<Channel | null>(null);
  const [permissionCategory, setPermissionCategory] = useState<ChannelCategory | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [editingMember, setEditingMember] = useState<GroupMember | null>(null);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('overview');
  const visibleMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return members;
    return members.filter(
      (member) =>
        member.displayName.toLowerCase().includes(query) ||
        member.username.toLowerCase().includes(query) ||
        member.nickname?.toLowerCase().includes(query),
    );
  }, [memberSearch, members]);

  async function setGroupIcon(attachmentId: string | null) {
    const result = await api.put<{ group: Group }>(`/api/groups/${group.id}/icon`, {
      attachmentId,
    });
    setIconUrl(result.group.iconUrl ?? '');
    onDone();
  }

  async function uploadGroupIcon(file: File) {
    if (!file.type.startsWith('image/')) {
      toast.error(fa ? 'برای تصویر گروه یک فایل تصویری انتخاب کنید.' : 'Choose an image for the server profile.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error(fa ? 'حجم تصویر گروه باید حداکثر ۸ مگابایت باشد.' : 'The server image must be 8 MB or smaller.');
      return;
    }
    setIconBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const uploaded = await api.post<{ attachment: { id: string; url: string } }>(
        '/api/files',
        form,
      );
      await setGroupIcon(uploaded.attachment.id);
      toast.success(fa ? 'تصویر گروه به‌روزرسانی شد.' : 'Server profile image updated.');
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : fa
            ? 'بارگذاری تصویر گروه انجام نشد.'
            : 'Could not upload the server profile image.',
      );
    } finally {
      setIconBusy(false);
    }
  }

  async function generateGroupIcon() {
    setIconBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      const gradient = context.createLinearGradient(24, 20, 488, 492);
      gradient.addColorStop(0, accentColor);
      gradient.addColorStop(1, '#171a2b');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 512, 512);
      context.globalAlpha = 0.18;
      context.fillStyle = '#ffffff';
      context.beginPath();
      context.arc(420, 70, 180, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 0.12;
      context.beginPath();
      context.arc(75, 475, 220, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 1;
      const initials = Array.from((name.trim() || group.name).replace(/\s+/g, ' '))
        .filter((character) => character !== ' ')
        .slice(0, 2)
        .join('')
        .toLocaleUpperCase(locale);
      context.fillStyle = '#ffffff';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = '800 190px Vazirmatn, Arial, sans-serif';
      context.shadowColor = 'rgba(0,0,0,.28)';
      context.shadowBlur = 24;
      context.fillText(initials || 'S', 256, 272);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('Could not create image'))),
          'image/png',
          0.92,
        ),
      );
      await uploadGroupIcon(
        new File([blob], `${group.slug || 'server'}-profile.png`, { type: 'image/png' }),
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : fa
            ? 'ساخت تصویر گروه انجام نشد.'
            : 'Could not generate the server profile image.',
      );
    } finally {
      setIconBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/groups/${group.id}`, {
        name: name.trim(),
        description: description.trim() || null,
        accentColor,
        ...(requestDiscovery !== initialDiscovery ? { requestDiscovery } : {}),
        ...(require2faModeration !== Boolean(group.require2faModeration)
          ? { require2faModeration }
          : {}),
      });
      toast.success(fa ? 'تنظیمات گروه ذخیره شد.' : 'Server settings saved.');
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'ذخیره تنظیمات انجام نشد.' : 'Could not save.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${group.name} — ${fa ? 'تنظیمات گروه' : 'Server Settings'}`} onClose={onClose} wide className="server-settings-modal">
      <div className="server-settings-shell">
        <aside className="server-settings-nav" aria-label={fa ? 'تنظیمات گروه' : 'Server settings'}>
          <div className="server-settings-server">
            <Avatar name={group.name} id={group.id} src={group.iconUrl} color={group.accentColor} size={34} />
            <span><strong>{group.name}</strong><small>{fa ? 'تنظیمات گروه' : 'Server settings'}</small></span>
          </div>
          <span className="server-settings-nav-label">{fa ? 'گروه' : 'Server'}</span>
          {([
            ['overview', 'settings', fa ? 'نمای کلی' : 'Overview'],
            ['roles', 'tag', fa ? 'نقش‌ها' : 'Roles'],
            ['onboarding', 'users', fa ? 'آغاز به کار' : 'Onboarding'],
            ['members', 'users', fa ? `اعضا · ${members.length}` : `Members · ${members.length}`],
            ['invites', 'link', fa ? `دعوت‌ها · ${invites.length}` : `Invites · ${invites.length}`],
            ['channels', 'hash', fa ? `کانال‌ها · ${channels.length}` : `Channels · ${channels.length}`],
          ] as [SettingsPage, Parameters<typeof Icon>[0]['name'], string][]).map(([id, icon, label]) => (
            <button key={id} className={settingsPage === id ? 'active' : ''} onClick={() => setSettingsPage(id)}>
              <Icon name={icon} size={17} /><span>{label}</span>
            </button>
          ))}
          <span className="server-settings-nav-label">{fa ? 'اجتماع' : 'Community'}</span>
          {([
            ['expressions', 'smile', fa ? 'شکلک‌ها و صداها' : 'Expressions'],
            ['apps', 'link', fa ? 'برنامه‌ها و فرمان‌ها' : 'Apps & Commands'],
            ['community', 'compass', fa ? 'تنظیمات اجتماع' : 'Community'],
            ['safety', 'shield', fa ? 'ایمنی و مدیریت' : 'Safety & Moderation'],
            ['insights', 'chart', fa ? 'آمار گروه' : 'Server Insights'],
          ] as [SettingsPage, Parameters<typeof Icon>[0]['name'], string][]).map(([id, icon, label]) => (
            <button key={id} className={settingsPage === id ? 'active' : ''} onClick={() => setSettingsPage(id)}>
              <Icon name={icon} size={17} /><span>{label}</span>
            </button>
          ))}
          {permissions.deleteGroup ? (
            <>
              <span className="server-settings-nav-label">{fa ? 'منطقه خطر' : 'Danger zone'}</span>
              <button className="danger" onClick={onDelete}><Icon name="trash" size={17} /><span>{fa ? 'حذف گروه' : 'Delete Server'}</span></button>
            </>
          ) : null}
        </aside>
        <section className="server-settings-content">
          <div className="settings-page-heading">
            <span className="eyebrow">{fa ? 'تنظیمات گروه' : 'Server settings'}</span>
            <h2>{({
              overview: fa ? 'نمای کلی' : 'Overview',
              roles: fa ? 'نقش‌ها' : 'Roles',
              onboarding: fa ? 'آغاز به کار' : 'Onboarding',
              members: fa ? 'اعضا' : 'Members',
              invites: fa ? 'دعوت‌ها و دسترسی' : 'Invites & Access',
              channels: fa ? 'کانال‌ها' : 'Channels',
              expressions: fa ? 'شکلک‌ها و صداها' : 'Expressions',
              apps: fa ? 'برنامه‌ها و فرمان‌ها' : 'Apps & Commands',
              community: fa ? 'اجتماع' : 'Community',
              safety: fa ? 'ایمنی و مدیریت' : 'Safety & Moderation',
              insights: fa ? 'آمار گروه' : 'Server Insights',
            } as Record<SettingsPage, string>)[settingsPage]}</h2>
          </div>
      {settingsPage === 'overview' ? (
        <>
      <div className="server-settings-hero" style={{ '--server-accent': accentColor } as CSSProperties}>
        <div className="server-settings-hero-icon">
          <Avatar
            name={name || group.name}
            id={group.id}
            src={iconUrl || undefined}
            color={accentColor}
            size={76}
          />
          <span />
        </div>
        <div className="server-settings-hero-copy">
          <span className="server-settings-kicker">{fa ? 'پروفایل گروه' : 'SERVER PROFILE'}</span>
          <h3>{name || group.name}</h3>
          <p>{description || (fa ? 'برای معرفی بهتر گروه، توضیح کوتاهی اضافه کنید.' : 'Add a short description to introduce your community.')}</p>
          <div className="server-settings-stats">
            <span><Icon name="users" size={14} /><strong>{members.length}</strong>{fa ? 'عضو' : 'members'}</span>
            <span><Icon name="hash" size={14} /><strong>{channels.length}</strong>{fa ? 'کانال' : 'channels'}</span>
            <span><Icon name="tag" size={14} /><strong>{roles.length}</strong>{fa ? 'نقش' : 'roles'}</span>
          </div>
        </div>
        <span className={`server-settings-health${group.discoverable ? ' public' : ''}`}>
          <i />
          {group.discoverable ? (fa ? 'عمومی' : 'Discoverable') : (fa ? 'خصوصی' : 'Private')}
        </span>
      </div>
      <details className="effective-permissions-summary">
        <summary>
          <span>
            <strong>{fa ? 'مجوزهای مؤثر شما' : 'Your effective permissions'}</strong>
            <small>{fa ? `${permissions.effective.length} مجوز از نقش همگانی و نقش‌های اختصاص‌یافته` : `${permissions.effective.length} permissions from @everyone and all assigned roles`}</small>
          </span>
          <span>{permissions.administrator ? (fa ? 'مدیر کل' : 'Administrator') : (fa ? 'دسترسی مشاهده' : 'View access')}</span>
        </summary>
        <div>
          {permissions.effective.map((key) => {
            const permission = SERVER_PERMISSION_OPTIONS.find((item) => item.key === key);
            return permission ? (
              <span key={key} title={permissionCopy(permission, fa).description}>{permissionCopy(permission, fa).label}</span>
            ) : null;
          })}
        </div>
      </details>
      {permissions.manageGroup ? (
        <>
          <div className="grid-2">
            <div className="field">
              <label>{fa ? 'تصویر گروه' : 'Server icon'}</label>
              <input
                ref={groupIconInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  void uploadGroupIcon(file);
                }}
              />
              <div className="server-profile-editor">
                <div className="server-profile-avatar" style={{ '--server-accent': accentColor } as CSSProperties}>
                  <Avatar
                    name={name || group.name}
                    id={group.id}
                    src={iconUrl || undefined}
                    color={accentColor}
                    size={92}
                  />
                  {iconBusy ? <span className="server-profile-loading"><span className="spinner" /></span> : null}
                </div>
                <div className="server-profile-actions">
                  <strong>{fa ? 'هویت تصویری گروه' : 'Server profile identity'}</strong>
                  <small>
                    {fa
                      ? 'تصویر مربعی PNG، JPEG، GIF یا WebP تا حجم ۸ مگابایت'
                      : 'Square PNG, JPEG, GIF or WebP, up to 8 MB'}
                  </small>
                  <div className="row">
                    <button
                      className="btn primary small"
                      type="button"
                      disabled={iconBusy}
                      onClick={() => groupIconInput.current?.click()}
                    >
                      <Icon name="camera" size={16} />
                      {fa ? 'بارگذاری تصویر' : 'Upload image'}
                    </button>
                    <button
                      className="btn small"
                      type="button"
                      disabled={iconBusy}
                      onClick={() => void generateGroupIcon()}
                    >
                      <Icon name="settings" size={16} />
                      {fa ? 'ساخت خودکار' : 'Generate one'}
                    </button>
                    {iconUrl ? (
                      <button
                        className="btn danger small"
                        type="button"
                        disabled={iconBusy}
                        onClick={async () => {
                          setIconBusy(true);
                          try {
                            await setGroupIcon(null);
                            toast.success(fa ? 'تصویر گروه حذف شد.' : 'Server profile image removed.');
                          } catch (error) {
                            toast.error(error instanceof ApiError ? error.message : (fa ? 'حذف تصویر انجام نشد.' : 'Could not remove the image.'));
                          } finally {
                            setIconBusy(false);
                          }
                        }}
                      >
                        {fa ? 'حذف' : 'Remove'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            <div className="field">
              <label htmlFor="group-accent">{fa ? 'رنگ اصلی گروه' : 'Server accent color'}</label>
              <div className="role-color-control">
                <input
                  id="group-accent"
                  className="role-color-input"
                  type="color"
                  value={accentColor}
                  onChange={(event) => setAccentColor(event.target.value)}
                />
                <code>{accentColor.toUpperCase()}</code>
              </div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="group-name">{fa ? 'نام گروه' : 'Server name'}</label>
            <input id="group-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="group-desc">{fa ? 'توضیحات' : 'Description'}</label>
            <textarea
              id="group-desc"
              className="textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
            />
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={requestDiscovery}
              onChange={(event) => setRequestDiscovery(event.target.checked)} />
            <span>
              {fa ? 'نمایش این گروه در فهرست عمومی' : 'List this server in Server Discovery'}
              <br />
              <span className="hint">
                {group.discoverable ? (fa ? 'تأیید شده و برای همه قابل مشاهده است.' : 'Verified and publicly discoverable.')
                  : group.discoveryRequested ? (fa ? 'در انتظار تأیید مدیر سامانه است.' : 'Waiting for platform administrator approval.')
                    : (fa ? 'نمایش عمومی پس از تأیید مدیر سامانه فعال می‌شود.' : 'A platform administrator must approve the listing before it appears.')}
              </span>
            </span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={require2faModeration}
              disabled={!selfTotpEnabled && !require2faModeration}
              onChange={(event) => setRequire2faModeration(event.target.checked)}
            />
            <span>
              {fa ? 'الزام احراز هویت دومرحله‌ای برای مدیریت' : 'Require 2FA for moderation'}
              <br />
              <span className="hint">
                {fa ? 'از عملیات حساس نقش، کانال، عضو، رویداد، وب‌هوک و پیام محافظت می‌کند.' : 'Protects dangerous role, channel, member, event, webhook, and message actions.'}
                {!selfTotpEnabled ? (fa ? ' ابتدا احراز هویت دومرحله‌ای حساب خود را فعال کنید.' : ' Enable 2FA on your account first.') : ''}
              </span>
            </span>
          </label>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? (fa ? 'در حال ذخیره…' : 'Saving…') : (fa ? 'ذخیره تغییرات' : 'Save changes')}
          </button>
        </>
      ) : null}
        </>
      ) : null}

      {settingsPage === 'roles' ? <ServerRolesSection
          groupId={group.id}
          roles={roles}
          members={members}
          canManage={permissions.manageRoles}
          highestRolePosition={permissions.highestRolePosition}
          onDone={onDone}
      /> : null}

      {settingsPage === 'onboarding' ? <OnboardingRolesSection
        groupId={group.id}
        roles={roles}
        member={members.find((member) => member.id === currentUserId)}
        onDone={onDone}
      /> : null}

      {settingsPage === 'invites' ? (
        <ServerInvitesSection
          groupId={group.id}
          invites={invites}
          canCreate={permissions.createInvite}
          onDone={onDone}
        />
      ) : null}

      {settingsPage === 'apps' && permissions.manageRoles ? (
        <AppCommandPermissionsSection
          groupId={group.id}
          channels={channels}
          members={members}
          roles={roles}
        />
      ) : settingsPage === 'apps' ? (
        <EmptyState icon={<Icon name="link" size={34} />} title="App permissions are restricted">
          You need Manage Roles to configure application command access.
        </EmptyState>
      ) : null}

      {settingsPage === 'expressions' ? <ServerExpressionsSection
        groupId={group.id}
        canManage={permissions.manageExpressions}
        canCreate={
          permissions.manageExpressions ||
          permissions.effective.includes('createExpressions')
        }
      /> : null}

      {settingsPage === 'insights' && (permissions.effective.includes('viewServerInsights') || permissions.administrator) ? (
        <ServerInsightsSection groupId={group.id} />
      ) : settingsPage === 'insights' ? (
        <EmptyState icon={<Icon name="chart" size={34} />} title="Server Insights is restricted">
          You need the View Server Insights permission to access analytics.
        </EmptyState>
      ) : null}

      {settingsPage === 'community' ? <ServerCommunitySection
        groupId={group.id}
        channels={channels}
        canManage={permissions.manageGroup}
      /> : null}

      {settingsPage === 'safety' && (permissions.viewAuditLog || permissions.moderateMembers || permissions.banMembers) ? (
        <ServerModerationSection groupId={group.id} members={members} canManageRules={permissions.manageGroup} />
      ) : null}

      {settingsPage === 'safety' && permissions.manageChannels ? (
        <AnnouncementFollowsSection groupId={group.id} channels={channels} />
      ) : null}
      {settingsPage === 'safety' &&
      !permissions.viewAuditLog &&
      !permissions.moderateMembers &&
      !permissions.banMembers &&
      !permissions.manageChannels ? (
        <EmptyState icon={<Icon name="shield" size={34} />} title="Safety settings are restricted">
          A moderation permission is required to view this area.
        </EmptyState>
      ) : null}

      {settingsPage === 'members' ? <>
      <div className="section-label" style={{ padding: '22px 0 6px' }}>
        <span>Members — {members.length}</span>
      </div>
      <div className="member-table-toolbar">
        <input
          className="input"
          value={memberSearch}
          onChange={(event) => setMemberSearch(event.target.value)}
          placeholder="Search members"
        />
        <span className="muted small">{visibleMembers.length} shown</span>
      </div>
      <div className="table-wrap">
        <table style={{ minWidth: 480 }}>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visibleMembers.map((member) => (
              <tr key={member.id}>
                <td>
                  <div className="identity">
                    <Avatar name={member.displayName} id={member.id} color={member.bannerColor} size={28} />
                    <div className="who">
                      <div className="name">{member.displayName}</div>
                      <div className="sub">@{member.username}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="server-role-assignment">
                    {member.memberRole === 'owner' ? <span className="badge owner">Owner</span> : null}
                    {member.memberRole !== 'member' && member.memberRole !== 'owner' ? (
                      <span className="badge">{member.memberRole}</span>
                    ) : null}
                    {member.serverRoles.map((role) => {
                      return (
                        <span className="server-role-chip" style={{ borderColor: role.color ?? undefined }} key={role.id}>
                          <span className="role-dot" style={{ background: role.color ?? '#99aab5' }} />
                          {role.name}
                        </span>
                      );
                    })}
                    {!member.serverRoles.length && member.memberRole === 'member' ? <span className="muted small">@everyone</span> : null}
                  </div>
                </td>
                <td className="actions">
                  {(permissions.manageRoles ||
                    permissions.manageNicknames ||
                    permissions.kickMember ||
                    permissions.banMembers ||
                    permissions.moderateMembers) &&
                  member.memberRole !== 'owner' ? (
                    <button
                      className="btn small"
                      onClick={() => setEditingMember(member)}
                    >
                      Manage
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editingMember ? (
        <MemberManagementModal
          groupId={group.id}
          member={editingMember}
          roles={roles}
          permissions={permissions}
          onClose={() => setEditingMember(null)}
          onDone={() => {
            setEditingMember(null);
            onDone();
          }}
        />
      ) : null}
      </> : null}

      {settingsPage === 'channels' ? <>
      <div className="section-label" style={{ padding: '22px 0 6px' }}>
        Channels — {channels.length}
      </div>
      <div className="col">
        {categories.map((category) => (
          <div className="settings-channel-row" key={category.id}>
            <span className="settings-channel-identity"><Icon name="directory" size={17} /><strong>{category.name}</strong><small>Category</small></span>
            {permissions.manageChannels ? (
              <span className="row">
                <button className="btn small" onClick={() => setPermissionCategory(category)}>
                  Permissions
                </button>
                <button
                  className="btn small"
                  onClick={async () => {
                    const name = window
                      .prompt('New category name', category.name)
                      ?.trim();
                    if (!name || name === category.name) return;
                    try {
                      await api.patch(
                        `/api/groups/${group.id}/categories/${category.id}`,
                        { name },
                      );
                      toast.success('Category renamed.');
                      onDone();
                    } catch (error) {
                      toast.error(
                        error instanceof ApiError
                          ? error.message
                          : 'Could not rename the category.',
                      );
                    }
                  }}
                >
                  Rename
                </button>
                <button
                  className="btn small danger"
                  onClick={async () => {
                    try {
                      await api.del(`/api/groups/${group.id}/categories/${category.id}`);
                      onDone();
                    } catch (error) {
                      toast.error(
                        error instanceof ApiError ? error.message : 'Could not delete the category.',
                      );
                    }
                  }}
                >
                  Delete category
                </button>
              </span>
            ) : null}
          </div>
        ))}
        {permissions.manageChannels ? (
          <InlineCategoryCreator groupId={group.id} onDone={onDone} />
        ) : null}
        {channels.map((channel) => (
          <div className="settings-channel-row" key={channel.id}>
            <span className="settings-channel-identity">
              <Icon name={channel.type === 'voice' ? 'speaker' : channel.type === 'stage' ? 'microphone' : channel.type === 'forum' ? 'forum' : channel.type === 'announcement' ? 'announcement' : channel.isPrivate ? 'lock' : 'hash'} size={17} />
              <strong>{channel.name}</strong><small>{channel.type}{channel.permissionsSynced ? ' · synced' : ''}</small>
            </span>
            {permissions.manageChannels ? (
              <span className="row">
                <button className="btn small" onClick={() => setPermissionChannel(channel)}>
                  Permissions
                </button>
                {channel.categoryId && !channel.permissionsSynced ? (
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        await api.post(
                          `/api/groups/${group.id}/channels/${channel.id}/permissions/sync`,
                        );
                        toast.success('Channel permissions synced with its category.');
                        onDone();
                      } catch (error) {
                        toast.error(error instanceof ApiError ? error.message : 'Could not sync permissions.');
                      }
                    }}
                  >
                    Sync
                  </button>
                ) : null}
                <button className="btn small" onClick={async () => {
                  const name = window.prompt('New channel name', channel.name)?.trim();
                  if (!name || name === channel.name) return;
                  try {
                    await api.patch(`/api/groups/${group.id}/channels/${channel.id}`, { name });
                    onDone();
                    toast.success('Channel renamed.');
                  } catch (error) {
                    toast.error(error instanceof ApiError ? error.message : 'Could not rename the channel.');
                  }
                }}>Rename</button>
                <button
                  className="btn small danger"
                  onClick={async () => {
                    try {
                      await api.del(`/api/groups/${group.id}/channels/${channel.id}`);
                      onDone();
                    } catch (error) {
                      toast.error(error instanceof ApiError ? error.message : 'Could not delete the channel.');
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            ) : null}
          </div>
        ))}
      </div>
      </> : null}
      <div style={{ height: 20 }} />
      {permissionChannel ? (
        <ChannelPermissionsModal
          groupId={group.id}
          channel={permissionChannel}
          roles={roles}
          members={members}
          onClose={() => setPermissionChannel(null)}
          onDone={onDone}
        />
      ) : null}
      {permissionCategory ? (
        <ChannelPermissionsModal
          groupId={group.id}
          channel={permissionCategory}
          categoryMode
          roles={roles}
          members={members}
          onClose={() => setPermissionCategory(null)}
          onDone={onDone}
        />
      ) : null}
        </section>
      </div>
    </Modal>
  );
}
