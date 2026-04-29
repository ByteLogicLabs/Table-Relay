// Public contract for adapter-supplied frontend modules.
//
// Each `src-adapters/<key>/frontend/index.ts` should `export default`
// an `AdapterFrontend` object. The omni loader (`./loader.ts`) picks
// these up at build time via `import.meta.glob` — no central registry
// to keep in sync.
//
// Today the only contribution point is `registerQueryCompletion`;
// future per-adapter UI slots (custom toolbar buttons, schema editor
// tabs, etc) plug in as additional optional fields here.

import type { IDisposable } from 'monaco-editor';
import type { QueryCompletionHookContext } from '../query-completion/hooks';

export interface AdapterFrontend {
  /**
   * Stable manifest key — must match the adapter's `manifest.toml`
   * `[adapter] key`. The loader uses this to map "the user picked the
   * postgres connection" -> "load the postgres frontend module."
   */
  key: string;

  /**
   * Optional Monaco autocomplete contribution. Mirrors the old
   * per-adapter `register*QueryCompletion` shape; called once per
   * editor mount and returns a disposer.
   */
  registerQueryCompletion?: (ctx: QueryCompletionHookContext) => IDisposable | null;

  /**
   * Optional fallback language ids this adapter's completion handles
   * even when the active connection is not this adapter (e.g. Mongo's
   * shell completion runs whenever the editor is in `mongo` mode).
   * Empty/undefined means adapter-key match only.
   */
  completionLanguages?: readonly string[];
}
