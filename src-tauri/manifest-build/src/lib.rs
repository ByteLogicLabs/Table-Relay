//! Build-time helper that turns an adapter package on disk into a Rust
//! manifest static. Each built-in adapter's `build.rs` calls
//! [`generate_manifest`] with the path to its package root; the function
//! reads `manifest.toml` (+ optional `templates/` files) and writes a
//! `manifest_generated.rs` into `OUT_DIR` that the adapter's `lib.rs`
//! includes verbatim.
//!
//! Shape of an adapter package (the package root is one level above the
//! Cargo crate; the rust crate lives in `backend/`):
//!
//! ```text
//! src-adapters/<key>/
//!   manifest.toml
//!   templates/
//!     ai_system_context.md     (optional — inlined as ai_system_context;
//!                               supports `{var.path}` placeholders that
//!                               the host renders at runtime)
//!   assets/                    (icons, etc — referenced by the frontend)
//!   frontend/                  (per-adapter TypeScript, optional)
//!   backend/
//!     Cargo.toml
//!     build.rs                 (`manifest_build::generate_manifest(<package root>)`)
//!     src/lib.rs               (`include!(concat!(env!("OUT_DIR"), "/manifest_generated.rs"));`)
//! ```
//!
//! No legacy paths: every built-in adapter has been migrated. The
//! generator panics with a useful message on missing/invalid input —
//! these errors only fire at compile time.

use std::path::{Path, PathBuf};

use serde::Deserialize;

