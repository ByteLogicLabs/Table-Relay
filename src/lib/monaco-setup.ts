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
