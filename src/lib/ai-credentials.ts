import type { AiProviderKind } from './ai';

export interface CredentialProfile {
  id: string;
  name: string;
  kind: AiProviderKind;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  createdAt: number;
}

const LIST_KEY   = 'dbtable:ai-credentials:v1';
const ACTIVE_KEY = 'dbtable:ai-active-credential:v1';

export function loadCredentials(): CredentialProfile[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (raw) return JSON.parse(raw) as CredentialProfile[];
  } catch { /* noop */ }
  return [];
}

function persist(list: CredentialProfile[]): void {
  localStorage.setItem(LIST_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent('dbtable:credentials-changed'));
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
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveCredentialId(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else    localStorage.removeItem(ACTIVE_KEY);
  window.dispatchEvent(new CustomEvent('dbtable:credentials-changed'));
}