// ---- toml schema ------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct AdapterToml {
    adapter: AdapterSection,
    provenance: ProvenanceSection,
    capabilities: CapabilitiesSection,
    permissions: PermissionsSection,
    query_editor: QueryEditorSection,
    #[serde(default)]
    connection_fields: Vec<ConnectionFieldSection>,
    #[serde(default)]
    column_types: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AdapterSection {
    key: String,
    display_name: String,
    version: String,
    description: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ProvenanceSection {
    vendor: String,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    license: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct CapabilitiesSection {
    // schema introspection
    #[serde(default)] schemas: bool,
    #[serde(default)] describe_schema: bool,
    #[serde(default)] foreign_keys: bool,
    #[serde(default)] views: bool,
    #[serde(default)] routines: bool,
    #[serde(default)] indexes: bool,
    #[serde(default)] row_counts: bool,
    // browse
    #[serde(default)] browse: bool,
    #[serde(default)] server_filter: bool,
    #[serde(default)] server_sort: bool,
    #[serde(default)] streaming: bool,
    #[serde(default)] keyset_pagination: bool,
    // mutation
    #[serde(default)] update_rows: bool,
    #[serde(default)] insert_rows: bool,
    #[serde(default)] delete_rows: bool,
    #[serde(default)] transactions: bool,
    // ddl
    #[serde(default)] create_database: bool,
    #[serde(default)] create_table: bool,
    #[serde(default)] alter_table: bool,
    #[serde(default)] drop_table: bool,
    #[serde(default)] manage_indexes: bool,
    // app
    #[serde(default)] diagram: bool,
    #[serde(default)] erd_inference: bool,
    #[serde(default)] query_editor: bool,
    #[serde(default)] explain_plan: bool,
    #[serde(default)] ssh_tunnel: bool,
    #[serde(default)] process_list: bool,
    // file i/o
    #[serde(default)] import: Vec<String>,
    #[serde(default)] export: Vec<String>,
    // realtime + behavior
    #[serde(default)] realtime: bool,
    /// `"none" | "listen_notify" | "pubsub" | "change_stream"`
    #[serde(default)] realtime_kind: String,
    #[serde(default)] glob_subscriptions: bool,
    /// `"none" | "generic" | "mysql" | "postgres" | "sqlite"`
    #[serde(default)] sql_dialect: String,
    /// `"one_zero"` (default) | `"true_false"`
    #[serde(default)] boolean_literal_format: String,
    #[serde(default)] database_picker: bool,
    /// Column name to hide in the data grid (e.g. `"_id"`). Empty = none.
    #[serde(default)] hide_column_in_grid: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionsSection {
    #[serde(default)] network_outbound: bool,
    #[serde(default)] ssh_tunnel: bool,
    #[serde(default)] read_ssh_keys: bool,
    #[serde(default)] store_known_hosts: bool,
    #[serde(default)] read_credentials: bool,
}

#[derive(Debug, Deserialize)]
struct QueryEditorSection {
    label: String,
    placeholder: String,
    #[serde(default)] comment_tags: Vec<String>,
    #[serde(default)] result_view_modes: Vec<String>,
    #[serde(default)] examples: Vec<String>,
    #[serde(default)] data_faker_template: String,
    language: String,
    #[serde(default)] statement_separator: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionFieldSection {
    key: String,
    label: String,
    /// `"string" | "secret" | "int" | "enum" | "bool" | "file"`
    kind: String,
    #[serde(default)] required: bool,
    #[serde(default)] default: Option<String>,
    #[serde(default)] help: Option<String>,
    // Per-kind extras (only some apply per kind; unused are ignored).
    #[serde(default)] min: Option<i64>,
    #[serde(default)] max: Option<i64>,
    #[serde(default)] options: Vec<EnumOptionSection>,
    #[serde(default)] extensions: Vec<String>,
    #[serde(default)] allow_create: bool,
}

#[derive(Debug, Deserialize)]
struct EnumOptionSection {
    value: String,
    label: String,
}

// ---- public api -------------------------------------------------------------

/// Read an adapter package and write `manifest_generated.rs` to `OUT_DIR`.
/// Call from each adapter's `build.rs`:
///
/// ```ignore
/// fn main() {
///     manifest_build::generate_manifest(env!("CARGO_MANIFEST_DIR"));
/// }
/// ```
pub fn generate_manifest(adapter_dir: impl AsRef<Path>) {
    let dir = adapter_dir.as_ref();
    let toml_path = dir.join("manifest.toml");
    let out_dir = std::env::var_os("OUT_DIR").expect("OUT_DIR is set during build");
    let out_path = PathBuf::from(out_dir).join("manifest_generated.rs");

    println!("cargo:rerun-if-changed={}", toml_path.display());
    let templates_dir = dir.join("templates");
    if templates_dir.is_dir() {
        println!("cargo:rerun-if-changed={}", templates_dir.display());
    }

    let raw = std::fs::read_to_string(&toml_path)
        .unwrap_or_else(|e| panic!("read {}: {}", toml_path.display(), e));
    let parsed: AdapterToml = toml::from_str(&raw)
        .unwrap_or_else(|e| panic!("parse {}: {}", toml_path.display(), e));

    let ai_system_context = read_template(&templates_dir, "ai_system_context.md");

    let code = render(&parsed, ai_system_context.as_deref());
    std::fs::write(&out_path, code)
        .unwrap_or_else(|e| panic!("write {}: {}", out_path.display(), e));
}

fn read_template(templates_dir: &Path, name: &str) -> Option<String> {
    let p = templates_dir.join(name);
    if !p.is_file() { return None; }
    Some(
        std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("read template {}: {}", p.display(), e)),
    )
}

// ---- code rendering ---------------------------------------------------------

fn render(t: &AdapterToml, ai_context: Option<&str>) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let _ = writeln!(s, "// generated by manifest-build — do not edit");
    let _ = writeln!(s, "use ::adapter_api::manifest::*;");
    let _ = writeln!(s);
    let _ = writeln!(s, "pub static MANIFEST: AdapterManifest = AdapterManifest {{");
    let _ = writeln!(s, "    adapter: AdapterInfo {{");
    let _ = writeln!(s, "        key: {},", str_lit(&t.adapter.key));
    let _ = writeln!(s, "        display_name: {},", str_lit(&t.adapter.display_name));
    let _ = writeln!(s, "        version: {},", str_lit(&t.adapter.version));
    let _ = writeln!(s, "        description: {},", str_lit(&t.adapter.description));
    let _ = writeln!(s, "        tags: &[{}],", csv_str_slice(&t.adapter.tags));
    let _ = writeln!(s, "    }},");

    let _ = writeln!(s, "    provenance: Provenance {{");
    let _ = writeln!(s, "        vendor: {},", str_lit(&t.provenance.vendor));
    let _ = writeln!(s, "        homepage: {},", opt_str_lit(t.provenance.homepage.as_deref()));
    let _ = writeln!(s, "        license: {},", opt_str_lit(t.provenance.license.as_deref()));
    let _ = writeln!(s, "    }},");

    render_capabilities(&mut s, &t.capabilities);
    render_permissions(&mut s, &t.permissions);
    render_query_editor(&mut s, &t.query_editor);

    let _ = writeln!(s, "    connection_fields: &[");
    for f in &t.connection_fields {
        render_connection_field(&mut s, f);
    }
    let _ = writeln!(s, "    ],");

    let _ = writeln!(s, "    column_types: &[{}],",
        csv_str_slice(&t.column_types));
    let _ = writeln!(s, "    ai_system_context: {},",
        str_lit(ai_context.unwrap_or("")));

    let _ = writeln!(s, "}};");
    s
}

