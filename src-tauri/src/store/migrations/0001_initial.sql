-- Plain connection store (no encryption).
--
-- All secrets live in the same row as the rest of the profile. This is
-- intentional for the current dev mode. The schema mirrors the M0 vault shape
-- (minus the `secrets`/`app_meta` tables) so a future encryption pass only has
-- to move the three password columns into a separate, encrypted table.
CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    driver TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    user TEXT,
    password TEXT,
    database TEXT,
    ssl_mode TEXT,
    ssh_enabled INTEGER NOT NULL DEFAULT 0,
    ssh_host TEXT,
    ssh_port INTEGER,
    ssh_user TEXT,
    ssh_auth_kind TEXT,
    ssh_key_path TEXT,
    ssh_password TEXT,
    ssh_key_passphrase TEXT,
    color TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE ssh_known_hosts (
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    PRIMARY KEY (host, port)
);
