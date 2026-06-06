import { format, type FormatOptionsWithLanguage, type SqlLanguage } from 'sql-formatter';

/**
 * Default formatting profile used across the app. Language defaults to `sql`
 * (generic) but callers should pass their adapter's dialect via
 * `languageForDialect(...)` so dialect-specific syntax (Postgres `::cast`,
 * `$$` bodies, etc.) parses instead of throwing a MySQL parse error.
 */
const DEFAULT_OPTIONS: FormatOptionsWithLanguage = {
  language: 'sql',
  keywordCase: 'upper',
  tabWidth: 2,
  useTabs: false,
  linesBetweenQueries: 2,
};

/**
 * Map the app's adapter dialect tokens to a sql-formatter `language`. Unknown /
 * non-SQL dialects fall back to the generic `sql` grammar, which is permissive
 * enough not to choke on most dialect-specific syntax.
 */
export function languageForDialect(
  dialect: 'mysql' | 'postgres' | 'sqlite' | 'generic' | 'none' | string | null | undefined,
): SqlLanguage {
  switch (dialect) {
    case 'mysql':
      return 'mysql';
    case 'postgres':
      return 'postgresql';
    case 'sqlite':
      return 'sqlite';
    default:
      return 'sql';
  }
}

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
