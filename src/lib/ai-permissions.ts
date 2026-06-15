/**
 * Persistence for the AI auto-approval flags.
 *
 * The backend `AutoApprovals` state is in-memory and rebuilt fresh on every
 * launch, so the "Remember AI permissions across restarts" setting needs a
 * client-side mirror: when the setting is on we stash the flags in the
 * encrypted app-state store and push them back into the backend on startup.
 * When it's off we keep nothing.
 */
import { getAppState, setAppState, deleteAppState } from './app-state-store';
import { loadSettings } from './settings-store';
import { ai, type AutoApprovalFlags } from './ai';

const KEY = 'tablerelay:ai-approvals:v1';

/** Save the current flags — but only when the user opted into persistence.
 *  A no-op (and a best-effort clear) otherwise, so turning the setting off and
 *  toggling a permission can't leave a stale grant on disk. */
export async function persistAutoApprovals(flags: AutoApprovalFlags): Promise<void> {
  if (!loadSettings().persistAiApprovals) return;
  try {
    await setAppState(KEY, flags);
  } catch {
    /* non-fatal — persistence is best-effort */
  }
}

/** Drop any saved flags (called when the user turns persistence off). */
export async function clearPersistedAutoApprovals(): Promise<void> {
  try {
    await deleteAppState(KEY);
  } catch {
    /* non-fatal */
  }
}

/** On startup: if persistence is on and we have saved flags, push them into the
 *  backend so the remembered grants take effect before the first chat turn. */
export async function hydrateAutoApprovals(): Promise<void> {
  if (!loadSettings().persistAiApprovals) return;
  let saved: AutoApprovalFlags | null = null;
  try {
    saved = await getAppState<AutoApprovalFlags>(KEY);
  } catch {
    return;
  }
  if (!saved) return;
  try {
    await ai.setAutoApprovals(saved);
  } catch {
    /* backend not ready / no AI layer — flags will be re-applied next time the
       user opens the permissions panel, which also reads from here. */
  }
}
