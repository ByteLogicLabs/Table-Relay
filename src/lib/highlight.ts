export type TokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'ident' | 'punct' | 'plain';

export interface Token {
  text: string;
  kind: TokenKind;
}

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'AS', 'ON',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'USING',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'DISTINCT',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'RETURNING',
  'CREATE', 'TABLE', 'INDEX', 'VIEW', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'CONSTRAINT',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE', 'CHECK', 'DEFAULT',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
  'TRUE', 'FALSE',
]);

const MONGO_KEYWORDS = new Set([
  'db', 'getCollection', 'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete',
  'aggregate', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'countDocuments', 'distinct', 'limit', 'skip', 'sort', 'project', 'match', 'group',
  'lookup', 'unwind', 'replaceOne', 'bulkWrite', 'createIndex', 'dropIndex',
  'true', 'false', 'null', 'undefined', 'new', 'Date', 'ObjectId', 'ISODate',
]);

const REDIS_KEYWORDS = new Set([
  'GET', 'SET', 'DEL', 'HGET', 'HSET', 'HGETALL', 'LPUSH', 'RPUSH', 'LRANGE',
  'SADD', 'SMEMBERS', 'ZADD', 'ZRANGE', 'XRANGE', 'PUBLISH', 'SUBSCRIBE',
  'PSUBSCRIBE', 'UNSUBSCRIBE', 'SCAN', 'KEYS', 'TYPE', 'TTL', 'EXPIRE',
  'SELECT', 'INFO', 'PING', 'NOTIFY', 'LISTEN', 'UNLISTEN',
]);

/**
 * Tokenize SQL or Mongo-flavoured JS. Simple regex, not a real parser.
 */
export function highlight(stmt: string, dialect: 'sql' | 'mongo' | 'redis' = 'sql'): Token[] {
  const tokens: Token[] = [];
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+)|([(){}\[\],;.:*=<>!+\-/%?&|])/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(stmt)) !== null) {
    if (m.index > lastIndex) tokens.push({ text: stmt.slice(lastIndex, m.index), kind: 'plain' });
    if (m[1] !== undefined) tokens.push({ text: m[1], kind: 'comment' });
    else if (m[2] !== undefined) tokens.push({ text: m[2], kind: 'string' });
    else if (m[3] !== undefined) tokens.push({ text: m[3], kind: 'number' });
    else if (m[4] !== undefined) {
      const word = m[4];
      const isKeyword = dialect === 'sql'
        ? SQL_KEYWORDS.has(word.toUpperCase())
        : dialect === 'mongo'
          ? MONGO_KEYWORDS.has(word)
          : REDIS_KEYWORDS.has(word.toUpperCase());
      tokens.push({ text: word, kind: isKeyword ? 'keyword' : 'ident' });
    }
    else if (m[5] !== undefined) tokens.push({ text: m[5], kind: 'plain' });
    else if (m[6] !== undefined) tokens.push({ text: m[6], kind: 'punct' });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < stmt.length) tokens.push({ text: stmt.slice(lastIndex), kind: 'plain' });
  return tokens;
}

// Theme-aware token colors. Variables are defined per theme in src/index.css
// so the query log + any inline highlights track the active palette.
export const tokenClass: Record<TokenKind, string> = {
  keyword: 'text-(--syntax-keyword) font-semibold',
  string:  'text-(--syntax-string)',
  number:  'text-(--syntax-number)',
  comment: 'text-muted-foreground italic',
  ident:   'text-foreground',
  punct:   'text-(--syntax-punct)',
  plain:   'text-foreground',
};
