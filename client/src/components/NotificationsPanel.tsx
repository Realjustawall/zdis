import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatRelative } from '../lib/format';
import { toast } from '../store/toast';
import type { Notification } from '../types';
import { EmptyState, Modal } from './ui';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';

export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const { locale } = useI18n();
  const fa = locale === 'fa';

  async function load() {
    setLoading(true);
    try {
      const result = await api.get<{ notifications: Notification[] }>('/api/notifications');
      setItems(result.notifications);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (fa ? 'بارگذاری اعلان‌ها انجام نشد.' : 'Could not load notifications.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function markRead(id?: string) {
    await api.post('/api/notifications/read', { id: id ?? null });
    setItems((current) =>
      current.map((item) =>
        !id || item.id === id ? { ...item, readAt: item.readAt ?? Date.now() } : item,
      ),
    );
  }

  return (
    <Modal
      title={fa ? 'اعلان‌ها' : 'Notifications'}
      onClose={onClose}
      wide
      footer={
        items.some((item) => !item.readAt) ? (
          <button className="btn" onClick={() => void markRead()}>
            {fa ? 'خواندن همه' : 'Mark all as read'}
          </button>
        ) : null
      }
    >
      {loading ? (
        <div className="center-screen" style={{ minHeight: 180 }}>
          <span className="spinner" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Icon name="bell" size={34} />} title={fa ? 'اعلانی وجود ندارد' : 'No notifications'}>
          {fa ? 'اشاره‌ها، پیام‌های خصوصی و به‌روزرسانی‌های نظارتی اینجا نمایش داده می‌شوند.' : 'Mentions, direct messages and moderation updates will appear here.'}
        </EmptyState>
      ) : (
        <div className="notification-list">
          {items.map((item) => (
            <button
              key={item.id}
              className={`notification-item${item.readAt ? '' : ' unread'}`}
              onClick={() => void markRead(item.id)}
            >
              <span className="notification-dot" />
              <span className="notification-icon"><Icon name="bell" size={17} /></span>
              <span>
                <strong>{item.title}</strong>
                <span>{item.body}</span>
                <small>{formatRelative(item.createdAt)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
