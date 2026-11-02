import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

// Bundle Monaco with the app rather than loading from a CDN. This is required
// for Tauri desktop builds to work offline and to satisfy the default CSP.
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Monaco's own types declare `MonacoEnvironment` globally; just assign it.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// Use the locally bundled monaco rather than the default CDN loader.
loader.config({ monaco });

// Eagerly register the SQL Monarch tokenizer.
//
// Monaco's basic-languages register SQL lazily: the tokenizer chunk
// (`basic-languages/sql/sql.js`) is only fetched via a dynamic `import()` when
// the language is first "encountered". In the Tauri webview that lazy load
// raced/failed inconsistently — the result was partial highlighting (some
// keywords coloured, others like JOIN left as plain identifiers). Importing the
// tokenizer eagerly and registering it ourselves makes SQL highlighting
// deterministic from first paint. We register against `sql` (the language the
// SQL adapters use) so every keyword colours correctly.
import { conf as sqlConf, language as sqlLanguage } from 'monaco-editor/esm/vs/basic-languages/sql/sql.js';

if (!monaco.languages.getLanguages().some(l => l.id === 'sql')) {
  monaco.languages.register({ id: 'sql', extensions: ['.sql'], aliases: ['SQL'] });
}
monaco.languages.setLanguageConfiguration('sql', sqlConf);

// Monaco's SQL grammar puts word-operators (JOIN, AND, OR, IN, LIKE, NOT, IS,
// UNION, INNER, LEFT, …) in the `operators` list, which the tokenizer checks
// BEFORE `keywords` — so they render as `operator` (grey in our themes) instead
// of `keyword` (pink), the cause of "JOIN isn't highlighted like FROM". Users
// expect these to look like keywords, so we move every word-operator (the
// all-letters entries) out of `operators` and into `keywords`. Symbol operators
// (=, +, <, …) stay in `operators` so they keep their distinct colour.
const sqlLang = sqlLanguage as unknown as {
  operators?: string[];
  keywords?: string[];
};
if (Array.isArray(sqlLang.operators) && Array.isArray(sqlLang.keywords)) {
  const wordOps = sqlLang.operators.filter(op => /^[A-Za-z][A-Za-z ]*$/.test(op));
  const symbolOps = sqlLang.operators.filter(op => !/^[A-Za-z][A-Za-z ]*$/.test(op));
  sqlLang.operators = symbolOps;
  // Dedupe — some words already appear in keywords.
  sqlLang.keywords = Array.from(new Set([...sqlLang.keywords, ...wordOps]));
}
monaco.languages.setMonarchTokensProvider('sql', sqlLanguage);

