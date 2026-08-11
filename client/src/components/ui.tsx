import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { colorFor, initials } from '../lib/format';
import type { Badge, GroupRole, PlatformRole, Presence } from '../types';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';

interface AvatarProps {
  name: string;
  id?: string;
  src?: string | null;
  color?: string | null;
  size?: number;
  presence?: Presence | null;
}

export function Avatar({ name, id, src, color, size = 36, presence }: AvatarProps) {
  const dot = Math.max(9, Math.round(size * 0.3));
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        background: color ?? colorFor(id ?? name),
        fontSize: Math.round(size * 0.38),
      }}
      aria-hidden={false}
      title={name}
    >
      {src ? <img src={src} alt="" /> : initials(name)}
      {presence ? (
        <span className={`status-dot ${presence}`} style={{ width: dot, height: dot }} />
      ) : null}
    </div>
  );
}

export function RoleBadge({ role }: { role: PlatformRole }) {
  const { locale } = useI18n();
  const labels =
    locale === 'fa'
      ? { admin: 'مدیر', youtuber: 'سازنده محتوا', member: 'عضو' }
      : { admin: 'Admin', youtuber: 'Content creator', member: 'Member' };
  const label = labels[role];
  return <span className={`badge ${role}`}>{label}</span>;
}

export function BadgeList({ badges, compact = false }: { badges?: Badge[]; compact?: boolean }) {
  if (!badges?.length) return null;
  return (
    <span className="row wrap" style={{ gap: 4 }}>
      {badges.map((badge) => (
        <span
          key={badge.id}
          className="badge"
          title={badge.label}
          style={{
            color: badge.color,
            borderColor: `${badge.color}66`,
            fontSize: compact ? 8 : 10,
          }}
        >
          {compact ? badge.label.slice(0, 1) : badge.label}
        </span>
      ))}
    </span>
  );
}

export function GroupRoleBadge({ role }: { role: GroupRole }) {
  if (role === 'member') return null;
  return <span className={`badge ${role === 'admin' ? 'owner' : role}`}>{role}</span>;
}

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}

export function Modal({ title, description, onClose, children, footer, wide, className }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog so keyboard users are not left behind it.
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="close" onClick={onClose} aria-label={t('ui.close')}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'success' | 'info'; children: ReactNode }) {
  return (
    <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

export function ErrorList({ lines }: { lines: string[] }) {
  const { t } = useI18n();
  if (lines.length === 1) return <Alert kind="error">{lines[0]}</Alert>;
  return (
    <Alert kind="error">
      {t('ui.fixFollowing')}
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Alert>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ gap: 10 }}>
      <span className="spinner" />
      {label ? <span className="muted small">{label}</span> : null}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="icon">{icon}</div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function Confirm({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onCancel,
  busy,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            {t('ui.cancel')}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? t('common.working') : confirmLabel === 'Confirm' ? t('ui.confirm') : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ paddingBottom: 8 }}>{message}</div>
    </Modal>
  );
}
