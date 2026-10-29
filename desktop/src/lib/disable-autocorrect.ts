// Globally disable the browser's autocorrect / autocapitalize / spellcheck /
// autofill behaviours for every text input in the app. We're a database
// tool — suggestions like "Ap → App" on a Redis channel name or a column
// identifier are never what the user wants, and the suggestion popover
// visibly clips other UI.
//
// Implemented as a MutationObserver so inputs added later by React or the
// Monaco/portal layers get patched too, without requiring a wrapper
// component around every `<input />`.

const MARK = 'data-no-ac';

function patch(el: Element): void {
  if (!(el instanceof HTMLElement)) return;
  if (el.hasAttribute(MARK)) return;
  const tag = el.tagName;
  const isTextual = tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  if (!isTextual) return;
  // `autocomplete="off"` alone is ignored by some password managers /
  // WebKit autofill; a non-standard value like `new-password` or
  // `one-time-code` is the commonly-working escape hatch. We use
  // `off` first and fall through to the explicit attributes that
  // actually kill correction on iOS/macOS WebViews.
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('autocorrect', 'off');
  el.setAttribute('autocapitalize', 'off');
  el.setAttribute('spellcheck', 'false');
  el.setAttribute(MARK, '');
}

function patchAll(root: ParentNode): void {
  root
    .querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]')
    .forEach(patch);
}

export function installAutocorrectDisabler(): void {
  if (typeof document === 'undefined') return;
  patchAll(document);
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (node instanceof Element) {
          patch(node);
          patchAll(node);
        }
      });
      if (m.type === 'attributes' && m.target instanceof Element) {
        // Re-patch if someone (a library) overwrote our attributes.
        patch(m.target);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['contenteditable'],
  });
}
