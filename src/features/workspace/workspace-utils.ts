import { AppTab } from "../../types";
import { type ChatFocus } from "../../lib/ai";
import { TABS_STORAGE_KEY, OLD_TABS_STORAGE_KEY } from "./workspace-constants";

/**
 * Translate the active AppTab into a focus hint the AI context builder can
 * consume. Returns undefined for tabs that don't give the model anything
 * actionable to point at (e.g. diagram / schema / empty states) — the chat
 * then falls back to plain schema-level context.
 */
export function computeFocusHint(tab: AppTab | undefined): ChatFocus | undefined {
  if (!tab) return undefined;
  switch (tab.type) {
    case "query":
      return tab.query && tab.query.trim().length > 0
        ? { type: "query", sql: tab.query }
        : undefined;
    case "routine":
      if (!tab.routine) return undefined;
      return {
        type: "routine",
        schema: tab.routine.schema,
        name: tab.routine.name,
        kind: tab.routine.kind,
      };
    case "data":
    case "structure":
      if (tab.schema && tab.table) {
        return { type: "table", schema: tab.schema, name: tab.table };
      }
      return undefined;
    case "realtime":
      return {
        type: "realtime",
        pattern: tab.realtimePattern ?? "",
        // Live subscription state isn't persisted on the tab; the
        // adapter-primer in the system prompt carries the syntactical
        // rules the model needs regardless. Keep the slot here for
        // forward-compat with a richer status surface later.
        isRunning: false,
        recentChannels: [],
      };
    default:
      return undefined;
  }
}

export function loadLegacyTabs(): AppTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw =
      window.localStorage.getItem(TABS_STORAGE_KEY) ??
      window.localStorage.getItem(OLD_TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is AppTab =>
        t &&
        typeof t.id === "string" &&
        typeof t.title === "string" &&
        typeof t.type === "string" &&
        typeof t.connectionId === "string",
    );
  } catch {
    return [];
  }
}
