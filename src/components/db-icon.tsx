import { Server } from 'lucide-react';
import type { Driver } from '../types';

// Picked up automatically for every adapter that ships
// `src-adapters/<key>/assets/logo.svg` — no central edit needed when a
// new adapter is dropped in.
const LOGO_MODULES = import.meta.glob<string>(
  '../../src-adapters/*/assets/logo.svg',
  { eager: true, query: '?url', import: 'default' },
);
const ICON_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(LOGO_MODULES).map(([path, url]) => {
    // path looks like `../../src-adapters/<key>/assets/logo.svg`
    const key = path.split('/').slice(-3, -2)[0];
    return [key, url];
  }),
);

function normalizeDriver(driver?: string | null): 'mysql' | 'postgres' | 'sqlite' | 'redis' | 'mongo' | 'unknown' {
  const d = (driver ?? '').trim().toLowerCase();
  if (d === 'mysql' || d === 'mariadb') return 'mysql';
  if (d === 'postgresql' || d === 'postgres') return 'postgres';
  if (d === 'sqlite') return 'sqlite';
  if (d === 'redis') return 'redis';
  if (d === 'mongodb' || d === 'mongo') return 'mongo';
  return 'unknown';
}

export default function DbIcon({
  driver,
  className = 'w-4 h-4',
}: {
  driver?: Driver | string | null;
  className?: string;
}) {
  const kind = normalizeDriver(driver);
  const src = ICON_URLS[kind];
  if (src) {
    return <img src={src} alt={`${kind} icon`} className={className} />;
  }
  return <Server className={className} />;
}