fn render_capabilities(s: &mut String, c: &CapabilitiesSection) {
    use std::fmt::Write as _;
    let _ = writeln!(s, "    capabilities: Capabilities {{");
    let _ = writeln!(s, "        schemas: {},", c.schemas);
    let _ = writeln!(s, "        describe_schema: {},", c.describe_schema);
    let _ = writeln!(s, "        foreign_keys: {},", c.foreign_keys);
    let _ = writeln!(s, "        views: {},", c.views);
    let _ = writeln!(s, "        routines: {},", c.routines);
    let _ = writeln!(s, "        indexes: {},", c.indexes);
    let _ = writeln!(s, "        row_counts: {},", c.row_counts);
    let _ = writeln!(s, "        browse: {},", c.browse);
    let _ = writeln!(s, "        server_filter: {},", c.server_filter);
    let _ = writeln!(s, "        server_sort: {},", c.server_sort);
    let _ = writeln!(s, "        streaming: {},", c.streaming);
    let _ = writeln!(s, "        keyset_pagination: {},", c.keyset_pagination);
    let _ = writeln!(s, "        update_rows: {},", c.update_rows);
    let _ = writeln!(s, "        insert_rows: {},", c.insert_rows);
    let _ = writeln!(s, "        delete_rows: {},", c.delete_rows);
    let _ = writeln!(s, "        transactions: {},", c.transactions);
    let _ = writeln!(s, "        create_database: {},", c.create_database);
    let _ = writeln!(s, "        create_table: {},", c.create_table);
    let _ = writeln!(s, "        alter_table: {},", c.alter_table);
    let _ = writeln!(s, "        drop_table: {},", c.drop_table);
    let _ = writeln!(s, "        manage_indexes: {},", c.manage_indexes);
    let _ = writeln!(s, "        diagram: {},", c.diagram);
    let _ = writeln!(s, "        erd_inference: {},", c.erd_inference);
    let _ = writeln!(s, "        query_editor: {},", c.query_editor);
    let _ = writeln!(s, "        explain_plan: {},", c.explain_plan);
    let _ = writeln!(s, "        ssh_tunnel: {},", c.ssh_tunnel);
    let _ = writeln!(s, "        process_list: {},", c.process_list);
    let _ = writeln!(s, "        import: &[{}],", csv_str_slice(&c.import));
    let _ = writeln!(s, "        export: &[{}],", csv_str_slice(&c.export));
    let _ = writeln!(s, "        realtime: {},", c.realtime);
    let _ = writeln!(s, "        realtime_kind: {},", realtime_kind_lit(&c.realtime_kind));
    let _ = writeln!(s, "        glob_subscriptions: {},", c.glob_subscriptions);
    let _ = writeln!(s, "        sql_dialect: {},", sql_dialect_lit(&c.sql_dialect));
    let _ = writeln!(s, "        boolean_literal_format: {},", bool_format_lit(&c.boolean_literal_format));
    let _ = writeln!(s, "        database_picker: {},", c.database_picker);
    let _ = writeln!(s, "        hide_column_in_grid: {},", str_lit(&c.hide_column_in_grid));
    let _ = writeln!(s, "    }},");
}

fn render_permissions(s: &mut String, p: &PermissionsSection) {
    use std::fmt::Write as _;
    let _ = writeln!(s, "    permissions: Permissions {{");
    let _ = writeln!(s, "        network_outbound: {},", p.network_outbound);
    let _ = writeln!(s, "        ssh_tunnel: {},", p.ssh_tunnel);
    let _ = writeln!(s, "        read_ssh_keys: {},", p.read_ssh_keys);
    let _ = writeln!(s, "        store_known_hosts: {},", p.store_known_hosts);
    let _ = writeln!(s, "        read_credentials: {},", p.read_credentials);
    let _ = writeln!(s, "    }},");
}

