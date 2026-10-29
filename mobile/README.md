# Brain DB

Table Relay for Android: a native Kotlin (Jetpack Compose) database workbench for **MySQL / MariaDB, PostgreSQL,
SQLite, MongoDB and Redis**, sold as a Brain Factory app (package `com.brainfactory.db`, store slug `brain-db`). It can
also run **PostgreSQL, MariaDB, Redis and Valkey servers** on the phone itself.

The desktop app lives in [`../desktop`](../desktop); Brain DB follows its features and look (dark zinc chrome,
amber accent) on a phone and, from 840 dp wide, in a desktop-like two-pane layout on tablets and foldables.

## Features

| | MySQL | PostgreSQL | SQLite | MongoDB | Redis |
|---|:---:|:---:|:---:|:---:|:---:|
| Browse, filter, sort, page | ✅ | ✅ | ✅ | ✅ (grid + JSON) | key browser (SCAN, type filter) |
| Edit cells, add, duplicate, delete rows | ✅ | ✅ | ✅ (rowid without a PK) | ✅ (documents too) | per type: string, hash, list, set, zset, stream |
| Query editor | SQL | SQL | SQL | mongosh syntax | redis-cli commands |
| Structure | columns, indexes, FKs, DDL | same (DDL rebuilt) | same | sampled schema, indexes, stats | TTL, size |
| Routines, triggers, views | ✅ | ✅ | triggers, views | views | — |
| Process list / kill | ✅ | ✅ | — | currentOp / killOp | CLIENT LIST / KILL |
| Realtime | — | LISTEN / NOTIFY | — | change streams | Pub/Sub |
| SSH tunnel | ✅ | ✅ | — | ✅ (one host) | ✅ |

Also: connection import/export in Table Relay's encrypted `.dtab` format (both ways), connection URLs
(`postgres://…`, `mongodb+srv://…`), a destructive-statement check before DELETE/UPDATE without WHERE, DROP, TRUNCATE
(and Mongo drops, Redis FLUSH), read-only connections, query history, a query log, export to CSV / TSV / JSON /
NDJSON / SQL INSERTs, light and dark themes, and silent reconnects when a server or tunnel drops an idle connection.

Not in Brain DB yet: the AI assistant, ER diagrams, the schema editor (create/alter through SQL instead), the MCP bridge.

## Local servers

Home › Local Servers sets up a database server on the phone: PostgreSQL, MariaDB, Redis or Valkey, in the version the
package repository offers, with its port, a generated password, and optionally a listener on the phone's Wi-Fi so other
devices can connect. Each server gets a saved connection; opening it starts the server when it isn't running.

- **Nothing is bundled.** The servers are [Termux](https://termux.dev)'s Android builds, downloaded when a server needs
  them (PostgreSQL 22 MB, MariaDB 22 MB, Redis and Valkey 1 MB). The repository's `Release` must carry a valid
  signature by Termux's key (`host/src/main/assets/termux-autobuilds.gpg`), its `Packages` index must match the hash
  `Release` lists, and every `.deb` the hash in the index. Only what the server needs is unpacked (MariaDB: 56 MB of
  the package's 218 MB), read-only, into `files/host/engines/<engine>-<version>/`. Versions stay installed side by
  side; a server keeps the version its data directory was made with.
- **No proot, no root.** Android doesn't let an app exec files it wrote (W^X, targetSdk 29+), so a server runs as
  `/system/bin/linker64 <program> …`. The shim in `host/src/main/cpp` (LD_PRELOADed, so native libraries are
  extracted: `useLegacyPackaging`) does the same for programs the servers start (initdb runs postgres), stands in for
  System V shared memory (SELinux denies it, and Termux's libandroid-shmem keeps its keys in Termux's own directory),
  and teaches bionic's `regcomp()` the GNU `\s`/`\w` escapes.
- **Setup without scripts.** PostgreSQL runs its own `initdb` (C.UTF-8 builtin locale from 17, SCRAM passwords, sized
  for a phone: 32 MB shared buffers, synchronous I/O); MariaDB gets what `mariadb-install-db` would feed
  `mariadbd --bootstrap`, with root's password written to the grant tables; Redis and Valkey get a config file.
- **Running.** The servers are the app's child processes: a foreground service (its notification has Stop All)
  keeps the process alive, also with the app closed, and a server reachable from other devices keeps the CPU and
  Wi-Fi awake. They stop with the app's process (an app update included; PostgreSQL and InnoDB recover on the next
  start, Redis keeps what it last saved).

`host/` holds all of it; its suite in `host/src/androidTest` downloads each engine on a device and runs it end to end.
Android 12+ may kill an app's child processes beyond 32 across all apps ("phantom processes"); PostgreSQL uses six
or so.

## Layout

```
app/       Activity, screens (Compose), workspace state, saved connections (Keystore-encrypted), settings
engine/    one session per driver, SSH tunnels, SQL splitting/quoting/checks, export, .dtab transfer; JVM tests
core-ui/   Brain DB's colours (Table Relay's) and widgets
updater/   sign-in with an emailed code (Brain Code's sign-in screen) and the self-updater (version.rc)
host/      local servers: the signed package index, downloads, unpacking, setup, processes; the native shim
```

Drivers run on Android's Java library, which lacks JNDI, JMX, XA and SASL. What the drivers need from those is
worked around in `engine`:

- MariaDB Connector/J **3.x** (2.x registers itself with `java.sql.DriverAction`, which Android doesn't have).
- pgjdbc is used without its `PGPropertyMaxResultBufferParser` (it calls `java.lang.management` on every connection);
  `engine/src/main/java/org/postgresql/util` has a copy without it, and the `pgjdbcAndroid` task builds the jar.
- MongoDB: `mongodb+srv://` lookups go over DNS-over-HTTPS (`DohDnsClient`) instead of JNDI, and
  `engine/src/main/java/javax/security/sasl` supplies the two SASL types its SCRAM sign-in implements.
- Redis has its own small RESP client.

## Build

JDK 17 or 21, the Android SDK (compile SDK 35) and NDK 27 with CMake 3.22 (for the local servers' shim):

```sh
./gradlew :app:assembleDebug            # debug build, signed with the debug key
./gradlew :engine:testDebugUnitTest      # SQL splitting, builders, shell parser, RESP, .dtab, export
./gradlew :host:testDebugUnitTest        # package index, versions, signature check, .deb reading
BRAIN_KEYSTORE=/path/braindb-release.jks BRAIN_KEYSTORE_PASSWORD=… ./gradlew :app:assembleRelease
```

Releases are signed with Brain DB's own key (alias `upload`); an update only installs over a copy signed with it.
`appVersion` in `gradle.properties` sets the version; `versionCode = major × 1,000,000 + minor × 1,000 + patch`.
