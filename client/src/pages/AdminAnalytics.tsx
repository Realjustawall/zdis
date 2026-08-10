import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

interface Point { at: number; messages: number; users: number; audits: number; reports: number }
const SERIES = [
  { key: 'messages', label: 'پیام‌ها', color: '#7c5cff' },
  { key: 'users', label: 'کاربران جدید', color: '#22c55e' },
  { key: 'reports', label: 'گزارش‌ها', color: '#f59e0b' },
] as const;

export function AdminAnalytics() {
  const [points, setPoints] = useState<Point[]>([]);
  useEffect(() => {
    api.get<{ series: Point[] }>('/api/admin/analytics?hours=24')
      .then((data) => setPoints(data.series)).catch(() => undefined);
  }, []);
  const max = useMemo(() => Math.max(1, ...points.flatMap((point) => SERIES.map((s) => point[s.key]))), [points]);
  const paths = useMemo(() => SERIES.map((series) => ({ ...series,
    d: points.map((point, index) => {
      const x = points.length < 2 ? 0 : (index / (points.length - 1)) * 1000;
      const y = 250 - (point[series.key] / max) * 220;
      return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' '),
  })), [points, max]);
  return (
    <section className="settings-group admin-card analytics-card">
      <div className="row between"><div><h3>روند ۲۴ ساعت اخیر</h3><p className="desc">پیام، رشد کاربر و گزارش‌ها به تفکیک ساعت</p></div>
        <div className="chart-legend">{paths.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}</div></div>
      {points.length ? <svg className="admin-chart" viewBox="0 0 1000 270" preserveAspectRatio="none" role="img" aria-label="نمودار فعالیت ۲۴ ساعت اخیر">
        {[30, 85, 140, 195, 250].map((y) => <line key={y} x1="0" x2="1000" y1={y} y2={y} />)}
        {paths.map((item) => <path key={item.key} d={item.d} stroke={item.color} />)}
      </svg> : <div className="chart-loading">در حال دریافت داده‌های تحلیلی…</div>}
    </section>
  );
}
