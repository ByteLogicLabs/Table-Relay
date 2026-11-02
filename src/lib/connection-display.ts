/** Human-facing host label that never leaks credentials.
 *
 *  A connection's `host` field can hold either a plain `host[:port]` or a full
 *  connection URI (e.g. Mongo keeps `mongodb://user:pass@host/...` in `host`).
 *  When it's a URI we strip the `user:pass@` userinfo so passwords don't show
 *  up in the workspace header, pickers, tooltips, etc. */
export function displayHost(host: string | undefined | null): string {
  if (!host) return '';
  const value = host.trim();

  // URI form: scheme://[userinfo@]hostpart[/...]. Drop userinfo + path/query.
  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    let rest = schemeMatch[2];
    // Strip credentials before the first '@' (only the authority's userinfo).
    const at = rest.indexOf('@');
    if (at !== -1) rest = rest.slice(at + 1);
    // Keep only the authority (host[:port][,host:port…]); drop /path and ?query.
    const authority = rest.split(/[/?]/)[0];
    return `${scheme}://${authority}`;
  }

  return value;
}

/** Returns true when `host` is a full connection URI rather than a plain host. */
export function isUriHost(host: string | undefined | null): boolean {
  return !!host && /^[a-z][a-z0-9+.-]*:\/\//i.test(host.trim());
}

/** Credential-safe endpoint label for list/card rows. For a URI host we show
 *  the sanitized `scheme://authority`; otherwise the familiar `[user@]host:port`. */
export function displayEndpoint(
  conn: { host?: string | null; port?: string | number | null; user?: string | null },
): string {
  if (isUriHost(conn.host)) return displayHost(conn.host);
  const hostPort = `${conn.host ?? ''}${conn.port ? `:${conn.port}` : ''}`;
  return conn.user ? `${conn.user}@${hostPort}` : hostPort;
}
