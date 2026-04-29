import { format, type FormatOptionsWithLanguage } from 'sql-formatter';

/**
 * Default formatting profile used across the app. MySQL dialect is a safe
 * superset for the routines/views we open today; when PostgreSQL lands we can
 * pass a driver-specific override from the caller.
 */
const DEFAULT_OPTIONS: FormatOptionsWithLanguage = {
  language: 'mysql',
  keywordCase: 'upper',
  tabWidth: 2,
  useTabs: false,
  linesBetweenQueries: 2,
};

/**
 * Format a SQL string. On parse errors sql-formatter throws; we fall back to
 * the original input so a malformed draft never silently loses the user's
 * content. Callers should surface the error (or at least log it) when they
 * care about distinguishing success from no-op.
 */
export function formatSql(sql: string, overrides?: Partial<FormatOptionsWithLanguage>): { formatted: string; error: string | null } {
  try {
    const formatted = format(sql, { ...DEFAULT_OPTIONS, ...overrides });
    return { formatted, error: null };
  } catch (e) {
    return { formatted: sql, error: e instanceof Error ? e.message : String(e) };
  }
}
