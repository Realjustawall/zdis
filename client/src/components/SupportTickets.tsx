import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useRealtime } from '../store/realtime';

type Ticket = { id: string; channel_id: string; status: string; username: string; created_at: number };
export function SupportTickets({ groupId }: { groupId: string }) {
  const { locale } = useI18n(), fa = locale === 'fa';
  const socket = useRealtime(state => state.socket);
  const [enabled, setEnabled] = useState(false), [open, setOpen] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]), [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setEnabled(false); setOpen(false); setTickets([]); setError('');
    const refresh = () => { void api.get<{ tickets: boolean }>(`/api/builtin-bots/groups/${groupId}/status`)
      .then(result => { if (current) setEnabled(result.tickets); }).catch(() => {}); };
    const changed = (payload: { groupId: string }) => { if (payload.groupId === groupId) refresh(); };
    refresh(); socket?.on('group:member-updated', changed); socket?.on('connect', refresh);
    return () => { current = false; socket?.off('group:member-updated', changed); socket?.off('connect', refresh); };
  }, [groupId, socket]);
  async function load() {
    const result = await api.get<{ tickets: Ticket[] }>(`/api/builtin-bots/groups/${groupId}/tickets`);
    setTickets(result.tickets);
  }
  if (!enabled) return null;
  return <>
    <button type="button" className="composer-btn" aria-label={fa ? 'تیکت پشتیبانی' : 'Support tickets'} title={fa ? 'تیکت پشتیبانی' : 'Support tickets'} onClick={() => {
      setOpen(value => !value); setError(''); void load().catch(e => setError(e.message));
    }}>🎫</button>
    {open ? <div className="media-picker emoji-popover" role="dialog" aria-label={fa ? 'تیکت پشتیبانی' : 'Support tickets'}>
      <header><strong>{fa ? 'پشتیبانی' : 'Support tickets'}</strong><button onClick={() => setOpen(false)} aria-label="Close support tickets">×</button></header>
      <form onSubmit={event => {
        event.preventDefault(); setBusy(true); setError('');
        void api.post(`/api/builtin-bots/groups/${groupId}/tickets`, { topic: topic.trim() })
          .then(() => { setTopic(''); return load(); }).catch(e => setError(e.message)).finally(() => setBusy(false));
      }}>
        <label>{fa ? 'موضوع درخواست' : 'Ticket topic'}<input className="input" value={topic} minLength={3} maxLength={500} required onChange={event => setTopic(event.target.value)} /></label>
        <button className="btn" disabled={busy || topic.trim().length < 3}>{fa ? 'ساخت تیکت خصوصی' : 'Create private ticket'}</button>
      </form>
      <p className="faint">{fa ? 'کانال خصوصی تیکت در فهرست کانال‌های سرور نمایش داده می‌شود.' : 'Your private ticket appears in the server channel list.'}</p>
      <div className="bot-cases">{tickets.map(ticket => <article key={ticket.id}>
        <strong>{ticket.username}</strong> · {ticket.status}
        <a href={`/api/builtin-bots/groups/${groupId}/tickets/${ticket.id}/transcript`} download>{fa ? 'دریافت متن گفتگو' : 'Download transcript'}</a>
        {ticket.status !== 'closed' ? <button className="btn" disabled={busy} onClick={() => {
          setBusy(true); setError(''); void api.patch(`/api/builtin-bots/groups/${groupId}/tickets/${ticket.id}`, { action: 'close' })
            .then(load).catch(e => setError(e.message)).finally(() => setBusy(false));
        }}>{fa ? 'بستن تیکت' : 'Close ticket'}</button> : null}
      </article>)}</div>
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
  </>;
}