fn render_query_editor(s: &mut String, q: &QueryEditorSection) {
    use std::fmt::Write as _;
    let _ = writeln!(s, "    query_editor: QueryEditorInfo {{");
    let _ = writeln!(s, "        label: {},", str_lit(&q.label));
    let _ = writeln!(s, "        placeholder: {},", str_lit(&q.placeholder));
    let _ = writeln!(s, "        comment_tags: &[{}],", csv_str_slice(&q.comment_tags));
    let _ = writeln!(s, "        result_view_modes: &[{}],", csv_str_slice(&q.result_view_modes));
    let _ = writeln!(s, "        examples: &[{}],", csv_str_slice(&q.examples));
    let _ = writeln!(s, "        data_faker_template: {},", str_lit(&q.data_faker_template));
    let _ = writeln!(s, "        language: {},", str_lit(&q.language));
    let _ = writeln!(s, "        statement_separator: {},", opt_str_lit(q.statement_separator.as_deref()));
    let _ = writeln!(s, "    }},");
}

fn render_connection_field(s: &mut String, f: &ConnectionFieldSection) {
    use std::fmt::Write as _;
    let _ = writeln!(s, "        ConnectionField {{");
    let _ = writeln!(s, "            key: {},", str_lit(&f.key));
    let _ = writeln!(s, "            label: {},", str_lit(&f.label));
    let _ = writeln!(s, "            kind: {},", field_kind_lit(f));
    let _ = writeln!(s, "            required: {},", f.required);
    let _ = writeln!(s, "            default: {},", opt_str_lit(f.default.as_deref()));
    let _ = writeln!(s, "            help: {},", opt_str_lit(f.help.as_deref()));
    let _ = writeln!(s, "        }},");
}

// ---- helpers ----------------------------------------------------------------

fn str_lit(s: &str) -> String {
    // Use Rust raw string — pick a hash count that doesn't clash with the body.
    // Most adapter strings have no `"` at all; if they do we escape via debug.
    if !s.contains('\\') && !s.contains('"') {
        format!("\"{}\"", s)
    } else {
        format!("{:?}", s)
    }
}

fn opt_str_lit(s: Option<&str>) -> String {
    match s {
        Some(v) => format!("Some({})", str_lit(v)),
        None => "None".to_string(),
    }
}

fn csv_str_slice<S: AsRef<str>>(items: &[S]) -> String {
    items.iter()
        .map(|i| str_lit(i.as_ref()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn realtime_kind_lit(s: &str) -> &'static str {
    match s.to_ascii_lowercase().as_str() {
        "" | "none" => "RealtimeKind::None",
        "listen_notify" | "listennotify" => "RealtimeKind::ListenNotify",
        "pubsub" => "RealtimeKind::Pubsub",
        "change_stream" | "changestream" => "RealtimeKind::ChangeStream",
        other => panic!("unknown realtime_kind {:?}", other),
    }
}

fn sql_dialect_lit(s: &str) -> &'static str {
    match s.to_ascii_lowercase().as_str() {
        "" | "none" => "SqlDialect::None",
        "generic" => "SqlDialect::Generic",
        "mysql" => "SqlDialect::Mysql",
        "postgres" | "postgresql" => "SqlDialect::Postgres",
        "sqlite" => "SqlDialect::Sqlite",
        other => panic!("unknown sql_dialect {:?}", other),
    }
}

fn bool_format_lit(s: &str) -> &'static str {
    match s.to_ascii_lowercase().as_str() {
        "" | "one_zero" | "onezero" => "BooleanLiteralFormat::OneZero",
        "true_false" | "truefalse" => "BooleanLiteralFormat::TrueFalse",
        other => panic!("unknown boolean_literal_format {:?}", other),
    }
}

fn field_kind_lit(f: &ConnectionFieldSection) -> String {
    match f.kind.to_ascii_lowercase().as_str() {
        "string" => "FieldKind::String".to_string(),
        "secret" => "FieldKind::Secret".to_string(),
        "bool" | "boolean" => "FieldKind::Bool".to_string(),
        "int" | "integer" => {
            let min = f.min.map(|n| format!("Some({})", n)).unwrap_or_else(|| "None".to_string());
            let max = f.max.map(|n| format!("Some({})", n)).unwrap_or_else(|| "None".to_string());
            format!("FieldKind::Int {{ min: {}, max: {} }}", min, max)
        }
        "enum" => {
            let opts = f.options.iter()
                .map(|o| format!(
                    "EnumOption {{ value: {}, label: {} }}",
                    str_lit(&o.value), str_lit(&o.label)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("FieldKind::Enum {{ options: &[{}] }}", opts)
        }
        "file" => {
            let exts = csv_str_slice(&f.extensions);
            format!("FieldKind::File {{ extensions: &[{}], allow_create: {} }}",
                exts, f.allow_create)
        }
        other => panic!("unknown connection field kind {:?}", other),
    }
}
