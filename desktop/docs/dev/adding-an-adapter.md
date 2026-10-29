# Adding a database adapter

An *adapter* is a self-contained crate that teaches Table Relay to talk to one
kind of database. This page is the end-to-end recipe.

## The two traits

Both live in `src-tauri/adapter-api/src/lib.rs`.

### `Factory`

One per adapter kind, held in the host's `FactoryRegistry`:

- `manifest(&self) -> &'static AdapterManifest` - static metadata for this adapter.
- `async fn connect(profile: ConnectionProfile) -> Result<Arc<dyn Adapter>, AdapterError>`
  - build a live `Adapter` from a decrypted connection profile.

### `Adapter`

The async trait every adapter implements. Methods are grouped by intent; most
non-trivial ones default to `Unsupported`, so you implement only what your
database can do. Highlights:

- **Connection / metadata**: `ping`
- **Introspection**: `list_schemas`, `list_databases`, `describe_table`,
  `describe_schema`, `list_relations`, `list_views`, `list_routines`,
  `describe_routine`, `list_triggers`, `describe_trigger`
- **Browsing**: `browse(BrowseRequest)`, `count_records(CountRequest)`
- **Mutation**: `mutate(MutateRequest)` (insert/update/delete by primary key)
- **DDL**: `create_schema`, `modify_indexes`, `list_charsets`, `list_collations`,
  `list_all_collations`
- **Raw execution (escape hatch)**: `execute_raw`, `execute_raw_scoped`,
  `execute_raw_scoped_stream` - run the adapter-native command verbatim (SQL,
  Mongo shell, Redis commands)
- **Analysis**: `analyze_command` (structured warnings before execution)
- **Process management**: `process_list`, `kill_process`, `kill_processes`
- **Realtime**: `subscribe(req, sink)` (Pub/Sub, LISTEN/NOTIFY, change streams)
- **Lifecycle**: `shutdown`

Requests are SQL-agnostic - the frontend sends intent and your adapter
translates to the native query language.

## Folder layout

An adapter lives under `src-adapters/<name>/`. The **`manifest.toml` sits at the
root**, one level above the Rust crate (which lives in `backend/`):

```
src-adapters/<name>/
├── manifest.toml          # capability + connection-field manifest (authoritative)
├── templates/             # optional, e.g. ai_system_context.md
├── assets/                # optional icons/images
├── frontend/              # optional per-adapter TypeScript hooks
└── backend/
    ├── Cargo.toml         # package: name = "adapter-<name>"
    ├── build.rs           # calls manifest_build::generate_manifest(package_root)
    └── src/
        ├── lib.rs         # include!(manifest_generated.rs); pub use <Name>Factory;
        ├── factory.rs     # <Name>Factory : Factory
        ├── adapter.rs     # <Name>Adapter : Adapter
        └── ...            # driver plumbing (browse.rs, mutate.rs, subscribe.rs, ...)
```

## `manifest.toml`

Parsed at build time into a `&'static AdapterManifest`. Key sections:

- **`[adapter]`** - `key` (must match the folder name), `display_name`,
  `version`, `description`, `tags`.
- **`[provenance]`** - `vendor`, optional `license`, `homepage`.
- **`[capabilities]`** - boolean/enum flags that **gate UI controls**. Examples:
  `browse`, `update_rows`, `insert_rows`, `delete_rows`, `create_table`,
  `alter_table`, `manage_indexes`, `views`, `routines`, `triggers`, `diagram`,
  `query_editor`, `explain_plan`, `ssh_tunnel`, `process_list`, plus `import` /
  `export` (arrays of format tokens). Behavior-shaping enums include
  `realtime` + `realtime_kind` (`none`/`listen_notify`/`pubsub`/`change_stream`),
  `sql_dialect` (`none`/`generic`/`mysql`/`postgres`/`sqlite`),
  `database_picker`, and `hide_column_in_grid` (Mongo hides `_id`).
- **`[permissions]`** - `network_outbound`, `ssh_tunnel`, `read_ssh_keys`,
  `store_known_hosts`, `read_credentials` (auto-granted for built-ins).
- **`[query_editor]`** - `label`, `placeholder`, `language` (Monaco id),
  `comment_tags`, `result_view_modes`, `statement_separator`, `examples`.
- **`[[connection_fields]]`** - one block per form input: `key`, `label`,
  `kind` (`string`/`secret`/`int`/`enum`/`bool`/`file`), `required`, `default`,
  and kind-specific extras (`min`/`max`, enum `options`, file `extensions` /
  `allow_create`).
- **`[column_types]`** (optional) - type names offered in the add-column picker.

The frontend reads the manifest and shows/hides surfaces accordingly:
`browse=true` → data grid, `query_editor=true` → query tab, `realtime=true` →
realtime tab (verbs from `realtime_kind`), `ssh_tunnel=true` → SSH section, etc.

## Registration (three coordinated edits)

1. **`src-tauri/adapters.toml`** - enroll the adapter:
   ```toml
   [[adapter]]
   name = "<name>"
   needs_known_hosts = true   # set this if it opens SSH tunnels
   ```
   Optional `factory = "..."` overrides the derived `<Name>Factory` type name.

2. **`src-tauri/Cargo.toml`** - add the path dependency:
   ```toml
   adapter-<name> = { path = "../src-adapters/<name>/backend" }
   ```

3. **Rebuild.** `src-tauri/build.rs` parses `adapters.toml`, **verifies every
   enrolled adapter has a matching path dep** (fails the build on drift), and
   generates `register_all()` in `$OUT_DIR/registered_adapters.rs`. Adapters
   with `needs_known_hosts = true` get the `KnownHostsStore` passed to their
   factory constructor.

## Driver crates used by the built-ins

| Adapter | Driver crate |
|---|---|
| PostgreSQL | `sqlx` (features: `runtime-tokio-rustls`, `postgres`, `chrono`, `uuid`, `json`, `bigdecimal`) + `adapter-ssh` |
| MySQL | `sqlx` (… `mysql` …) + `adapter-ssh` |
| SQLite | `sqlx` (… `sqlite` …) + `libsqlite3-sys` (`bundled`); no SSH |
| MongoDB | `mongodb` 2.x + `adapter-ssh` |
| Redis | `redis` 0.27 (`tokio-comp`, no TLS) + `adapter-ssh` |

All adapters depend on `adapter-api`, `async-trait`, `serde`/`serde_json`,
`tokio`, and the `manifest-build` build-dependency.

## Checklist

- [ ] `src-adapters/<name>/manifest.toml` with `key = "<name>"` and accurate capabilities
- [ ] `backend/Cargo.toml` (`name = "adapter-<name>"`) + driver dep
- [ ] `backend/build.rs` calling `manifest_build::generate_manifest`
- [ ] `backend/src/lib.rs` including the generated manifest + exporting `<Name>Factory`
- [ ] `factory.rs` + `adapter.rs` implementing the traits (start minimal; default the rest to `Unsupported`)
- [ ] Enroll in `src-tauri/adapters.toml`
- [ ] Path dep in `src-tauri/Cargo.toml`
- [ ] `cargo build` (drift check + codegen run automatically)

## See also

- [Architecture overview](architecture.md)
- The existing adapters under `src-adapters/` are the best reference - `postgres`
  is the most complete.
