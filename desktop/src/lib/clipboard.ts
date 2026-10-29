import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { toast } from 'sonner';

/**
 * Copy text to the clipboard reliably inside the Tauri webview.
 *
 * `navigator.clipboard.writeText` is unreliable here: depending on focus and
 * secure-context state the webview can reject it silently — which is why copy
 * buttons showed a "Copied" toast while the clipboard stayed empty. We use the
 * Tauri clipboard plugin (native, always available) and fall back to the
 * browser API only if the plugin call throws.
 *
 * Returns true on success. When `successMessage` is given, a success toast is
 * shown ONLY on real success; failures always surface an error toast so a
 * broken copy is never silently reported as "Copied".
 */
export async function copyText(
  text: string,
  successMessage?: string,
): Promise<boolean> {
  try {
    await writeText(text);
    if (successMessage) toast.success(successMessage);
    return true;
  } catch {
    // Fall back to the browser API (e.g. non-Tauri dev preview in a browser).
    try {
      await navigator.clipboard.writeText(text);
      if (successMessage) toast.success(successMessage);
      return true;
    } catch (err) {
      toast.error(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
