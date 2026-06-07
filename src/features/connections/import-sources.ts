import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { type ConnectionProfileRecord } from '../../lib/connections-store';
import { type Driver } from '../../types';

/**
 * Importers for connection definitions exported by other DB clients.
 *
 * Each importer is best-effort: it pulls connection geometry (name, driver,
 * host, port, user, database) out of the foreign format and leaves the password
 * blank when the source stores it encrypted with a tool-specific cipher we
 * can't (and shouldn't) reverse. The user re-enters the password on first
 * connect — exactly what every other client does on cross-tool import.
 */

export type ImportSourceId = 'tablerelay' | 'tableplus' | 'dbeaver' | 'navicat' | 'heidisql';

/**
 * A parsed connection plus transient metadata the `enrich` step needs to fetch
 * its (encrypted) secret. `_secretHex`/`_connId` are stripped before saving.
 */
export interface ParsedConnection extends ConnectionProfileRecord {
  /** Navicat: the encrypted password hex, decrypted in the backend by `enrich`. */
  _secretHex?: string;
  /** DBeaver: the connection id, used to join against credentials-config.json. */
  _connId?: string;
}

export interface ImportSource {
  id: ImportSourceId;
  label: string;
  /** Short hint about what file to point at. */
  hint: string;
  /** File-picker filters. */
  extensions: string[];
  /** Parse raw file text into connection records. Throws on unrecoverable input. */
  parse?: (text: string) => ParsedConnection[];
  /**
   * Optional second pass that fills in secrets needing the Rust backend
   * (Navicat password decryption, DBeaver's separate credentials file). It may
   * prompt for an extra file. Returns the records with passwords merged in.
   */
  enrich?: (records: ParsedConnection[]) => Promise<ParsedConnection[]>;
  /**
   * TablePlus exports are encrypted and decrypted by the Rust backend with a
   * user-supplied password, so they don't fit the plain-text `parse` flow. The
   * dialog routes this source through its own password + backend path instead.
   */
  encrypted?: boolean;
}

// ── Driver mapping ───────────────────────────────────────────────────────────

/** Map a foreign provider/driver token to our Driver enum, or null if unknown. */
function mapDriver(raw: string | undefined): Driver | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('maria') || s.includes('mysql')) return 'MySQL';
  if (s.includes('postgres') || s === 'pgsql' || s.includes('pg') || s.includes('redshift')) return 'PostgreSQL';
  if (s.includes('sqlite')) return 'SQLite';
  if (s.includes('mongo')) return 'MongoDB';
  if (s.includes('redis')) return 'Redis';
  return null;
}

function defaultPort(driver: Driver): number {
  switch (driver) {
    case 'MySQL': return 3306;
    case 'PostgreSQL': return 5432;
    case 'MongoDB': return 27017;
    case 'Redis': return 6379;
    case 'SQLite': return 0;
  }
}

/** Build a record, filling sane defaults. Returns null if it lacks a usable host. */
function makeRecord(p: {
  name?: string;
  driver: Driver;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  secretHex?: string;
  connId?: string;
}): ParsedConnection | null {
  const host = (p.host || '').trim() || (p.driver === 'SQLite' ? 'localhost' : '');
  if (!host && p.driver !== 'SQLite') return null;
  return {
    name: (p.name || '').trim() || `${p.driver} ${host}`.trim(),
    driver: p.driver,
    host: host || 'localhost',
    port: p.port && p.port > 0 ? p.port : defaultPort(p.driver),
    user: p.user?.trim() || undefined,
    password: p.password || undefined,
    database: p.database?.trim() || undefined,
    sshEnabled: false,
    isFavorite: false,
    _secretHex: p.secretHex || undefined,
    _connId: p.connId || undefined,
  } as ParsedConnection;
}

// ── DBeaver (data-sources.json) ──────────────────────────────────────────────

function parseDBeaver(text: string): ParsedConnection[] {
  const json = JSON.parse(text);
  const sources = json?.connections;
  if (!sources || typeof sources !== 'object') {
    throw new Error('Not a DBeaver data-sources.json (no "connections" object).');
  }
  const out: ParsedConnection[] = [];
  for (const [connId, raw] of Object.entries(sources)) {
    const conn = raw as Record<string, unknown>;
    if (!conn || typeof conn !== 'object') continue;
    // `provider` is the DB family (postgresql, mysql, mariaDB…); `driver` is the
    // specific JDBC driver (postgres-jdbc, mysql8…). Either maps fine.
    const driver = mapDriver((conn.provider as string) ?? (conn.driver as string));
    if (!driver) continue;
    const cfg = (conn.configuration ?? {}) as Record<string, unknown>;
    const url = typeof cfg.url === 'string' ? cfg.url : '';
    const rec = makeRecord({
      name: (conn.name as string) ?? (conn['folder'] as string),
      driver,
      host: (cfg.host as string) ?? hostFromJdbc(url),
      // DBeaver stores port as a STRING in configuration.
      port: Number(cfg.port) || portFromJdbc(url),
      // `user` may sit in configuration, but with saved credentials DBeaver
      // moves it into credentials-config.json — `enrich` joins it back by id.
      user: (cfg.user as string) ?? (cfg['user-name'] as string),
      database: (cfg.database as string) ?? (cfg['database-name'] as string),
      connId,
    });
    if (rec) out.push(rec);
  }
  if (out.length === 0) throw new Error('No supported connections found in this DBeaver file.');
  return out;
}

