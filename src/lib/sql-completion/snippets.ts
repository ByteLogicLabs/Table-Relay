// SQL snippets surfaced above keyword matches. Bodies follow Monaco's snippet
// syntax: `${1:placeholder}` for tab stops, `${0}` for the final cursor.

export interface SqlSnippet {
  label: string;
  body: string;
  description: string;
}

export type SnippetDialect = 'mysql' | 'postgres' | 'sqlite' | 'generic' | 'none' | string;

// The auto-incrementing primary-key line in `CREATE TABLE` is the only piece
// of snippet boilerplate that genuinely differs per dialect:
//   - MySQL:    BIGINT UNSIGNED AUTO_INCREMENT
//   - Postgres: GENERATED ALWAYS AS IDENTITY (modern equivalent of SERIAL)
//   - SQLite:   INTEGER PRIMARY KEY AUTOINCREMENT (rowid alias)
function ctblBody(dialect: SnippetDialect): string {
  if (dialect === 'postgres') {
    return 'CREATE TABLE ${1:table} (\n  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  ${2:column} ${3:VARCHAR(255)} NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT now()\n);${0}';
  }
  if (dialect === 'sqlite') {
    return 'CREATE TABLE ${1:table} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ${2:column} ${3:TEXT} NOT NULL,\n  created_at TEXT DEFAULT CURRENT_TIMESTAMP\n);${0}';
  }
  // MySQL / generic.
  return 'CREATE TABLE ${1:table} (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  ${2:column} ${3:VARCHAR(255)} NOT NULL,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);${0}';
}

/** Build the snippet list for a given SQL dialect. Only `ctbl` varies; the
 *  rest are portable across MySQL/Postgres/SQLite. */
export function snippetsForDialect(dialect: SnippetDialect = 'mysql'): SqlSnippet[] {
  return [
    { label: 'sel',      description: 'SELECT * FROM …',                  body: 'SELECT ${1:*} FROM ${2:table};${0}' },
    { label: 'self',     description: 'SELECT … FROM … WHERE …',          body: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:column} = ${4:value};${0}' },
    { label: 'selj',     description: 'SELECT … FROM … JOIN …',           body: 'SELECT ${1:a.*}\nFROM ${2:table_a} a\nJOIN ${3:table_b} b ON a.${4:id} = b.${5:a_id};${0}' },
    { label: 'cnt',      description: 'SELECT COUNT(*) …',                 body: 'SELECT COUNT(*) FROM ${1:table};${0}' },
    { label: 'ins',      description: 'INSERT INTO …',                    body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});${0}' },
    { label: 'upd',      description: 'UPDATE …',                          body: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:id} = ${5:?};${0}' },
    { label: 'del',      description: 'DELETE FROM …',                    body: 'DELETE FROM ${1:table}\nWHERE ${2:id} = ${3:?};${0}' },
    { label: 'ctbl',     description: 'CREATE TABLE …',                   body: ctblBody(dialect) },
    { label: 'cidx',     description: 'CREATE INDEX …',                   body: 'CREATE INDEX ${1:idx_name} ON ${2:table} (${3:column});${0}' },
    { label: 'wth',      description: 'WITH cte AS (…)',                   body: 'WITH ${1:cte} AS (\n  SELECT ${2:*} FROM ${3:table}\n)\nSELECT *\nFROM ${1:cte};${0}' },
    { label: 'grp',      description: 'GROUP BY …',                       body: 'SELECT ${1:column}, COUNT(*) AS total\nFROM ${2:table}\nGROUP BY ${1:column}\nORDER BY total DESC;${0}' },
    { label: 'ord',      description: 'ORDER BY …',                       body: 'ORDER BY ${1:column} ${2|ASC,DESC|}${0}' },
    { label: 'lim',      description: 'LIMIT N',                           body: 'LIMIT ${1:100}${0}' },
    { label: 'expl',     description: 'EXPLAIN …',                        body: 'EXPLAIN ${1:SELECT * FROM table};${0}' },
  ];
}

/** Default (MySQL-flavoured) snippet list, kept for callers that haven't
 *  threaded a dialect through yet. */
export const SQL_SNIPPETS: SqlSnippet[] = snippetsForDialect('mysql');
