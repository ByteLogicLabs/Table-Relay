import type { AiProviderKind } from './ai';
import { getAppState, setAppState } from './app-state-store';

export interface CredentialProfile {
  id: string;
  name: string;
  kind: AiProviderKind;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  createdAt: number;
}

const LIST_KEY   = 'tablerelay:ai-credentials:v1';
const ACTIVE_KEY = 'tablerelay:ai-active-credential:v1';
const OLD_LIST_KEY = 'dbtable:ai-credentials:v1';
const OLD_ACTIVE_KEY = 'dbtable:ai-active-credential:v1';

let credentials: CredentialProfile[] = [];
let activeCredentialId: string | null = null;
let hydrated = false;

function loadLegacyCredentials(): CredentialProfile[] {
  try {
    const raw = localStorage.getItem(LIST_KEY) ?? localStorage.getItem(OLD_LIST_KEY);
    if (raw) return JSON.parse(raw) as CredentialProfile[];
  } catch { /* noop */ }
  return [];
}

function loadLegacyActiveCredentialId(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY) ?? localStorage.getItem(OLD_ACTIVE_KEY); } catch { return null; }
}

export async function hydrateCredentials(): Promise<void> {
  if (hydrated) return;
  const [storedCredentials, storedActiveId] = await Promise.all([
    getAppState<CredentialProfile[]>(LIST_KEY).catch(() => null),
    getAppState<string | null>(ACTIVE_KEY).catch(() => null),
  ]);
  credentials = Array.isArray(storedCredentials) ? storedCredentials : loadLegacyCredentials();
  activeCredentialId = storedActiveId ?? loadLegacyActiveCredentialId();
  if (!storedCredentials && credentials.length > 0) {
    await setAppState(LIST_KEY, credentials);
  }
  if (storedActiveId === null && activeCredentialId) {
    await setAppState(ACTIVE_KEY, activeCredentialId);
  }
  try {
    localStorage.removeItem(LIST_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(OLD_LIST_KEY);
    localStorage.removeItem(OLD_ACTIVE_KEY);
  } catch { /* noop */ }
  hydrated = true;
  window.dispatchEvent(new CustomEvent('tablerelay:credentials-changed'));
}

export function loadCredentials(): CredentialProfile[] {
  return credentials;
}

function persist(list: CredentialProfile[]): void {
  credentials = list;
  void setAppState(LIST_KEY, credentials);
  window.dispatchEvent(new CustomEvent('tablerelay:credentials-changed'));
}

export function saveCredential(
  data: Omit<CredentialProfile, 'id' | 'createdAt'> & { id?: string },
): CredentialProfile {
  const list = loadCredentials();
  const idx  = data.id ? list.findIndex(c => c.id === data.id) : -1;
  const profile: CredentialProfile = {
    ...data,
    id:        data.id ?? crypto.randomUUID(),
    createdAt: idx >= 0 ? list[idx].createdAt : Date.now(),
  };
  if (idx >= 0) list[idx] = profile;
  else          list.push(profile);
  persist(list);
  return profile;
}

export function deleteCredential(id: string): void {
  persist(loadCredentials().filter(c => c.id !== id));
}

export function getActiveCredentialId(): string | null {
  return activeCredentialId;
}

export function setActiveCredentialId(id: string | null): void {
  activeCredentialId = id;
  void setAppState(ACTIVE_KEY, id);
  window.dispatchEvent(new CustomEvent('tablerelay:credentials-changed'));
}
