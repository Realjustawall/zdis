import type { SVGProps } from 'react';

export type IconName =
  | 'add'
  | 'arrowLeft'
  | 'announcement'
  | 'bell'
  | 'bookmark'
  | 'calendar'
  | 'camera'
  | 'chart'
  | 'check'
  | 'close'
  | 'code'
  | 'compass'
  | 'directory'
  | 'discover'
  | 'hash'
  | 'link'
  | 'lock'
  | 'logout'
  | 'menu'
  | 'message'
  | 'microphone'
  | 'pin'
  | 'poll'
  | 'reply'
  | 'search'
  | 'send'
  | 'settings'
  | 'shield'
  | 'smile'
  | 'speaker'
  | 'thread'
  | 'edit'
  | 'trash'
  | 'flag'
  | 'forum'
  | 'headphones'
  | 'home'
  | 'sun'
  | 'moon'
  | 'palette'
  | 'system'
  | 'screen'
  | 'tag'
  | 'archive'
  | 'video'
  | 'volumeOff'
  | 'users';

const paths: Record<IconName, string> = {
  add: 'M12 5v14M5 12h14',
  arrowLeft: 'M19 12H5m7-7-7 7 7 7',
  announcement: 'M4 13V9l12-5v14L4 13Zm0 0 2.5 6h3L8 13m8-4a3 3 0 0 1 0 4',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4',
  bookmark: 'M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8V21l-6-4-6 4V4.8Z',
  calendar: 'M6 3v3m12-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z',
  camera: 'M14.5 5 16 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-2h5ZM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  chart: 'M4 19V9m6 10V5m6 14v-7m4 7H2',
  check: 'm5 12 4 4L19 6',
  close: 'M6 6l12 12M18 6 6 18',
  code: 'm8 9-4 3 4 3m8-6 4 3-4 3m-3-9-2 12',
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm3.8-13.8-2.1 5.5-5.5 2.1 2.1-5.5 5.5-2.1Z',
  directory: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87m0-8.26a4 4 0 0 1 0 7.75',
  discover: 'M12 3a9 9 0 1 0 9 9m-9-9v3m0 12v3M3 12h3m12 0h3m-5-4-2.2 5.8L8 16l2.2-5.8L16 8Z',
  hash: 'M10 3 8 21m8-18-2 18M4 9h16M3 15h16',
  link: 'M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2m2.7 5.3a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2',
  lock: 'M6 10h12v11H6V10Zm3 0V7a3 3 0 0 1 6 0v3',
  logout: 'M10 17l5-5-5-5m5 5H3m10-9h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  message: 'M21 15a4 4 0 0 1-4 4H8l-5 3 1.7-5A7 7 0 0 1 3 12V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7Z',
  microphone: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0m-7 7v4m-4 0h8',
  pin: 'm14 4 6 6-3 1-4 4 1 3-2 2-3-5-5-3 2-2 3 1 4-4 1-3ZM4 20l5-5',
  poll: 'M5 20V10m7 10V4m7 16v-7',
  reply: 'm9 17-5-5 5-5m-5 5h9a7 7 0 0 1 7 7',
  search: 'm21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  send: 'm22 2-7 20-4-9-9-4 20-7Zm-11 11 5-5',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5c0-.5-.1-1-.2-1.5l2-1.6-2-3.5-2.5 1c-.8-.6-1.7-1.1-2.7-1.5L13.6 2h-4l-.4 2.9c-1 .4-1.9.9-2.7 1.5l-2.5-1-2 3.5 2 1.6a7.7 7.7 0 0 0 0 3L2 15.1l2 3.5 2.5-1c.8.6 1.7 1.1 2.7 1.5l.4 2.9h4l.4-2.9c1-.4 1.9-.9 2.7-1.5l2.5 1 2-3.5-2-1.6c.1-.5.2-1 .2-1.5Z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-5',
  smile: 'M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  speaker: 'M11 5 6 9H2v6h4l5 4V5Zm4 4a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12',
  thread: 'M5 5h14M5 12h10M5 19h6m7-4v6m-3-3h6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z',
  trash: 'M4 7h16m-10 4v6m4-6v6M9 3h6l1 4H8l1-4Zm-3 4 1 14h10l1-14',
  flag: 'M5 22V4m0 1h10l-1 4 3 3H5',
  forum: 'M4 4h16v12H8l-4 4V4Zm4 4h8m-8 4h5',
  headphones: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v7H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 1-2Zm16 0h-3v7h2a2 2 0 0 0 2-2v-3a2 2 0 0 0-1-2Z',
  home: 'm3 11 9-8 9 8v10h-6v-6H9v6H3V11Z',
  sun: 'M12 4V2m0 20v-2M4 12H2m20 0h-2M6.3 6.3 4.9 4.9m14.2 14.2-1.4-1.4m0-11.4 1.4-1.4M4.9 19.1l1.4-1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
  moon: 'M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8Z',
  palette: 'M12 3a9 9 0 0 0 0 18h1.2a1.8 1.8 0 0 0 0-3.6h-.8a1.7 1.7 0 0 1 0-3.4H16a5 5 0 0 0 0-10H12Zm-4 6h.01M12 7h.01M16 9h.01M8 13h.01',
  system: 'M4 4h16v12H4V4Zm4 16h8m-4-4v4',
  screen: 'M3 4h18v13H3V4Zm5 17h8m-4-4v4',
  tag: 'M20 13 13 20l-9-9V4h7l9 9ZM8.5 8.5h.01',
  archive: 'M4 7h16v14H4V7Zm-1-4h18v4H3V3Zm6 8h6',
  video: 'M3 6h13v12H3V6Zm13 4 5-3v10l-5-3v-4Z',
  volumeOff: 'M11 5 6 9H2v6h4l5 4V5Zm5 5 5 5m0-5-5 5',
  users: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2m7.5-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87m-2-11.7a4 4 0 0 1 0 7.75',
};

export function Icon({
  name,
  size = 18,
  className,
  ...props
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      className={`ui-icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
