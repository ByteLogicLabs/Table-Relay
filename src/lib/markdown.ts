/**
 * Markdown rendering for AI assistant bubbles.
 *
 * Pipeline: `marked` → `DOMPurify.sanitize`. marked v18 gives us GFM tables
 * and fenced code blocks out of the box; DOMPurify strips any HTML the model
 * tries to inject (script tags, event handlers, data URIs, etc.). The output
 * lands in a `dangerouslySetInnerHTML` prop — hence the sanitize step is
 * non-negotiable.
 *
 * Styling is done via Tailwind utility classes applied on the wrapping
 * element (see `markdownClass` below). We don't pull in @tailwindcss/typography
 * because the prose plugin defaults don't match our theme tokens — hand-rolled
 * rules are shorter than overriding prose anyway.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { highlight, tokenClass, type TokenKind } from './highlight';

// GFM tables + auto-linking + proper paragraph breaks on `\n`. Not async —
// marked.parse returns string synchronously unless `async: true`.
marked.setOptions({
  gfm: true,
  breaks: true,
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c] ?? c);
}

// Custom code-block renderer: SQL / Mongo / Redis blocks get syntax highlighted
// via lib/highlight using theme-aware CSS variables. Other languages render
// as plain monospace blocks.
const HIGHLIGHTABLE_LANGS = new Set(['sql', 'mongo', 'redis', 'mysql', 'postgresql', 'postgres', 'sqlite']);
marked.use({
  renderer: {
    code({ text, lang }) {
      const normalised = (lang ?? '').toLowerCase().trim();
      // Encode the raw text into a data attribute so the React side can
      // copy it without re-extracting from the (highlighted, span-wrapped) DOM.
      const dataText = escapeHtml(text);
      const copyBtn = `<button type="button" data-md-copy="${dataText}" class="md-copy-btn" aria-label="Copy code">Copy</button>`;
      if (HIGHLIGHTABLE_LANGS.has(normalised)) {
        const dialect = normalised === 'mongo' ? 'mongo'
                      : normalised === 'redis' ? 'redis'
                      : 'sql';
        const tokens = highlight(text, dialect);
        const inner = tokens
          .map(t => `<span class="${tokenClass[t.kind as TokenKind]}">${escapeHtml(t.text)}</span>`)
          .join('');
        return `<div class="md-code-wrap">${copyBtn}<pre><code class="language-${normalised}">${inner}</code></pre></div>\n`;
      }
      return `<div class="md-code-wrap">${copyBtn}<pre><code${normalised ? ` class="language-${normalised}"` : ''}>${escapeHtml(text)}</code></pre></div>\n`;
    },
  },
});

export function renderMarkdown(src: string): string {
  // marked.parse can return `string | Promise<string>` depending on options;
  // our config above keeps it sync. Coerce defensively.
  const html = wrapTables(marked.parse(src) as string);
  // Allow the basic tags we expect to see, including `table`/`thead`/`tbody`/`tr`/`td`/`th`
  // (DOMPurify's default profile already permits these). Block anything with
  // scripting, iframes, forms — the default deny-list covers that.
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'b', 'blockquote', 'br', 'button', 'code', 'del', 'em', 'h1', 'h2', 'h3',
      'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'div',
      's', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
    ],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'data-md-copy', 'type', 'aria-label'],
  });
}

function wrapTables(html: string): string {
  if (!html.includes('<table')) return html;
  return html.replaceAll('<table', '<div class="md-table-scroll"><table')
    .replaceAll('</table>', '</table></div>');
}

/**
 * Tailwind classes applied to the `<div>` wrapping the rendered HTML. Keeps
 * the bubble looking native to the app's theme tokens: no blue/gray hardcoded
 * colors, everything routes through `text-foreground` / `bg-muted` / etc.
 *
 * Selectors are scoped via `[&_tag]` child selectors (Tailwind 4 arbitrary
 * variants) so the classes only hit the markdown-rendered children, not the
 * wrapper itself.
 */
export const markdownClass =
  'text-sm min-w-0 max-w-full overflow-hidden ' +
  '[&>p]:my-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 ' +
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 ' +
  '[&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-background/60 [&_code]:border [&_code]:border-border [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:break-words ' +
  '[&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:bg-background/80 [&_pre]:border [&_pre]:border-border [&_pre]:rounded [&_pre]:p-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre>code]:border-0 [&_pre>code]:bg-transparent [&_pre>code]:p-0 [&_pre]:select-text ' +
  // Code wrap + copy button overlay
  '[&_.md-code-wrap]:relative [&_.md-code-wrap]:group/code ' +
  '[&_.md-copy-btn]:absolute [&_.md-copy-btn]:top-2.5 [&_.md-copy-btn]:right-2.5 [&_.md-copy-btn]:text-[10px] [&_.md-copy-btn]:text-muted-foreground [&_.md-copy-btn]:bg-background/80 [&_.md-copy-btn]:border [&_.md-copy-btn]:border-border [&_.md-copy-btn]:rounded [&_.md-copy-btn]:px-1.5 [&_.md-copy-btn]:py-0.5 [&_.md-copy-btn]:opacity-0 [&_.md-code-wrap:hover_.md-copy-btn]:opacity-100 [&_.md-copy-btn:hover]:text-foreground [&_.md-copy-btn:hover]:bg-background [&_.md-copy-btn]:cursor-pointer [&_.md-copy-btn]:transition-opacity ' +
  '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1 ' +
  '[&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 ' +
  '[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 ' +
  '[&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-1.5 [&_h3]:mb-1 ' +
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:italic [&_blockquote]:text-muted-foreground ' +
  // Tables — scrollable on overflow so wide columns don't stretch the bubble.
  '[&_.md-table-scroll]:my-2 [&_.md-table-scroll]:max-w-full [&_.md-table-scroll]:overflow-x-auto [&_.md-table-scroll]:overflow-y-hidden ' +
  '[&_table]:w-max [&_table]:min-w-full [&_table]:max-w-none [&_table]:border-collapse [&_table]:text-[12px] ' +
  '[&_th]:bg-muted [&_th]:text-foreground [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:font-medium [&_th]:text-left [&_th]:whitespace-nowrap ' +
  '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_td]:max-w-[22rem] [&_td]:break-words';
