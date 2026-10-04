import { useEffect, useState } from 'react';
import { useRealtime } from '../store/realtime';
import { useSession } from '../store/session';
import { useI18n } from '../lib/i18n';
import type { PublicUser } from '../types';
import { Icon } from './Icon';

interface Move { from: string | number; to: string | number; die?: number; promotion?: string | null }
interface GameState {
  id: string; revision: number; players: (string | null)[]; turn: number;
  status: 'waiting' | 'playing' | 'finished'; winner: number | null; reason?: string;
  fen?: string; check?: boolean; history?: string[]; board?: (number | null)[];
  winningLine?: number[]; points?: number[]; bar?: number[]; off?: number[];
  dice?: number[]; lastRoll?: number[]; score?: number; legal?: Move[];
}
export interface VoiceActivity {
  name: string; startedBy: string; state: GameState; createdAt: number; updatedAt: number;
}
const games = [
  { id: 'chess', icon: '♞', en: 'Chess', fa: 'شطرنج', description: 'Plan your next move.', descriptionFa: 'با فکر، حرکت بعدی را انتخاب کن.' },
  { id: 'tic-tac-toe', icon: '✕', en: 'Tic-tac-toe', fa: 'دوز', description: 'Three in a row wins.', descriptionFa: 'سه مهره در یک ردیف؛ یک برد سریع.' },
  { id: 'backgammon', icon: '⚄', en: 'Backgammon', fa: 'تخته‌نرد', description: 'Roll, race, and bear off.', descriptionFa: 'تاس بریز، حرکت کن و مهره‌ها را خارج کن.' },
];
const pieces: Record<string, string> = { K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟' };

export function VoiceActivities({ activity, members, canStart, isHost, onChange, onClose }: {
  activity: VoiceActivity | null; members: PublicUser[]; canStart: boolean; isHost: boolean;
  onChange: (activity: VoiceActivity | null) => void; onClose: () => void;
}) {
  const user = useSession(state => state.user)!;
  const { locale } = useI18n(); const fa = locale === 'fa';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | number | null>(null);
  const [promotion, setPromotion] = useState('q');
  useEffect(() => { setSelected(null); setError(''); }, [activity?.state.id, activity?.state.revision]);
  const state = activity?.state;
  const player = state?.players?.indexOf(user.id) ?? -1;
  const myTurn = player !== -1 && state?.turn === player && state?.status === 'playing';
  const nameFor = (id: string | null) => id ? members.find(member => member.id === id)?.displayName ?? (id === user.id ? user.displayName : (fa ? 'بازیکن' : 'Player')) : (fa ? 'جای خالی' : 'Open seat');
  async function send(action: string, extra: Record<string, unknown> = {}) {
    if (pending) return;
    if (!useRealtime.getState().connected) { setError(fa ? 'اتصال قطع است. دوباره تلاش کن.' : 'Disconnected. Please reconnect first.'); return; }
    setPending(true); setError('');
    try {
      const result = await new Promise<{ ok: boolean; error?: string; activity?: VoiceActivity | null }>((resolve) => {
        const timer = window.setTimeout(() => resolve({ ok:false, error:fa ? 'سرور پاسخ نداد. وضعیت بازی را بررسی کن.' : 'The server did not respond. Check the current game before retrying.' }), 8000);
        useRealtime.getState().emit('voice:activity', { action, gameId:state?.id, revision:state?.revision, ...extra }, (reply: { ok:boolean; error?:string; activity?: VoiceActivity | null }) => { clearTimeout(timer); resolve(reply); });
      });
      if (!result.ok) setError(result.error ?? 'Activity failed.');
      else { onChange(result.activity ?? null); setSelected(null); }
    } finally { setPending(false); }
  }
  const play = (move: Record<string, unknown>) => void send('play', { move });
  const title = games.find(game => game.id === activity?.name);
  const status = !state ? '' : state.status === 'waiting' ? (fa ? 'منتظر بازیکن دوم' : 'Waiting for a second player') : state.status === 'finished' ? (state.winner === null ? (fa ? 'بازی مساوی شد' : 'Draw') : `${nameFor(state.players[state.winner])} ${fa ? 'برنده شد' : 'wins'}${state.score ? ` · ${state.score} ${fa ? 'امتیاز' : 'point(s)'}` : ''}`) : `${nameFor(state.players[state.turn])} · ${fa ? 'نوبت بازی' : 'to move'}${state.check ? (fa ? ' · کیش' : ' · Check') : ''}`;
  function chessSquares() {
    const board: (string | null)[] = [];
    for (const char of (state?.fen ?? '').split(' ')[0]) {
      if (char === '/') continue;
      if (/\d/.test(char)) board.push(...Array(Number(char)).fill(null)); else board.push(char);
    }
    return board.map((piece, index) => ({ piece, square:`${'abcdefgh'[index % 8]}${8 - Math.floor(index / 8)}`, index })).filter(entry => entry.index < 64);
  }
  const targetMoves = (state?.legal ?? []).filter(move => move.from === selected);
  function chooseChess(square: string) {
    const move = targetMoves.find(move => move.to === square && (!move.promotion || move.promotion === promotion));
    if (move) play({ type:'move', from:selected, to:square, promotion });
    else setSelected((state?.legal ?? []).some(move => move.from === square) ? square : null);
  }
  function choosePoint(point: number) {
    const move = targetMoves.find(move => move.to === point);
    if (move) play({ type:'move', ...move });
    else setSelected((state?.legal ?? []).some(move => move.from === point) ? point : null);
  }
  function pointButton(point: number, top: boolean) {
    const count = state?.points?.[point] ?? 0;
    const target = targetMoves.some(move => move.to === point);
    return <button key={point} className={`bg-point${top ? ' top' : ' bottom'}${point % 2 ? ' alternate' : ''}${selected === point ? ' selected' : ''}${target ? ' target' : ''}`} disabled={!myTurn || pending} onClick={() => choosePoint(point)} aria-label={`Point ${point+1}, ${Math.abs(count)} ${count >= 0 ? 'white' : 'black'} checkers${target ? ', legal destination' : ''}`}>
      <small>{point+1}</small><span className="bg-stack">{Array.from({ length: Math.min(5, Math.abs(count)) }, (_, index) => <span key={index} className={`bg-checker ${count > 0 ? 'white' : 'black'}`}>{index === Math.min(5, Math.abs(count)) - 1 && Math.abs(count) > 5 ? Math.abs(count) : ''}</span>)}</span>
    </button>;
  }
  return <section className="voice-activity-surface" aria-label="Activities">
    <div className="activity-heading"><div><small>ACTIVITIES</small><h2>{title ? (fa ? title.fa : title.en) : (fa ? 'با هم بازی کنید' : 'Play together')}</h2></div><button className="head-btn" onClick={onClose} aria-label="Minimize activities"><Icon name="close" size={20} /></button></div>
    {error ? <p className="activity-error" role="alert">{error}</p> : null}
    {!activity ? <><p className="activity-intro">{fa ? 'یک بازی شروع کن؛ دوستانت در همین تماس می‌توانند به آن بپیوندند.' : 'Start a game. Friends in this call can join or watch.'}</p><div className="activity-catalog">{games.map(game => <button key={game.id} className={`activity-card ${game.id}`} onClick={() => void send('start', { activity:game.id })} disabled={!canStart || pending}><span className="activity-art">{game.icon}</span><strong>{fa ? game.fa : game.en}</strong><span>{fa ? game.descriptionFa : game.description}</span><small>{fa ? '۲ بازیکن · تماشاگر آزاد' : '2 players · spectators welcome'}</small><b>{pending ? '…' : fa ? 'شروع بازی' : 'Launch activity'} <Icon name="arrowLeft" size={15} /></b></button>)}</div>{!canStart ? <p>{fa ? 'برای شروع بازی به مجوز Activities نیاز داری.' : 'Activities permission is required to start a game.'}</p> : null}</> : !state?.id ? <div><p>{fa ? 'این فعالیت متعلق به نسخهٔ قبلی است. میزبان باید آن را پایان دهد.' : 'This is a legacy activity. Ask the host to end it.'}</p>{(activity.startedBy === user.id || isHost) ? <button className="btn danger" onClick={() => void send('end')} disabled={pending}>{fa ? 'پایان فعالیت' : 'End activity'}</button> : null}</div> : <>
      <div className="activity-players">{state.players.map((id, index) => <span key={index} className={state.turn === index && state.status === 'playing' ? 'turn' : ''}><i>{activity.name === 'tic-tac-toe' ? (index ? 'O' : 'X') : (index ? '●' : '○')}</i>{nameFor(id)}{id === user.id ? (fa ? ' (شما)' : ' (you)') : ''}</span>)}</div>
      <div className="activity-status" role="status">{status}{player === -1 ? <small>{fa ? 'در حال تماشا' : 'You are watching'}</small> : null}</div>
      {state.status === 'waiting' && player === -1 ? <button className="btn primary" disabled={pending || !canStart} onClick={() => play({ type:'join' })}>{fa ? 'پیوستن به بازی' : 'Join game'}</button> : null}
      {activity.name === 'chess' ? <div className="chess-game"><div className={`chess-board${player === 1 ? ' black-perspective' : ''}`}>{chessSquares().map(({piece,square,index}) => <button key={square} className={`chess-square ${(Math.floor(index / 8) + index % 8) % 2 ? 'dark' : 'light'}${selected === square ? ' selected' : ''}${targetMoves.some(move => move.to === square) ? ' legal' : ''}`} disabled={!myTurn || pending} onClick={() => chooseChess(square)} aria-label={`${square}${piece ? ` ${piece}` : ''}`}><span className={piece && piece === piece.toUpperCase() ? 'white-piece' : 'black-piece'}>{piece ? pieces[piece] : ''}</span><small>{square}</small></button>)}</div><div className="chess-detail"><label>{fa ? 'ترفیع پیاده' : 'Pawn promotion'}<select value={promotion} onChange={event => setPromotion(event.target.value)}><option value="q">{fa ? 'وزیر' : 'Queen'}</option><option value="r">{fa ? 'رخ' : 'Rook'}</option><option value="b">{fa ? 'فیل' : 'Bishop'}</option><option value="n">{fa ? 'اسب' : 'Knight'}</option></select></label><p>{(state.history ?? []).slice(-12).join(' · ') || (fa ? 'یک مهره و سپس مقصدش را انتخاب کن.' : 'Select a piece, then its destination.')}</p></div></div> : null}
      {activity.name === 'tic-tac-toe' ? <div className="ttt-board">{(state.board ?? []).map((cell,index) => <button key={index} className={`${cell === 0 ? 'cross' : 'circle'}${state.winningLine?.includes(index) ? ' win' : ''}`} disabled={!myTurn || cell !== null || pending} onClick={() => play({ type:'move',cell:index })} aria-label={`Cell ${index+1}, ${cell === null ? 'empty' : cell === 0 ? 'X' : 'O'}`}>{cell === null ? '' : cell === 0 ? '✕' : '○'}</button>)}</div> : null}
      {activity.name === 'backgammon' ? <div className="backgammon-game"><div className="bg-dice">{(state.lastRoll ?? []).map((value,index) => <span key={index} aria-label={`Die ${value}`}>{['','⚀','⚁','⚂','⚃','⚄','⚅'][value]}</span>)}<small>{fa ? 'تاس‌های باقی‌مانده' : 'Remaining dice'}: {(state.dice ?? []).join(' · ') || '—'}</small><button className="btn primary" disabled={!myTurn || pending || Boolean(state.dice?.length)} onClick={() => play({ type:'roll' })}>{fa ? 'تاس بریز' : 'Roll dice'}</button></div><div className="bg-board">{Array.from({length:12},(_,index) => pointButton(index+12,true))}{Array.from({length:12},(_,index) => pointButton(11-index,false))}</div><div className="bg-trays"><button disabled={!myTurn || pending || !(state.legal ?? []).some(move => move.from === -1)} className={selected === -1 ? 'selected' : ''} onClick={() => setSelected(-1)}>{fa ? 'مهره‌های زده‌شده' : 'Bar'} ○ {state.bar?.[0]} / ● {state.bar?.[1]}</button><button disabled={!myTurn || pending || !targetMoves.some(move => move.to === 24)} onClick={() => choosePoint(24)}>{fa ? 'خروج مهره' : 'Bear off'} ○ {state.off?.[0]} / ● {state.off?.[1]}</button></div>{myTurn && targetMoves.length ? <div className="bg-legal-moves">{targetMoves.map((move,index) => <button key={index} disabled={pending} onClick={() => play({type:'move',...move})}>{move.to === 24 ? (fa ? 'خروج' : 'Off') : `${fa ? 'خانه' : 'Point'} ${Number(move.to)+1}`} · {fa ? 'تاس' : 'die'} {move.die}</button>)}</div> : <p className="bg-hint">{fa ? 'سفید به خانهٔ ۱ و سیاه به خانهٔ ۲۴ حرکت می‌کند. ابتدا مهره، سپس مقصد را انتخاب کن.' : 'White moves toward point 1; black toward point 24. Select a checker, then a destination.'}</p>}</div> : null}
      <div className="activity-footer">{state.status === 'finished' && player !== -1 ? <button className="btn primary" disabled={pending} onClick={() => play({type:'reset'})}>{fa ? 'بازی دوباره' : 'Rematch'}</button> : null}{state.status === 'playing' && player !== -1 ? <button className="btn" disabled={pending} onClick={() => { if (window.confirm(fa ? 'از این بازی تسلیم می‌شوی؟' : 'Resign this game?')) play({type:'resign'}); }}>{fa ? 'تسلیم' : 'Resign'}</button> : null}{(activity.startedBy === user.id || isHost) ? <button className="btn danger" disabled={pending} onClick={() => void send('end')}>{fa ? 'پایان فعالیت' : 'End activity'}</button> : null}</div>
    </>}
  </section>;
}
