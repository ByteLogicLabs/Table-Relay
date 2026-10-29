/** Single source of truth for connection tag colors. Used by the connection
 *  modal (picker) and everywhere tags render (cards, list, sidebar). */
export interface TagColor {
  name: string;
  /** Pill background. */
  bg: string;
  /** Pill text. */
  text: string;
  /** Solid swatch/dot. */
  dot: string;
}

// Stronger, more saturated pills: a richer tinted background (-500/20) that
// reads in both light + dark without a separate dark variant, bold text, and a
// solid dot. Ordered by hue so the auto-assign cycle spreads nicely.
export const TAG_COLORS: TagColor[] = [
  { name: 'Red', bg: 'bg-red-500/20', text: 'text-red-700 dark:text-red-300', dot: 'bg-red-500' },
  { name: 'Rose', bg: 'bg-rose-500/20', text: 'text-rose-700 dark:text-rose-300', dot: 'bg-rose-500' },
  { name: 'Pink', bg: 'bg-pink-500/20', text: 'text-pink-700 dark:text-pink-300', dot: 'bg-pink-500' },
  { name: 'Fuchsia', bg: 'bg-fuchsia-500/20', text: 'text-fuchsia-700 dark:text-fuchsia-300', dot: 'bg-fuchsia-500' },
  { name: 'Purple', bg: 'bg-purple-500/20', text: 'text-purple-700 dark:text-purple-300', dot: 'bg-purple-500' },
  { name: 'Violet', bg: 'bg-violet-500/20', text: 'text-violet-700 dark:text-violet-300', dot: 'bg-violet-500' },
  { name: 'Indigo', bg: 'bg-indigo-500/20', text: 'text-indigo-700 dark:text-indigo-300', dot: 'bg-indigo-500' },
  { name: 'Blue', bg: 'bg-blue-500/20', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
  { name: 'Sky', bg: 'bg-sky-500/20', text: 'text-sky-700 dark:text-sky-300', dot: 'bg-sky-500' },
  { name: 'Cyan', bg: 'bg-cyan-500/20', text: 'text-cyan-700 dark:text-cyan-300', dot: 'bg-cyan-500' },
  { name: 'Teal', bg: 'bg-teal-500/20', text: 'text-teal-700 dark:text-teal-300', dot: 'bg-teal-500' },
  { name: 'Emerald', bg: 'bg-emerald-500/20', text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
  { name: 'Green', bg: 'bg-green-500/20', text: 'text-green-700 dark:text-green-300', dot: 'bg-green-500' },
  { name: 'Lime', bg: 'bg-lime-500/25', text: 'text-lime-700 dark:text-lime-300', dot: 'bg-lime-500' },
  { name: 'Yellow', bg: 'bg-yellow-500/25', text: 'text-yellow-700 dark:text-yellow-300', dot: 'bg-yellow-500' },
  { name: 'Amber', bg: 'bg-amber-500/25', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  { name: 'Orange', bg: 'bg-orange-500/20', text: 'text-orange-700 dark:text-orange-300', dot: 'bg-orange-500' },
  { name: 'Slate', bg: 'bg-slate-500/20', text: 'text-slate-700 dark:text-slate-300', dot: 'bg-slate-500' },
  { name: 'Gray', bg: 'bg-gray-500/20', text: 'text-gray-700 dark:text-gray-300', dot: 'bg-gray-500' },
];

const FALLBACK = TAG_COLORS[TAG_COLORS.length - 1]; // Gray

/** Look up a tag color by name; falls back to Gray for unknown/legacy values. */
export function getTagColor(name?: string): TagColor {
  return TAG_COLORS.find(c => c.name === name) ?? FALLBACK;
}