// Query editor Mongo mode: dedicated language id to avoid JavaScript/DOM
// global suggestions leaking into DB command autocomplete.
if (!monaco.languages.getLanguages().some(l => l.id === 'mongo')) {
  monaco.languages.register({ id: 'mongo' });
  monaco.languages.setLanguageConfiguration('mongo', {
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}
monaco.languages.setMonarchTokensProvider('mongo', {
  tokenizer: {
    root: [
      [/\b(db|getCollection|getSiblingDB|find|findOne|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|aggregate|countDocuments|limit|skip|sort|project|watch)\b/, 'keyword'],
      [/\b(true|false|null|undefined)\b/, 'keyword'],
      [/[{}()[\]]/, 'delimiter.bracket'],
      [/[,:.;]/, 'delimiter'],
      [/-?\d+(\.\d+)?/, 'number'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/[a-zA-Z_$][\w$]*/, 'identifier'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
});

if (!monaco.languages.getLanguages().some(l => l.id === 'shell')) {
  monaco.languages.register({ id: 'shell' });
}
monaco.languages.setMonarchTokensProvider('shell', {
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      [/\b(GET|SET|DEL|HGET|HSET|HGETALL|LPUSH|RPUSH|LRANGE|SADD|SMEMBERS|ZADD|ZRANGE|XRANGE|PUBLISH|SUBSCRIBE|PSUBSCRIBE|UNSUBSCRIBE|SCAN|KEYS|TYPE|TTL|EXPIRE|SELECT|INFO|PING)\b/, 'keyword'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/-?\d+(\.\d+)?/, 'number'],
      [/[|&;()]/, 'operator'],
      [/\$[a-zA-Z_]\w*/, 'variable'],
      [/[a-zA-Z_./:-][\w./:-]*/, 'identifier'],
      [/\s+/, 'white'],
    ],
  },
});

// Register themes that follow our CSS variables. We compute concrete colors at
// registration time because Monaco needs hex values, not CSS vars.
function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function hslToHex(hsl: string, fallback: string): string {
  // Accepts "210 40% 12%" or "hsl(210 40% 12%)" — returns "#rrggbb".
  const m = hsl.replace(/hsla?\(|\)/g, '').match(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/);
  if (!m) return fallback;
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function defineAppThemes(): void {
  // One Dark Pro palette — https://github.com/Binaryify/OneDark-Pro
  // Using the "darker" variant of the background so the editor blends into
  // the app's near-black surfaces instead of sitting on a lighter grey panel.
  const ONE_DARK = {
    bg: '#0b0e14',
    fg: '#abb2bf',
    lineNumber: '#3b4252',
    lineNumberActive: '#abb2bf',
    selection: '#3e4451',
    inactiveSelection: '#3e445180',
    currentLine: '#11151c',
    cursor: '#528bff',
    whitespace: '#1f2430',
    indentGuide: '#1f2430',
    indentGuideActive: '#5c6370',
    bracketBg: '#515a6b',
    bracketBorder: '#528bff',
  };

  const darkRules = [
    { token: '', foreground: 'abb2bf', background: '282c34' },
    // keywords
    { token: 'keyword', foreground: 'c678dd', fontStyle: 'bold' },
    { token: 'keyword.sql', foreground: 'c678dd', fontStyle: 'bold' },
    { token: 'keyword.js', foreground: 'c678dd', fontStyle: 'bold' },
    { token: 'predefined', foreground: '56b6c2' },
    // identifiers / variables
    { token: 'identifier', foreground: 'abb2bf' },
    { token: 'variable', foreground: 'e06c75' },
    { token: 'variable.predefined', foreground: 'e5c07b' },
    { token: 'type', foreground: 'e5c07b' },
    { token: 'type.identifier', foreground: 'e5c07b' },
    // strings
    { token: 'string', foreground: '98c379' },
    { token: 'string.sql', foreground: '98c379' },
    { token: 'string.escape', foreground: '56b6c2' },
    // numbers
    { token: 'number', foreground: 'd19a66' },
    // comments
    { token: 'comment', foreground: '7f848e', fontStyle: 'italic' },
    { token: 'comment.sql', foreground: '7f848e', fontStyle: 'italic' },
    // operators / punctuation
    { token: 'operator', foreground: '56b6c2' },
    { token: 'operator.sql', foreground: '56b6c2' },
    { token: 'delimiter', foreground: 'abb2bf' },
    { token: 'delimiter.bracket', foreground: 'abb2bf' },
    { token: 'delimiter.parenthesis', foreground: 'abb2bf' },
    // functions
    { token: 'function', foreground: '61afef' },
    { token: 'support.function', foreground: '61afef' },
    // attributes / constants
    { token: 'constant', foreground: 'd19a66' },
    { token: 'attribute.name', foreground: 'd19a66' },
    { token: 'tag', foreground: 'e06c75' },
    { token: 'regexp', foreground: '98c379' },
    { token: 'annotation', foreground: '56b6c2' },
  ];

  const darkColors: Record<string, string> = {
    'editor.foreground': ONE_DARK.fg,
    'editor.background': ONE_DARK.bg,
    'editorLineNumber.foreground': ONE_DARK.lineNumber,
    'editorLineNumber.activeForeground': ONE_DARK.lineNumberActive,
    'editor.selectionBackground': ONE_DARK.selection,
    'editor.inactiveSelectionBackground': ONE_DARK.inactiveSelection,
    'editor.lineHighlightBackground': ONE_DARK.currentLine,
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': ONE_DARK.cursor,
    'editorWhitespace.foreground': ONE_DARK.whitespace,
    'editorIndentGuide.background': ONE_DARK.indentGuide,
    'editorIndentGuide.activeBackground': ONE_DARK.indentGuideActive,
    'editorBracketMatch.background': ONE_DARK.bracketBg,
    'editorBracketMatch.border': ONE_DARK.bracketBorder,
    'editorWidget.background': '#11151c',
    'editorWidget.border': '#0b0e14',
    'editorSuggestWidget.background': '#11151c',
    'editorSuggestWidget.border': '#0b0e14',
    'editorSuggestWidget.selectedBackground': '#1f2430',
    'editorHoverWidget.background': '#11151c',
    'editorHoverWidget.border': '#0b0e14',
    'scrollbarSlider.background': '#4e566680',
    'scrollbarSlider.hoverBackground': '#5a6375aa',
    'scrollbarSlider.activeBackground': '#747d91aa',
  };

  monaco.editor.defineTheme('app-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: darkRules,
    colors: darkColors,
  });

  // ── Monokai ──────────────────────────────────────────────────
  monaco.editor.defineTheme('app-monokai', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'f8f8f2', background: '272822' },
      { token: 'keyword', foreground: 'f92672', fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: 'f92672', fontStyle: 'bold' },
      { token: 'string', foreground: 'e6db74' },
      { token: 'string.sql', foreground: 'e6db74' },
      { token: 'number', foreground: 'ae81ff' },
      { token: 'comment', foreground: '75715e', fontStyle: 'italic' },
      { token: 'comment.sql', foreground: '75715e', fontStyle: 'italic' },
      { token: 'function', foreground: 'a6e22e' },
      { token: 'type', foreground: '66d9ef' },
      { token: 'type.identifier', foreground: '66d9ef' },
      { token: 'operator', foreground: 'f8f8f2' },
      { token: 'identifier', foreground: 'f8f8f2' },
      { token: 'variable', foreground: 'f92672' },
      { token: 'predefined', foreground: '66d9ef' },
    ],
    colors: {
      'editor.foreground': '#f8f8f2',
      'editor.background': '#272822',
      'editorLineNumber.foreground': '#49483e',
      'editorLineNumber.activeForeground': '#75715e',
      'editor.selectionBackground': '#49483e',
      'editor.lineHighlightBackground': '#3e3d32',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#f8f8f0',
      'editorWidget.background': '#1e1f1c',
      'editorWidget.border': '#49483e',
      'editorSuggestWidget.background': '#1e1f1c',
      'editorSuggestWidget.border': '#49483e',
      'editorSuggestWidget.selectedBackground': '#3e3d32',
      'editorHoverWidget.background': '#1e1f1c',
      'editorHoverWidget.border': '#49483e',
    },
  });

  // ── Dracula ───────────────────────────────────────────────────
  monaco.editor.defineTheme('app-dracula', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'f8f8f2', background: '282a36' },
      { token: 'keyword', foreground: 'ff79c6', fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: 'ff79c6', fontStyle: 'bold' },
      { token: 'string', foreground: 'f1fa8c' },
      { token: 'string.sql', foreground: 'f1fa8c' },
      { token: 'number', foreground: 'bd93f9' },
      { token: 'comment', foreground: '6272a4', fontStyle: 'italic' },
      { token: 'comment.sql', foreground: '6272a4', fontStyle: 'italic' },
      { token: 'function', foreground: '50fa7b' },
      { token: 'type', foreground: '8be9fd' },
      { token: 'type.identifier', foreground: '8be9fd' },
      { token: 'operator', foreground: 'ff79c6' },
      { token: 'identifier', foreground: 'f8f8f2' },
      { token: 'variable', foreground: 'f8f8f2' },
      { token: 'predefined', foreground: '8be9fd' },
    ],
    colors: {
      'editor.foreground': '#f8f8f2',
      'editor.background': '#282a36',
      'editorLineNumber.foreground': '#44475a',
      'editorLineNumber.activeForeground': '#6272a4',
      'editor.selectionBackground': '#44475a',
      'editor.lineHighlightBackground': '#44475a',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#f8f8f2',
      'editorWidget.background': '#1e1f29',
      'editorWidget.border': '#44475a',
      'editorSuggestWidget.background': '#1e1f29',
      'editorSuggestWidget.border': '#44475a',
      'editorSuggestWidget.selectedBackground': '#44475a',
      'editorHoverWidget.background': '#1e1f29',
      'editorHoverWidget.border': '#44475a',
    },
  });

  // ── Nord ──────────────────────────────────────────────────────
  monaco.editor.defineTheme('app-nord', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'd8dee9', background: '2e3440' },
      { token: 'keyword', foreground: '81a1c1', fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: '81a1c1', fontStyle: 'bold' },
      { token: 'string', foreground: 'a3be8c' },
      { token: 'string.sql', foreground: 'a3be8c' },
      { token: 'number', foreground: 'b48ead' },
      { token: 'comment', foreground: '616e88', fontStyle: 'italic' },
      { token: 'comment.sql', foreground: '616e88', fontStyle: 'italic' },
      { token: 'function', foreground: '88c0d0' },
      { token: 'type', foreground: '8fbcbb' },
      { token: 'type.identifier', foreground: '8fbcbb' },
      { token: 'operator', foreground: '81a1c1' },
      { token: 'identifier', foreground: 'd8dee9' },
      { token: 'variable', foreground: 'bf616a' },
      { token: 'predefined', foreground: '8fbcbb' },
    ],
    colors: {
      'editor.foreground': '#d8dee9',
      'editor.background': '#2e3440',
      'editorLineNumber.foreground': '#4c566a',
      'editorLineNumber.activeForeground': '#d8dee9',
      'editor.selectionBackground': '#4c566a',
      'editor.lineHighlightBackground': '#3b4252',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#d8dee9',
      'editorWidget.background': '#272e3b',
      'editorWidget.border': '#4c566a',
      'editorSuggestWidget.background': '#272e3b',
      'editorSuggestWidget.border': '#4c566a',
      'editorSuggestWidget.selectedBackground': '#3b4252',
      'editorHoverWidget.background': '#272e3b',
      'editorHoverWidget.border': '#4c566a',
    },
  });

  // ── Tokyo Night ───────────────────────────────────────────────
  monaco.editor.defineTheme('app-tokyo-night', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'a9b1d6', background: '1a1b26' },
      { token: 'keyword', foreground: '9d7cd8', fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: '9d7cd8', fontStyle: 'bold' },
      { token: 'string', foreground: '9ece6a' },
      { token: 'string.sql', foreground: '9ece6a' },
      { token: 'number', foreground: 'ff9e64' },
      { token: 'comment', foreground: '565f89', fontStyle: 'italic' },
      { token: 'comment.sql', foreground: '565f89', fontStyle: 'italic' },
      { token: 'function', foreground: '7aa2f7' },
      { token: 'type', foreground: '2ac3de' },
      { token: 'type.identifier', foreground: '2ac3de' },
      { token: 'operator', foreground: '89ddff' },
      { token: 'identifier', foreground: 'c0caf5' },
      { token: 'variable', foreground: 'f7768e' },
      { token: 'predefined', foreground: '2ac3de' },
    ],
    colors: {
      'editor.foreground': '#a9b1d6',
      'editor.background': '#1a1b26',
      'editorLineNumber.foreground': '#363b54',
      'editorLineNumber.activeForeground': '#737aa2',
      'editor.selectionBackground': '#283457',
      'editor.lineHighlightBackground': '#1f2335',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#c0caf5',
      'editorWidget.background': '#141622',
      'editorWidget.border': '#292e42',
      'editorSuggestWidget.background': '#141622',
      'editorSuggestWidget.border': '#292e42',
      'editorSuggestWidget.selectedBackground': '#1f2335',
      'editorHoverWidget.background': '#141622',
      'editorHoverWidget.border': '#292e42',
    },
  });

  // ── GitHub Dark ───────────────────────────────────────────────
  monaco.editor.defineTheme('app-github-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'c9d1d9', background: '0d1117' },
      { token: 'keyword', foreground: 'ff7b72', fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: 'ff7b72', fontStyle: 'bold' },
      { token: 'string', foreground: 'a5d6ff' },
      { token: 'string.sql', foreground: 'a5d6ff' },
      { token: 'number', foreground: '79c0ff' },
      { token: 'comment', foreground: '8b949e', fontStyle: 'italic' },
      { token: 'comment.sql', foreground: '8b949e', fontStyle: 'italic' },
      { token: 'function', foreground: 'd2a8ff' },
      { token: 'type', foreground: 'ffa657' },
      { token: 'type.identifier', foreground: 'ffa657' },
      { token: 'operator', foreground: 'ff7b72' },
      { token: 'identifier', foreground: 'c9d1d9' },
      { token: 'variable', foreground: 'ffa657' },
      { token: 'predefined', foreground: '79c0ff' },
    ],
    colors: {
      'editor.foreground': '#c9d1d9',
      'editor.background': '#0d1117',
      'editorLineNumber.foreground': '#30363d',
      'editorLineNumber.activeForeground': '#8b949e',
      'editor.selectionBackground': '#264f78',
      'editor.lineHighlightBackground': '#161b22',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#c9d1d9',
      'editorWidget.background': '#010409',
      'editorWidget.border': '#30363d',
      'editorSuggestWidget.background': '#010409',
      'editorSuggestWidget.border': '#30363d',
      'editorSuggestWidget.selectedBackground': '#161b22',
      'editorHoverWidget.background': '#010409',
      'editorHoverWidget.border': '#30363d',
    },
  });

  // Light fallback — keeps semantics but on a light background.
  const bgLight = hslToHex(readVar('--background', '0 0% 100%'), '#ffffff');
  const fgLight = hslToHex(readVar('--foreground', '222 84% 5%'), '#0f172a');
  const mutedLight = hslToHex(readVar('--muted-foreground', '215 16% 47%'), '#64748b');
  const borderLight = hslToHex(readVar('--border', '214 32% 91%'), '#e2e8f0');

  monaco.editor.defineTheme('app-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'a626a4', fontStyle: 'bold' },
      { token: 'string', foreground: '50a14f' },
      { token: 'number', foreground: '986801' },
      { token: 'comment', foreground: 'a0a1a7', fontStyle: 'italic' },
      { token: 'identifier', foreground: fgLight.replace('#', '') },
      { token: 'operator', foreground: '0184bc' },
      { token: 'type', foreground: 'c18401' },
      { token: 'function', foreground: '4078f2' },
      { token: 'predefined', foreground: '0184bc' },
    ],
    colors: {
      'editor.foreground': fgLight,
      'editor.background': bgLight,
      'editorLineNumber.foreground': mutedLight,
      'editorIndentGuide.background': borderLight,
    },
  });
}

defineAppThemes();

const THEME_MAP: Record<string, string> = {
  'latte':       'app-light',
  'monokai':     'app-monokai',
  'dracula':     'app-dracula',
  'nord':        'app-nord',
  'tokyo-night': 'app-tokyo-night',
  'github-dark': 'app-github-dark',
};

export function getMonacoThemeId(appTheme: string): string {
  return THEME_MAP[appTheme] ?? 'app-dark';
}
