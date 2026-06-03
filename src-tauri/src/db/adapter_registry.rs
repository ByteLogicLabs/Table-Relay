//! Factory registry. Holds one `Arc<dyn Factory>` per registered
//! adapter kind (today: just MySQL). Built once at startup by
//! `register_builtins`; read by `db_connect` + `rebuild` to dispatch on
//! `profile.adapter_id`.
//!
//! Active adapters for *live connections* are tracked in
//! `db::registry::Registry` — this file only cares about the
//! compile-time set of factories.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use adapter_api::{AdapterError, Factory};

pub struct FactoryRegistry {
    inner: RwLock<HashMap<String, Arc<dyn Factory>>>,
}

impl FactoryRegistry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    pub fn register(&self, factory: Arc<dyn Factory>) {
        let key = factory.manifest().adapter.key.to_string();
        self.inner
            .write()
            .expect("factory registry poisoned")
            .insert(key, factory);
    }

    pub fn get(&self, key: &str) -> Result<Arc<dyn Factory>, AdapterError> {
        self.inner
            .read()
            .expect("factory registry poisoned")
            .get(key)
            .cloned()
            .ok_or_else(|| AdapterError::NotFound(format!("adapter `{key}` is not registered")))
    }

    /// Resolve a user-facing `driver` string (as stored on
    /// `ConnectionProfile::driver`) to the canonical adapter key
    /// declared in a registered manifest.
    ///
    /// Matches case-insensitively against the manifest's `adapter.key`
    /// first (new rows / new adapters save the key directly), then
    /// against `adapter.display_name` (legacy rows still stored the
    /// human label, e.g. `"MySQL / MariaDB"`), then against the
    /// display-name's first token (so `"MySQL"` matches `"MySQL / MariaDB"`).
    /// Returns `None` when no registered adapter claims the string —
    /// callers surface that as a clean "no adapter installed" error.
    pub fn resolve(&self, driver: &str) -> Option<&'static str> {
        let needle = driver.trim();
        if needle.is_empty() {
            return None;
        }
        let guard = self.inner.read().expect("factory registry poisoned");
        for factory in guard.values() {
            let m = factory.manifest();
            if m.adapter.key.eq_ignore_ascii_case(needle)
                || m.adapter.display_name.eq_ignore_ascii_case(needle)
            {
                return Some(m.adapter.key);
            }
            // Match the first whitespace- or slash-separated token of the
            // display name so `"MySQL"` resolves `"MySQL / MariaDB"`.
            if let Some(first) = m
                .adapter
                .display_name
                .split(|c: char| c.is_whitespace() || c == '/')
                .find(|s| !s.is_empty())
            {
                if first.eq_ignore_ascii_case(needle) {
                    return Some(m.adapter.key);
                }
            }
        }
        None
    }

    /// All registered manifests, sorted by key.
    pub fn manifests(&self) -> Vec<&'static adapter_api::AdapterManifest> {
        let mut list: Vec<&'static adapter_api::AdapterManifest> = self
            .inner
            .read()
            .expect("factory registry poisoned")
            .values()
            .map(|f| f.manifest())
            .collect();
        list.sort_by_key(|m| m.adapter.key);
        list
    }
}

impl Default for FactoryRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adapter_api::manifest::{
        AdapterInfo, AdapterManifest, Capabilities, Permissions, Provenance, QueryEditorInfo,
    };
    use adapter_api::{Adapter, ConnectionProfile};
    use async_trait::async_trait;

    // Two stub manifests with distinct shapes so the resolver has something
    // to match against without pulling in the real adapter crates.
    static FAKE_A: AdapterManifest = AdapterManifest {
        adapter: AdapterInfo {
            key: "fakedb",
            display_name: "FakeDB / Turbo",
            version: "0",
            description: "",
            tags: &[],
        },
        provenance: Provenance {
            vendor: "",
            homepage: None,
            license: None,
        },
        capabilities: Capabilities {
            schemas: false,
            describe_schema: false,
            foreign_keys: false,
            views: false,
            routines: false,
            indexes: false,
            row_counts: false,
            browse: false,
            server_filter: false,
            server_sort: false,
            streaming: false,
            keyset_pagination: false,
            update_rows: false,
            insert_rows: false,
            delete_rows: false,
            transactions: false,
            create_database: false,
            create_table: false,
            alter_table: false,
            drop_table: false,
            manage_indexes: false,
            diagram: false,
            erd_inference: false,
            query_editor: false,
            explain_plan: false,
            ssh_tunnel: false,
            process_list: false,
            import: &[],
            export: &[],
            realtime: false,
            realtime_kind: adapter_api::RealtimeKind::None,
            glob_subscriptions: false,
            sql_dialect: adapter_api::SqlDialect::None,
            boolean_literal_format: adapter_api::BooleanLiteralFormat::OneZero,
            database_picker: false,
            hide_column_in_grid: "",
        },
        permissions: Permissions {
            network_outbound: false,
            ssh_tunnel: false,
            read_ssh_keys: false,
            store_known_hosts: false,
            read_credentials: false,
        },
        query_editor: QueryEditorInfo {
            label: "",
            placeholder: "",
            comment_tags: &[],
            result_view_modes: &["table"],
            examples: &[],
            data_faker_template: "",
            language: "",
            statement_separator: None,
        },
        connection_fields: &[],
        column_types: &[],
        ai_system_context: "",
    };

    struct FakeFactory(&'static AdapterManifest);

    #[async_trait]
    impl Factory for FakeFactory {
        fn manifest(&self) -> &'static AdapterManifest {
            self.0
        }
        async fn connect(
            &self,
            _profile: ConnectionProfile,
        ) -> Result<Arc<dyn Adapter>, AdapterError> {
            Err(AdapterError::Unsupported("fake".into()))
        }
    }

    #[test]
    fn resolve_matches_key() {
        let reg = FactoryRegistry::new();
        reg.register(Arc::new(FakeFactory(&FAKE_A)));
        assert_eq!(reg.resolve("fakedb"), Some("fakedb"));
        assert_eq!(reg.resolve("FakeDB"), Some("fakedb"));
    }

    #[test]
    fn resolve_matches_display_name_first_token() {
        let reg = FactoryRegistry::new();
        reg.register(Arc::new(FakeFactory(&FAKE_A)));
        // Full display name — case insensitive.
        assert_eq!(reg.resolve("FakeDB / Turbo"), Some("fakedb"));
        // First whitespace/slash token — catches legacy rows that stored
        // `"MySQL"` against a `"MySQL / MariaDB"` display name.
        assert_eq!(reg.resolve("FakeDB"), Some("fakedb"));
    }

    #[test]
    fn resolve_returns_none_for_unknown_driver() {
        let reg = FactoryRegistry::new();
        reg.register(Arc::new(FakeFactory(&FAKE_A)));
        assert_eq!(reg.resolve("postgres"), None);
        assert_eq!(reg.resolve(""), None);
        assert_eq!(reg.resolve("   "), None);
    }
}
