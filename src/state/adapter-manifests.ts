//! App-wide cache for adapter manifests.
//!
//! The manifest list is static for the life of the process (the factory
//! registry is built once at startup and never mutated), so one fetch is
//! plenty. We hold the list in module scope and hand it out synchronously
//! on the second and later reads.

import { useEffect, useState } from 'react';
import { db, type AdapterManifest } from '../lib/db';

let cache: AdapterManifest[] | null = null;
let inflight: Promise<AdapterManifest[]> | null = null;
const subscribers = new Set<(list: AdapterManifest[] | null) => void>();

function notifyAll(list: AdapterManifest[] | null) {
  for (const fn of subscribers) fn(list);
}

async function load(): Promise<AdapterManifest[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = db.listAdapters()
      .then(list => {
        cache = list;
        inflight = null;
        notifyAll(list);
        return list;
      })
      .catch(err => {
        inflight = null;
        throw err;
      });
  }
  return inflight;
}

/** React hook — returns `null` while the first fetch is in flight. */
export function useAdapterManifests(): AdapterManifest[] | null {
  const [value, setValue] = useState<AdapterManifest[] | null>(cache);
  useEffect(() => {
    subscribers.add(setValue);
    if (!cache && !inflight) {
      void load().catch(() => {
        // Silent failure — components render with the default/fallback
        // (e.g. free-text type input). The empty-manifest case already
        // surfaces a visible toast wherever connections are created.
      });
    }
    return () => {
      subscribers.delete(setValue);
    };
  }, []);
  return value;
}

/** Resolve the manifest for a stored `driver` string (`"MySQL"`, `"SQLite"`).
 *  Mirrors `FactoryRegistry::resolve` on the backend: prefer the adapter
 *  key, fall back to display_name / first token — all case-insensitive.
 *  Returns `null` when no adapter matches. */
export function resolveManifest(
  manifests: AdapterManifest[] | null,
  driver: string | undefined | null,
): AdapterManifest | null {
  if (!manifests || !driver) return null;
  const canonical = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const rawNeedle = driver.trim().toLowerCase();
  const needle = canonical(driver);
  if (!needle) return null;
  const aliases: Record<string, string> = {
    mysql: 'mysql',
    mariadb: 'mysql',
    sqlite: 'sqlite',
    postgres: 'postgres',
    postgresql: 'postgres',
    redis: 'redis',
    mongo: 'mongo',
    mongodb: 'mongo',
  };
  const aliasedNeedle = aliases[needle] ?? needle;
  for (const m of manifests) {
    const key = canonical(m.adapter.key);
    const display = canonical(m.adapter.displayName);
    const firstToken = canonical(m.adapter.displayName.split(/[\s/]+/).find(Boolean) ?? '');
    if (key === aliasedNeedle || display === aliasedNeedle || firstToken === aliasedNeedle) return m;
    // Keep one raw comparison for exact historic labels with punctuation.
    if (m.adapter.displayName.toLowerCase() === rawNeedle) return m;
  }
  return null;
}