/**
 * Ask for the matching credentials-config.json and merge in user/password.
 * Optional: if the user cancels or the file is master-password protected, the
 * records pass through unchanged (geometry only).
 */
async function enrichDBeaver(records: ParsedConnection[]): Promise<ParsedConnection[]> {
  const picked = await openDialog({
    multiple: false,
    title: 'Select DBeaver credentials-config.json (optional — cancel to skip passwords)',
    filters: [
      { name: 'DBeaver credentials', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!picked || Array.isArray(picked)) return records;
  let creds: Record<string, { user?: string; password?: string }>;
  try {
    creds = await invoke('dbeaver_decrypt_credentials', { path: picked });
  } catch {
    return records; // couldn't decrypt (master password) — keep geometry only
  }
  return records.map((r) => {
    const c = r._connId ? creds[r._connId] : undefined;
    if (!c) return r;
    return { ...r, user: r.user || c.user || undefined, password: c.password || r.password };
  });
}

function hostFromJdbc(url: string): string | undefined {
  const m = url.match(/\/\/([^:/]+)/);
  return m?.[1];
}
function portFromJdbc(url: string): number | undefined {
  const m = url.match(/\/\/[^:/]+:(\d+)/);
  return m ? Number(m[1]) : undefined;
}

// ── Navicat (.ncx XML) ───────────────────────────────────────────────────────

// Navicat .ncx: <Connections Ver="1.1"><Connection ConnType="MYSQL" .../></Connections>
// All data is in attributes. ConnType values: MYSQL, PGSQL, MARIADB, SQLITE,
// MONGODB, REDIS, ORACLE, MSSQL. SQLite uses DatabaseFileName, no host/port.
function parseNavicat(text: string): ParsedConnection[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not parse this Navicat .ncx file (invalid XML).');
  const nodes = Array.from(doc.querySelectorAll('Connection'));
  if (nodes.length === 0) throw new Error('No <Connection> entries found in this Navicat file.');
  const out: ParsedConnection[] = [];
  for (const n of nodes) {
    const attr = (k: string) => n.getAttribute(k) ?? undefined;
    const driver = mapDriver(attr('ConnType'));
    if (!driver) continue;
    const isSqlite = driver === 'SQLite';
    const rec = makeRecord({
      name: attr('ConnectionName'),
      driver,
      host: isSqlite ? undefined : attr('Host'),
      port: isSqlite ? undefined : Number(attr('Port')) || undefined,
      user: attr('UserName'),
      database: isSqlite ? attr('DatabaseFileName') : attr('Database'),
      // Password is an encrypted hex string — decrypted by `enrich` (backend).
      secretHex: attr('Password'),
    });
    if (rec) out.push(rec);
  }
  if (out.length === 0) throw new Error('No supported connections found in this Navicat file.');
  return out;
}

/** Decrypt Navicat password hex strings via the Rust backend (batch). */
async function enrichNavicat(records: ParsedConnection[]): Promise<ParsedConnection[]> {
  const ciphers = records.map((r) => r._secretHex ?? '');
  if (ciphers.every((c) => !c)) return records;
  let plain: (string | null)[];
  try {
    plain = await invoke('navicat_decrypt_passwords', { ciphers });
  } catch {
    return records; // decryption unavailable — keep geometry only
  }
  return records.map((r, i) => ({ ...r, password: plain[i] || r.password }));
}

// ── HeidiSQL (portable_settings.txt) ─────────────────────────────────────────

// NetType is the ordinal of HeidiSQL's TNetType enum (source/dbstructures.pas):
//  0-2,11,16 = MySQL/MariaDB · 3-7 = MSSQL · 8-9 = PostgreSQL · 10,17 = SQLite
function heidiNetType(n: number): Driver | null {
  if (n === 0 || n === 1 || n === 2 || n === 11 || n === 16) return 'MySQL';
  if (n === 8 || n === 9) return 'PostgreSQL';
  if (n === 10 || n === 17) return 'SQLite';
  return null; // MSSQL / Interbase / Firebird — unsupported here
}

/**
 * Reverse HeidiSQL's password obfuscation (apphelpers.pas `decrypt`). This is
 * NOT real crypto — a reversible per-char shift by a 1-digit "salt". Two
 * formats: ANSI (2-hex groups, mod 255) and Unicode (4-hex groups, mod 65536,
 * marked by a trailing '0'). The last char distinguishes them.
 */
function heidiDecryptPassword(str: string): string {
  if (!str) return '';
  const last = str[str.length - 1];
  if (last === '0') {
    // Unicode: strip the '0' flag; the new last char is the salt; 4-hex groups.
    const body = str.slice(0, -1);
    const salt = parseInt(body[body.length - 1], 10);
    if (Number.isNaN(salt)) return '';
    const hex = body.slice(0, -1);
    let out = '';
    for (let j = 0; j + 4 <= hex.length; j += 4) {
      let nr = parseInt(hex.substr(j, 4), 16) - salt;
      if (nr < 0) nr += 65536;
      out += String.fromCharCode(nr);
    }
    return out;
  }
  const salt = parseInt(last, 10);
  if (Number.isNaN(salt)) return '';
  const hex = str.slice(0, -1);
  let out = '';
  for (let j = 0; j + 2 <= hex.length; j += 2) {
    let nr = parseInt(hex.substr(j, 2), 16) - salt;
    if (nr < 0) nr += 255;
    out += String.fromCharCode(nr);
  }
  return out;
}

function parseHeidiSQL(text: string): ConnectionProfileRecord[] {
  // Lines: `Servers\<session...>\<Key><|||><typeCode><|||><value>` (CRLF-joined).
  // Sessions can be nested in folders, so the session path is everything between
  // `Servers\` and the final `\<Key>`.
  const sessions = new Map<string, Record<string, string>>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('<|||>');
    if (parts.length !== 3) continue;
    const [path, , rawValue] = parts;
    if (!path.startsWith('Servers\\')) continue;
    const rel = path.slice('Servers\\'.length);
    const lastSep = rel.lastIndexOf('\\');
    if (lastSep < 0) continue; // a session/folder key, not a value
    const session = rel.slice(0, lastSep);
    const key = rel.slice(lastSep + 1);
    // Un-escape CR/LF the way HeidiSQL encodes them in string values.
    const value = rawValue.replace(/<\{\{\{>/g, '\r').replace(/<\}\}\}>/g, '\n');
    if (!sessions.has(session)) sessions.set(session, {});
    sessions.get(session)![key] = value;
  }
  if (sessions.size === 0) throw new Error('No HeidiSQL sessions found in this file.');
  const out: ConnectionProfileRecord[] = [];
  for (const [session, kv] of sessions) {
    const driver = heidiNetType(Number(kv['NetType'] ?? '0'));
    if (!driver) continue;
    const rec = makeRecord({
      name: session.split('\\').pop() || session,
      driver,
      host: kv['Host'],
      port: Number(kv['Port']) || undefined,
      user: kv['User'],
      password: heidiDecryptPassword(kv['Password'] || ''),
      database: (kv['Databases'] || '').split(';')[0],
    });
    if (rec) out.push(rec);
  }
  if (out.length === 0) throw new Error('No supported sessions found in this HeidiSQL file.');
  return out;
}

// ── Native Table Relay JSON ──────────────────────────────────────────────────

function parseNative(text: string): ConnectionProfileRecord[] {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed?.connections)
    ? parsed.connections
    : Array.isArray(parsed)
      ? parsed
      : null;
  if (!list) throw new Error('No connections found (expected a "connections" array).');
  return list as ConnectionProfileRecord[];
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const IMPORT_SOURCES: ImportSource[] = [
  {
    id: 'tablerelay',
    label: 'Table Relay',
    hint: 'A .dtab (encrypted) or .json file exported from Table Relay.',
    extensions: ['dtab', 'json'],
    parse: parseNative,
  },
  {
    id: 'tableplus',
    label: 'TablePlus',
    hint: 'A password-protected .tableplusconnection export. Decrypted locally with your export password.',
    extensions: ['tableplusconnection'],
    encrypted: true,
  },
  {
    id: 'dbeaver',
    label: 'DBeaver',
    hint: 'DBeaver’s data-sources.json (in the workspace .dbeaver folder). You can also point at credentials-config.json for passwords.',
    extensions: ['json'],
    parse: parseDBeaver,
    enrich: enrichDBeaver,
  },
  {
    id: 'navicat',
    label: 'Navicat',
    hint: 'A connections .ncx file exported from Navicat — includes saved passwords.',
    extensions: ['ncx', 'xml'],
    parse: parseNavicat,
    enrich: enrichNavicat,
  },
  {
    id: 'heidisql',
    label: 'HeidiSQL',
    hint: 'HeidiSQL’s portable_settings.txt — includes saved passwords.',
    extensions: ['txt'],
    parse: parseHeidiSQL,
  },
];
