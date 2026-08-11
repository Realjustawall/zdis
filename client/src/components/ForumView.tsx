import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { toast } from '../store/toast';
import type { Channel, ForumPost, Message } from '../types';
import { Avatar, EmptyState, Modal } from './ui';
import { Icon } from './Icon';

export function ForumView({
  channel,
  canModerate,
  onBack,
}: {
  channel: Channel;
  canModerate: boolean;
  onBack: () => void;
}) {
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [creating, setCreating] = useState(false);
  const [openPost, setOpenPost] = useState<ForumPost | null>(null);

  async function load() {
    try {
      const data = await api.get<{ posts: ForumPost[] }>(`/api/forums/${channel.id}/posts`);
      setPosts(data.posts);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not load forum posts.');
    }
  }

  useEffect(() => {
    void load();
  }, [channel.id]);

  return (
    <div className="main forum-view">
      <header className="main-head">
        <button className="head-btn" onClick={onBack}><Icon name="menu" size={19} /></button>
        <span className="title"><span className="glyph channel-glyph"><Icon name="forum" size={18} /></span>{channel.name}</span>
        <span className="topic">{channel.topic}</span>
        <span className="spacer" />
        <button className="btn primary compact" onClick={() => setCreating(true)}><Icon name="add" size={16} /> New Post</button>
      </header>
      <div className="forum-grid">
        {posts.map((post) => (
          <button className="forum-card" key={post.id} onClick={() => setOpenPost(post)}>
            <Avatar
              name={post.author.displayName}
              id={post.authorId}
              src={post.author.avatarUrl}
              color={post.author.bannerColor}
              size={38}
            />
            <span className="forum-card-body">
              <strong>{post.title}</strong>
              <small>
                {post.author.displayName} · {new Date(post.updatedAt).toLocaleString()} · {post.replyCount} replies
              </small>
              <span className="forum-tags">
                {post.tags.map((tag) => <i key={tag}>{tag}</i>)}
                {post.locked ? <i><Icon name="lock" size={12} /> Locked</i> : null}
                {post.private ? <i><Icon name="users" size={12} /> Private · {post.memberCount}</i> : null}
              </span>
            </span>
          </button>
        ))}
        {!posts.length ? (
          <EmptyState icon={<Icon name="forum" size={34} />} title="No posts yet">
            Start the first discussion in this forum.
          </EmptyState>
        ) : null}
      </div>
      {creating ? (
        <NewForumPost channelId={channel.id} onClose={() => setCreating(false)} onDone={() => {
          setCreating(false);
          void load();
        }} />
      ) : null}
      {openPost ? (
        <ForumThread
          channelId={channel.id}
          post={openPost}
          canModerate={canModerate}
          onClose={() => setOpenPost(null)}
          onChanged={() => {
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function NewForumPost({ channelId, onClose, onDone }: { channelId: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [privateThread, setPrivateThread] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Create forum post" onClose={onClose} footer={
      <>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !title.trim() || !content.trim()} onClick={async () => {
          setBusy(true);
          try {
            await api.post(`/api/forums/${channelId}/posts`, {
              title: title.trim(),
              content: content.trim(),
              tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 5),
              private: privateThread,
            });
            toast.success('Forum post created.');
            onDone();
          } catch (error) {
            toast.error(error instanceof ApiError ? error.message : 'Could not create the post.');
          } finally {
            setBusy(false);
          }
        }}>{busy ? 'Creating…' : 'Create Post'}</button>
      </>
    }>
      <div className="field"><label>Title</label><input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label>Message</label><textarea className="textarea" value={content} maxLength={4000} onChange={(e) => setContent(e.target.value)} /></div>
      <div className="field"><label>Tags (comma separated)</label><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={privateThread}
          onChange={(event) => setPrivateThread(event.target.checked)}
        />
        <span>
          Private thread
          <small>Only invited server members and moderators can see or reply.</small>
        </span>
      </label>
    </Modal>
  );
}

function ForumThread({
  channelId,
  post,
  canModerate,
  onClose,
  onChanged,
}: {
  channelId: string;
  post: ForumPost;
  canModerate: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState('');
  async function load() {
    const data = await api.get<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages/${post.rootMessageId}/thread`,
    );
    setMessages(data.messages);
  }
  useEffect(() => { void load(); }, [post.id]);
  return (
    <Modal title={post.title} description={post.tags.join(' · ')} onClose={onClose} wide>
      <div className="forum-thread">
        {messages.map((message) => (
          <div className="forum-thread-message" key={message.id}>
            <Avatar name={message.author?.displayName ?? '?'} id={message.authorId} size={30} color={message.author?.bannerColor} />
            <span><strong>{message.author?.displayName ?? 'Unknown'}</strong><p>{message.content}</p></span>
          </div>
        ))}
      </div>
      {!post.locked && !post.archived ? (
        <div className="forum-reply">
          <textarea className="textarea" placeholder="Reply to this post…" value={content} onChange={(e) => setContent(e.target.value)} />
          <button className="btn primary" disabled={!content.trim()} onClick={async () => {
            try {
              await api.post(`/api/channels/${channelId}/messages`, {
                content: content.trim(),
                replyToId: post.rootMessageId,
              });
              setContent('');
              await load();
              onChanged();
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : 'Could not reply.');
            }
          }}><Icon name="send" size={16} /> Reply</button>
        </div>
      ) : <div className="alert info">{post.locked ? 'This post is locked.' : 'This post is archived.'}</div>}
      {canModerate ? (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn small" onClick={async () => {
            await api.patch(`/api/forums/${channelId}/posts/${post.id}`, { locked: !post.locked });
            post.locked = !post.locked;
            onChanged();
          }}><Icon name="lock" size={15} /> {post.locked ? 'Unlock' : 'Lock'}</button>
          <button className="btn small" onClick={async () => {
            await api.patch(`/api/forums/${channelId}/posts/${post.id}`, { archived: true });
            onChanged();
            onClose();
          }}><Icon name="archive" size={15} /> Archive</button>
        </div>
      ) : null}
      {post.private && post.canManageMembers ? (
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn small"
            onClick={async () => {
              const username = window.prompt('Invite a server member by username:');
              if (!username?.trim()) return;
              try {
                await api.post(`/api/forums/${channelId}/posts/${post.id}/members`, {
                  username: username.trim().toLowerCase(),
                });
                post.memberCount += 1;
                toast.success(`@${username.trim()} can now access this private thread.`);
                onChanged();
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'Could not invite that member.');
              }
            }}
          >
            Add member
          </button>
          <span className="muted small">{post.memberCount} members have access</span>
        </div>
      ) : null}
    </Modal>
  );
}
