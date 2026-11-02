// MySQL keyword list used by the SQL completion provider.
// Upper-cased canonical form; the provider matches the user's typed casing
// and adjusts the insert text accordingly.

export const MYSQL_KEYWORDS = [
  // DML
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'WITH', 'AS', 'DISTINCT', 'ALL',
  // Joins
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'OUTER JOIN', 'CROSS JOIN',
  'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'ON', 'USING',
  // Predicates
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  // Set ops
  'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
  // DDL
  'CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE',
  'TABLE', 'INDEX', 'VIEW', 'DATABASE', 'SCHEMA', 'COLUMN', 'CONSTRAINT',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'UNIQUE', 'CHECK', 'DEFAULT',
  'AUTO_INCREMENT', 'IF NOT EXISTS', 'IF EXISTS', 'TEMPORARY',
  // Types (common MySQL)
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT',
  'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'REAL',
  'CHAR', 'VARCHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT',
  'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'TINYBLOB', 'BINARY', 'VARBINARY',
  'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
  'BOOLEAN', 'BIT', 'ENUM', 'JSON', 'UUID',
  // Session / meta
  'USE', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'ANALYZE',
  'DATABASES', 'TABLES', 'COLUMNS', 'INDEXES',
  'BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
  // Common functions (treated as keywords; signature help fills in params later)
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'COALESCE', 'IFNULL', 'NULLIF', 'IF',
  'CONCAT', 'CONCAT_WS', 'SUBSTRING', 'TRIM', 'LTRIM', 'RTRIM',
  'UPPER', 'LOWER', 'LENGTH', 'REPLACE',
  'NOW', 'CURDATE', 'CURTIME', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB',
  'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
  'CAST', 'CONVERT',
];

// Reserved words that must be backticked when used as an identifier.
// Subset of the MySQL 8 reserved word list — enough to catch the common footguns.
export const MYSQL_RESERVED: ReadonlySet<string> = new Set([
  'ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY',
  'CASE', 'CHECK', 'COLUMN', 'CREATE', 'CROSS', 'CURRENT_DATE',
  'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'DATABASE', 'DEFAULT', 'DELETE',
  'DESC', 'DISTINCT', 'DROP', 'ELSE', 'EXISTS', 'FALSE', 'FOREIGN',
  'FROM', 'GROUP', 'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INT',
  'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'LIMIT', 'MATCH', 'NOT',
  'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'REFERENCES',
  'RENAME', 'REPLACE', 'RIGHT', 'SELECT', 'SET', 'TABLE', 'THEN',
  'TO', 'TRUE', 'UNION', 'UNIQUE', 'UPDATE', 'USE', 'USING', 'VALUES',
  'WHEN', 'WHERE', 'WITH',
]);

/**
 * Picks the casing for a keyword insert based on what the user has typed so far.
 * All-lower → lower; all-upper → upper; otherwise upper (matches most style guides).
 */
export function matchKeywordCasing(userPrefix: string, canonical: string): string {
  if (!userPrefix) return canonical;
  if (userPrefix === userPrefix.toLowerCase()) return canonical.toLowerCase();
  return canonical;
}

/**
 * True when the identifier needs backticks (reserved word, starts with digit,
 * or contains non-identifier characters).
 */
export function needsBackticks(ident: string): boolean {
  if (!ident) return false;
  if (MYSQL_RESERVED.has(ident.toUpperCase())) return true;
  if (/^\d/.test(ident)) return true;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) return true;
  return false;
}

export function quoteIdent(ident: string): string {
  return `\`${ident.replace(/`/g, '``')}\``;
}

export function maybeQuoteIdent(ident: string): string {
  return needsBackticks(ident) ? quoteIdent(ident) : ident;
}
