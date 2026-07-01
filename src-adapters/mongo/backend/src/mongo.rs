use std::collections::{BTreeMap, BTreeSet};
use std::sync::RwLock;
use std::time::Instant;

use adapter_api::{
    log_line,
    AdapterError, BrowseRequest, BrowseResult, ColumnInfo, ColumnMeta, CountRequest, Filter,
    FilterOp, IndexInfo, SchemaInfo, ServerDetail, ServerInfo, SortDirection, TableInfo, TableKind,
    TableStructure,
};
use futures::TryStreamExt;
use mongodb::bson::{Bson, Document, doc, oid::ObjectId};
use mongodb::options::{ClientOptions, Credential, FindOptions};
use mongodb::{Client, Collection};
use serde_json::Value as JsonValue;

#[derive(Debug, Clone)]
pub struct MongoConfig {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: Option<String>,
    /// Explicit auth database. When set, it's tried first (and only) instead of
    /// the admin/selected-db auto-detect. Comes from the `authSource` field.
    pub auth_source: Option<String>,
}

pub struct MongoDriver {
    pub(crate) client: Client,
    pub(crate) default_db: Option<String>,
    pub(crate) active_db: RwLock<Option<String>>,
}

impl MongoDriver {
    pub async fn connect(cfg: MongoConfig) -> Result<Self, AdapterError> {
        let auth = normalized_auth_fields(&cfg);
        let uri_mode = cfg.host.starts_with("mongodb://") || cfg.host.starts_with("mongodb+srv://");
        log_line!(
            "mongo_connect",
            "→ host={} port={} uri_mode={} default_db={:?} ssl_mode={:?} explicit_auth={}",
            cfg.host,
            cfg.port,
            uri_mode,
            cfg.database,
            cfg.ssl_mode,
            auth.is_some(),
        );
        let with_source = auth.is_some();
        let mut sources: Vec<Option<String>> = Vec::new();
        if with_source {
            if let Some(explicit) = cfg.auth_source.clone() {
                // User specified the auth database — honor it exactly.
                sources.push(Some(explicit));
            } else {
                // Auto-detect: many clusters create users in `admin` even when
                // the app's working DB differs. Try admin first, then the
                // selected DB.
                sources.push(Some("admin".to_string()));
                if let Some(db) = cfg.database.clone().filter(|s| !s.trim().is_empty()) {
                    if db != "admin" {
                        sources.push(Some(db));
                    }
                }
            }
        } else {
            sources.push(None);
        }

        let mut last_err: Option<AdapterError> = None;
        for source in sources {
            log_line!(
                "mongo_connect",
                "  trying auth_source={}",
                source.as_deref().unwrap_or("<none>")
            );
            match build_client(&cfg, source.as_deref(), auth.as_ref()).await {
                Ok(client) => {
                    // Validate auth upfront so "Connection test" reports the
                    // error in the connect stage instead of surprising later.
                    // Ping the auth/selected DB (not always `admin`) — a user
                    // scoped to their own DB may have no `admin` access, which
                    // would otherwise look like an auth failure.
                    // Never ping an empty database name (Mongo rejects "" with
                    // InvalidNamespace). Fall back through source → selected DB →
                    // "admin", skipping any blank candidate.
                    let ping_db = resolve_ping_db(source.as_deref(), cfg.database.as_deref());
                    let probe = client.database(&ping_db);
                    match probe.run_command(doc! { "ping": 1 }, None).await {
                        Ok(_) => {
                            log_line!(
                                "mongo_connect",
                                "  connected (auth_source={})",
                                source.as_deref().unwrap_or("<none>")
                            );
                            return Ok(Self {
                                client,
                                default_db: cfg.database,
                                active_db: RwLock::new(None),
                            });
                        }
                        Err(e) => {
                            if is_auth_error(&e) {
                                log_line!(
                                    "mongo_connect",
                                    "  auth failed on source={}: {}",
                                    source.as_deref().unwrap_or("<none>"),
                                    e
                                );
                                last_err = Some(map_err(e));
                                continue;
                            }
                            log_line!("mongo_connect", "  ping failed: {}", e);
                            return Err(map_err(e));
                        }
                    }
                }
                Err(e) => {
                    log_line!("mongo_connect", "  client build failed: {}", e);
                    last_err = Some(e);
                }
            }
        }

        log_line!("mongo_connect", "  connect failed: {:?}", last_err);
        Err(last_err.unwrap_or_else(|| AdapterError::Connection("Mongo connect failed".to_string())))
    }

    pub async fn ping(&self) -> Result<ServerInfo, AdapterError> {
        let admin = self.client.database("admin");
        admin.run_command(doc! { "ping": 1 }, None).await.map_err(map_err)?;

        let build_info = admin.run_command(doc! { "buildInfo": 1 }, None).await.ok();
        let version = build_info
            .as_ref()
            .and_then(|d| d.get_str("version").ok())
            .unwrap_or("unknown")
            .to_string();

        let (major, minor) = parse_version(&version);
        Ok(ServerInfo {
            adapter_id: "mongo".to_string(),
            version,
            version_major: major,
            version_minor: minor,
            flavor: Some("MongoDB".to_string()),
            default_schema: self.default_db.clone(),
        })
    }

    pub async fn list_databases(&self) -> Result<Vec<String>, AdapterError> {
        self.client
            .list_database_names(None, None)
            .await
            .map_err(map_err)
    }

    pub async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AdapterError> {
        let dbs = self.list_databases().await?;
        // Per-DB `listCollections` is one network round-trip each. Running
        // them serially is an N+1 stall — on a remote cluster with many DBs it
        // dominates the post-connect "loading schemas" wait (a 30-DB cluster
        // pays 30 sequential RTTs). Fire them concurrently and join, so the
        // total cost is ~one round-trip regardless of DB count. The DB list is
        // already filtered to user DBs before we issue any collection query.
        // See the reconnect-latency audit.
        let user_dbs: Vec<String> = dbs
            .into_iter()
            .filter(|d| d != "admin" && d != "config" && d != "local")
            .collect();

        let futs = user_dbs.into_iter().map(|db_name| {
            let db = self.client.database(&db_name);
            async move {
                let collections = db.list_collection_names(None).await.map_err(map_err)?;
                let tables = collections
                    .into_iter()
                    .map(|name| TableInfo {
                        name,
                        kind: TableKind::Collection,
                        row_count: None,
                    })
                    .collect();
                Ok::<SchemaInfo, AdapterError>(SchemaInfo {
                    name: db_name,
                    tables,
                })
            }
        });

        // try_join_all preserves input order and short-circuits on the first
        // error, matching the previous serial behaviour's error semantics.
        futures::future::try_join_all(futs).await
    }

    pub async fn describe_schema(&self, schema: &str) -> Result<Vec<TableStructure>, AdapterError> {
        self.remember_db(schema);
        let db = self.client.database(schema);
        let collections = db.list_collection_names(None).await.map_err(map_err)?;
        let mut out = Vec::with_capacity(collections.len());
        for name in collections {
            out.push(self.describe_table(schema, &name).await?);
        }
        Ok(out)
    }

    pub async fn describe_table(&self, schema: &str, table: &str) -> Result<TableStructure, AdapterError> {
        let coll = self.collection(schema, table);

        let mut indexes: Vec<IndexInfo> = Vec::new();
        let mut indexed_fields = BTreeSet::new();
        let mut unique_fields = BTreeSet::new();

        let mut idx_cur = coll.list_indexes(None).await.map_err(map_err)?;
        while let Some(idx) = idx_cur.try_next().await.map_err(map_err)? {
            let name = idx
                .options
                .as_ref()
                .and_then(|o| o.name.clone())
                .unwrap_or_else(|| "index".to_string());
            let unique = idx.options.as_ref().and_then(|o| o.unique).unwrap_or(false);
            let cols: Vec<String> = idx
                .keys
                .iter()
                .map(|(field, value)| index_key_with_type(field, value))
                .collect();
            for (field, _) in idx.keys.iter() {
                indexed_fields.insert(field.clone());
                if unique {
                    unique_fields.insert(field.clone());
                }
            }
            indexes.push(IndexInfo {
                name,
                columns: cols,
                unique,
                // Mongo index kinds live per-field (asc/desc/text/2dsphere/…),
                // not as a single SQL-style method; the editor handles that
                // via the fields textbox, so leave the SQL algorithm unset.
                algorithm: None,
            });
        }

        let mut sampled = 0u64;
        let mut seen: BTreeMap<String, u64> = BTreeMap::new();
        let mut kind: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

        let opts = FindOptions::builder().limit(Some(200)).build();
        let mut cur = coll.find(doc! {}, opts).await.map_err(map_err)?;
        while let Some(doc) = cur.try_next().await.map_err(map_err)? {
            sampled += 1;
            for (k, v) in doc {
                *seen.entry(k.clone()).or_insert(0) += 1;
                kind.entry(k).or_default().insert(bson_type_name(&v).to_string());
            }
        }

        let mut columns: Vec<ColumnInfo> = seen
            .iter()
            .map(|(name, count)| {
                let types = kind
                    .get(name)
                    .map(|s| s.iter().cloned().collect::<Vec<_>>().join("|"))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "unknown".to_string());
                let nullable = if sampled == 0 { true } else { *count < sampled };
                let is_primary = name == "_id";
                ColumnInfo {
                    name: name.clone(),
                    data_type: types,
                    nullable,
                    default: None,
                    length: None,
                    is_primary,
                    is_unique: is_primary || unique_fields.contains(name),
                    is_foreign: false,
                    is_indexed: is_primary || indexed_fields.contains(name),
                    extra: String::new(),
                    character_set: None,
                    collation: None,
                }
            })
            .collect();

        columns.sort_by(|a, b| {
            if a.name == "_id" {
                std::cmp::Ordering::Less
            } else if b.name == "_id" {
                std::cmp::Ordering::Greater
            } else {
                a.name.cmp(&b.name)
            }
        });

        let row_count = coll.estimated_document_count(None).await.ok();

        Ok(TableStructure {
            schema: schema.to_string(),
            name: table.to_string(),
            kind: TableKind::Collection,
            columns,
            indexes,
            primary_key: vec!["_id".to_string()],
            foreign_keys: vec![],
            row_count,
        })
    }

    pub async fn browse(&self, req: BrowseRequest) -> Result<BrowseResult, AdapterError> {
        let t0 = Instant::now();
        let coll = self.collection(&req.schema, &req.table);
        let filter = filters_to_doc(&req.filters)?;

        let page = req.page.number.max(1);
        let size = req.page.size.max(1);
        let skip = ((page - 1) as u64) * (size as u64);

        let mut opts = FindOptions::default();
        opts.skip = Some(skip);
        opts.limit = Some(size as i64);
        // Honor the column projection: when the grid only displays a subset of
        // fields (e.g. the user hid the huge ones), fetch ONLY those over the
        // wire instead of pulling every field of every document. `_id` is
        // always included so row identity / edit / lazy full-doc fetch work.
        if !req.columns.is_empty() {
            let mut proj = Document::new();
            for c in &req.columns {
                proj.insert(c.clone(), Bson::Int32(1));
            }
            proj.insert("_id", Bson::Int32(1));
            opts.projection = Some(proj);
        }
        if !req.sort.is_empty() {
            let mut sort_doc = Document::new();
            for s in &req.sort {
                let dir = match s.direction {
                    SortDirection::Asc => 1,
                    SortDirection::Desc => -1,
                };
                sort_doc.insert(s.column.clone(), Bson::Int32(dir));
            }
            opts.sort = Some(sort_doc);
        }

        let mut cur = coll.find(filter.clone(), opts).await.map_err(map_err)?;
        let mut docs = Vec::new();
        while let Some(doc) = cur.try_next().await.map_err(map_err)? {
            docs.push(doc);
        }

        let columns = columns_from_docs(&docs);
        // Preview conversion: oversized field values are collapsed to a marker
        // so a page of huge documents stays small. The full value comes back
        // via `get_document` when the user opens the row.
        let rows = docs
            .iter()
            .map(|d| {
                columns
                    .iter()
                    .map(|c| bson_to_preview_json(d.get(c).unwrap_or(&Bson::Null)))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        // Counting is the slow part for large collections. An unfiltered
        // `count_documents({})` forces a full scan (it runs a `$group`
        // aggregation), which is why a 100-row page felt slow vs Compass.
        // When there's no filter, use `estimatedDocumentCount` — it reads the
        // collection's metadata count and returns instantly (this is what
        // Compass shows). Only pay for an accurate count when a filter narrows
        // the result, where an estimate would be wrong.
        let total = if req.include_total {
            if req.filters.is_empty() {
                coll.estimated_document_count(None).await.ok()
            } else {
                Some(coll.count_documents(filter, None).await.map_err(map_err)?)
            }
        } else {
            None
        };

        Ok(BrowseResult {
            columns: columns
                .iter()
                .map(|c| ColumnMeta {
                    name: c.clone(),
                    type_hint: "mixed".to_string(),
                })
                .collect(),
            rows,
            duration_ms: t0.elapsed().as_secs_f64() * 1000.0,
            page,
            total_records: total,
        })
    }

    /// Fetch ONE full document by its `_id`, untruncated. Backs the grid's
    /// "open row" / JSON-edit view: `browse` returns size-capped previews for
    /// huge documents, so when the user actually opens a row we fetch the
    /// complete document on demand. `id` is the JSON form of the `_id` the
    /// frontend already holds (a hex string for ObjectId, or a scalar).
    pub async fn get_document(
        &self,
        schema: &str,
        table: &str,
        id: &JsonValue,
    ) -> Result<Option<JsonValue>, AdapterError> {
        let coll = self.collection(schema, table);
        let filter = doc! { "_id": json_to_bson(id) };
        let found = coll.find_one(filter, None).await.map_err(map_err)?;
        Ok(found.map(|d| bson_to_json(&Bson::Document(d))))
    }

    pub async fn count_records(&self, req: CountRequest) -> Result<Option<u64>, AdapterError> {
        let coll = self.collection(&req.schema, &req.table);
        let filter = filters_to_doc(&req.filters)?;
        // Same trade-off as `browse`: an unfiltered exact count is a full scan,
        // so use the instant metadata estimate when there's no filter.
        let n = if req.filters.is_empty() {
            coll.estimated_document_count(None).await.map_err(map_err)?
        } else {
            coll.count_documents(filter, None).await.map_err(map_err)?
        };
        Ok(Some(n))
    }

    /// Live server + database stats for the connection "Information" dialog.
    /// Best-effort: a failed probe is skipped, not fatal. `schema` scopes the
    /// `dbStats` to the focused database.
    pub async fn server_details(
        &self,
        schema: Option<&str>,
    ) -> Result<Vec<ServerDetail>, AdapterError> {
        use mongodb::bson::doc;
        let mut out: Vec<ServerDetail> = Vec::new();
        let push = |out: &mut Vec<ServerDetail>, label: &str, value: String| {
            if !value.is_empty() {
                out.push(ServerDetail { label: label.into(), value });
            }
        };
        let as_f64 = |b: &Bson| -> Option<f64> {
            match b {
                Bson::Double(d) => Some(*d),
                Bson::Int32(i) => Some(*i as f64),
                Bson::Int64(i) => Some(*i as f64),
                _ => None,
            }
        };

        // Server version + uptime from buildInfo / serverStatus on admin.
        let admin = self.client.database("admin");
        if let Ok(bi) = admin.run_command(doc! { "buildInfo": 1 }, None).await {
            if let Ok(v) = bi.get_str("version") {
                push(&mut out, "Server version", v.to_string());
            }
        }
        if let Ok(ss) = admin.run_command(doc! { "serverStatus": 1 }, None).await {
            if let Some(secs) = ss.get("uptime").and_then(as_f64) {
                push(&mut out, "Uptime", human_duration(secs.max(0.0) as u64));
            }
            if let Ok(conns) = ss.get_document("connections") {
                if let Some(cur) = conns.get("current").and_then(as_f64) {
                    push(&mut out, "Active connections", (cur as i64).to_string());
                }
            }
            if let Ok(st) = ss.get_str("storageEngine").or_else(|_| {
                ss.get_document("storageEngine").and_then(|d| d.get_str("name"))
            }) {
                push(&mut out, "Storage engine", st.to_string());
            }
        }

        // Database-scoped stats via dbStats.
        if let Ok(db) = self.query_db(schema) {
            let name = db.name().to_string();
            if let Ok(stats) = db.run_command(doc! { "dbStats": 1 }, None).await {
                push(&mut out, "Database", name);
                if let Some(n) = stats.get("collections").and_then(as_f64) {
                    push(&mut out, "Collections", (n as i64).to_string());
                }
                if let Some(n) = stats.get("objects").and_then(as_f64) {
                    push(&mut out, "Documents", (n as i64).to_string());
                }
                if let Some(n) = stats.get("dataSize").and_then(as_f64) {
                    push(&mut out, "Data size", human_bytes(n.max(0.0) as u64));
                }
                if let Some(n) = stats.get("storageSize").and_then(as_f64) {
                    push(&mut out, "Storage size", human_bytes(n.max(0.0) as u64));
                }
                if let Some(n) = stats.get("indexes").and_then(as_f64) {
                    push(&mut out, "Indexes", (n as i64).to_string());
                }
                if let Some(n) = stats.get("indexSize").and_then(as_f64) {
                    push(&mut out, "Index size", human_bytes(n.max(0.0) as u64));
                }
            }
        }

        Ok(out)
    }

    pub fn collection(&self, schema: &str, table: &str) -> Collection<Document> {
        self.remember_db(schema);
        self.client.database(schema).collection::<Document>(table)
    }

    pub fn query_db<'a>(&'a self, schema: Option<&'a str>) -> Result<mongodb::Database, AdapterError> {
        if let Some(s) = schema {
            self.remember_db(s);
            return Ok(self.client.database(s));
        }
        if let Some(s) = self.default_db.as_deref() {
            self.remember_db(s);
            return Ok(self.client.database(s));
        }
        if let Some(s) = self.active_db() {
            log_line!("mongo_exec", "query_db fallback active_db={}", s);
            return Ok(self.client.database(&s));
        }
        Err(AdapterError::Connection(
            "No database selected. Set a default database in the connection profile, open a collection/table first, or use db.getSiblingDB('name').…"
                .to_string(),
        ))
    }

    pub async fn shutdown(&self) {}

    pub async fn process_list(&self) -> Result<Vec<adapter_api::ProcessInfo>, AdapterError> {
        use mongodb::bson::doc;
        let db = self.client.database("admin");
        let res = db.run_command(doc! { "currentOp": 1, "$all": true }, None).await.map_err(map_err)?;
        let inprog = res.get_array("inprog").map_err(|e| AdapterError::Other(e.to_string()))?;

        let mut processes = Vec::with_capacity(inprog.len());
        for op in inprog {
            let doc = match op.as_document() {
                Some(d) => d,
                None => continue,
            };
            let opid = match doc.get("opid") {
                Some(mongodb::bson::Bson::Int32(n)) => n.to_string(),
                Some(mongodb::bson::Bson::Int64(n)) => n.to_string(),
                Some(mongodb::bson::Bson::String(s)) => s.clone(),
                Some(other) => format!("{}", other),
                None => String::new(),
            };
            if opid.is_empty() {
                continue;
            }
            let ns = doc.get_str("ns").ok().map(|s| s.to_string());
            let op_type = doc.get_str("op").ok().unwrap_or("unknown");
            let secs_running = doc.get_i64("secs_running").ok().map(|s| s.max(0) as u64);
            let desc = doc.get_str("desc").ok().map(|s| s.to_string());

            let kind = match op_type {
                "query" | "getmore" => adapter_api::ProcessKind::Query,
                "none" => adapter_api::ProcessKind::Sleep,
                other => adapter_api::ProcessKind::Other(other.to_string()),
            };

            processes.push(adapter_api::ProcessInfo {
                id: opid,
                user: doc.get_str("user").ok().map(|s| s.to_string()),
                host: doc.get_str("client").ok().map(|s| s.to_string()),
                database: ns.and_then(|n| n.split('.').next().map(|s| s.to_string())),
                command: Some(op_type.to_string()),
                time: secs_running,
                state: doc.get_str("type").ok().map(|s| s.to_string()),
                info: desc,
                kind,
            });
        }

        Ok(processes)
    }

    pub async fn kill_process(&self, id: &str) -> Result<(), AdapterError> {
        use mongodb::bson::{Bson, doc};
        let op: Bson = if let Ok(n) = id.parse::<i64>() {
            Bson::Int64(n)
        } else {
            Bson::String(id.to_string())
        };
        let db = self.client.database("admin");
        db.run_command(doc! { "killOp": 1, "op": op }, None).await.map_err(map_err)?;
        Ok(())
    }

    fn remember_db(&self, schema: &str) {
        if schema.trim().is_empty() {
            return;
        }
        if let Ok(mut guard) = self.active_db.write() {
            *guard = Some(schema.to_string());
        }
    }

    fn active_db(&self) -> Option<String> {
        self.active_db.read().ok().and_then(|g| g.clone())
    }
}

#[derive(Debug, Clone)]
struct NormalizedAuth {
    user: String,
    password: String,
}

/// Strip `authMechanism=DEFAULT` from a Mongo URI. `DEFAULT` is a Compass/legacy
/// placeholder meaning "auto-negotiate", but the Rust driver rejects it with
/// "invalid mechanism string: DEFAULT". Removing it lets the driver pick SCRAM
/// on its own. Other params are left untouched.
fn sanitize_mongo_uri(uri: &str) -> String {
    let Some((base, query)) = uri.split_once('?') else {
        return uri.to_string();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|param| {
            let (k, v) = param.split_once('=').unwrap_or((*param, ""));
            !(k.eq_ignore_ascii_case("authMechanism") && v.eq_ignore_ascii_case("DEFAULT"))
        })
        .collect();
    if kept.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", kept.join("&"))
    }
}

/// Resolve which database to ping after connecting, never returning "".
/// Prefers the auth source, then the selected DB, then "admin", skipping any
/// blank candidate (Mongo rejects an empty database name with InvalidNamespace).
fn resolve_ping_db(source: Option<&str>, database: Option<&str>) -> String {
    source
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| database.map(str::to_string).filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| "admin".to_string())
}

fn normalized_auth_fields(cfg: &MongoConfig) -> Option<NormalizedAuth> {
    // A username is the trigger for auth. Password may be empty for some auth
    // setups, and a username-only profile should still attempt authentication
    // rather than connect anonymously (which fails later with the confusing
    // "command X requires authentication"). When the host is a full mongodb://
    // URI we skip this so the URI's own credentials are used as-is.
    if cfg.host.starts_with("mongodb://") || cfg.host.starts_with("mongodb+srv://") {
        return None;
    }
    let user = cfg.user.as_deref().map(str::trim).filter(|s| !s.is_empty())?;
    let pass = cfg.password.as_deref().map(str::trim).unwrap_or("");
    Some(NormalizedAuth {
        user: user.to_string(),
        password: pass.to_string(),
    })
}

async fn build_client(
    cfg: &MongoConfig,
    auth_source: Option<&str>,
    auth: Option<&NormalizedAuth>,
) -> Result<Client, AdapterError> {
    let mut opts = if cfg.host.starts_with("mongodb://") || cfg.host.starts_with("mongodb+srv://") {
        ClientOptions::parse(&sanitize_mongo_uri(&cfg.host)).await.map_err(map_err)?
    } else {
        let mut o = ClientOptions::default();
        o.hosts = vec![mongodb::options::ServerAddress::Tcp {
            host: cfg.host.clone(),
            port: Some(cfg.port),
        }];
        o
    };

    if let Some(auth) = auth {
        opts.credential = Some(
            Credential::builder()
                .username(Some(auth.user.clone()))
                .password(Some(auth.password.clone()))
                .source(auth_source.map(|s| s.to_string()))
                .build(),
        );
    } else if cfg.user.as_deref().map(str::trim).is_some_and(|s| !s.is_empty())
        || cfg
            .password
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty())
    {
        // Partial creds (username-only or password-only) are almost always
        // accidental carry-over from another driver profile. Skip them and
        // let URI creds or no-auth local Mongo work as expected.
        log_line!(
            "mongo_connect",
            "  partial credentials supplied (username/password mismatch), ignoring explicit credentials"
        );
    }

    if let Some(mode) = cfg.ssl_mode.as_deref() {
        let m = mode.to_ascii_lowercase();
        if m != "disable" {
            opts.tls = Some(mongodb::options::Tls::Enabled(Default::default()));
        }
    }

    // Bound connect/server-selection. The driver defaults are 10s connect and
    // a 30s server-selection window, so an unreachable/firewalled/paused host
    // hangs the connect call (and the upfront `ping`) for up to 30s with no
    // feedback. In URI mode, only set them if the URI didn't already specify
    // its own — explicit user values win. 5s fails fast while still tolerating
    // a brief replica-set election. See the reconnect-latency audit.
    if opts.connect_timeout.is_none() {
        opts.connect_timeout = Some(std::time::Duration::from_secs(5));
    }
    if opts.server_selection_timeout.is_none() {
        opts.server_selection_timeout = Some(std::time::Duration::from_secs(5));
    }

    opts.app_name = Some("Table Relay".to_string());
    Client::with_options(opts).map_err(map_err)
}

fn is_auth_error(e: &mongodb::error::Error) -> bool {
    let low = e.to_string().to_ascii_lowercase();
    low.contains("authentication") || low.contains("scram")
}

fn parse_version(v: &str) -> (Option<u32>, Option<u32>) {
    let mut it = v.split('.');
    let major = it.next().and_then(|s| s.parse::<u32>().ok());
    let minor = it.next().and_then(|s| s.parse::<u32>().ok());
    (major, minor)
}

pub(crate) fn columns_from_docs(docs: &[Document]) -> Vec<String> {
    let mut set = BTreeSet::new();
    for d in docs {
        for k in d.keys() {
            set.insert(k.to_string());
        }
    }
    let mut cols: Vec<String> = set.into_iter().collect();
    cols.sort_by(|a, b| {
        if a == "_id" {
            std::cmp::Ordering::Less
        } else if b == "_id" {
            std::cmp::Ordering::Greater
        } else {
            a.cmp(b)
        }
    });
    cols
}

pub(crate) fn filters_to_doc(filters: &[Filter]) -> Result<Document, AdapterError> {
    if filters.is_empty() {
        return Ok(doc! {});
    }
    let mut and_parts: Vec<Bson> = Vec::with_capacity(filters.len());
    for f in filters {
        let mut clause = Document::new();
        let key = f.column.clone();
        let cond = match f.op {
            FilterOp::Eq => f
                .value
                .as_ref()
                .map(json_to_bson)
                .unwrap_or(Bson::Null),
            FilterOp::NotEq => {
                let mut d = Document::new();
                d.insert("$ne", f.value.as_ref().map(json_to_bson).unwrap_or(Bson::Null));
                Bson::Document(d)
            }
            FilterOp::Lt => cmp_doc("$lt", f.value.as_ref())?,
            FilterOp::Lte => cmp_doc("$lte", f.value.as_ref())?,
            FilterOp::Gt => cmp_doc("$gt", f.value.as_ref())?,
            FilterOp::Gte => cmp_doc("$gte", f.value.as_ref())?,
            FilterOp::Contains => regex_doc(f.value.as_ref(), "")?,
            FilterOp::NotContains => {
                let mut d = Document::new();
                d.insert("$not", regex_doc(f.value.as_ref(), "")?);
                Bson::Document(d)
            }
            FilterOp::StartsWith => regex_doc(f.value.as_ref(), "^")?,
            FilterOp::EndsWith => regex_doc(f.value.as_ref(), "$")?,
            FilterOp::IsNull => {
                let mut d = Document::new();
                d.insert("$eq", Bson::Null);
                Bson::Document(d)
            }
            FilterOp::IsNotNull => {
                let mut d = Document::new();
                d.insert("$ne", Bson::Null);
                Bson::Document(d)
            }
            FilterOp::In => {
                let arr = ensure_array(f.value.as_ref())?;
                let mut d = Document::new();
                d.insert("$in", Bson::Array(arr));
                Bson::Document(d)
            }
            FilterOp::NotIn => {
                let arr = ensure_array(f.value.as_ref())?;
                let mut d = Document::new();
                d.insert("$nin", Bson::Array(arr));
                Bson::Document(d)
            }
        };
        clause.insert(key, cond);
        and_parts.push(Bson::Document(clause));
    }
    if and_parts.len() == 1 {
        if let Some(Bson::Document(d)) = and_parts.pop() {
            return Ok(d);
        }
    }
    Ok(doc! { "$and": and_parts })
}

fn ensure_array(v: Option<&JsonValue>) -> Result<Vec<Bson>, AdapterError> {
    match v {
        Some(JsonValue::Array(a)) => Ok(a.iter().map(json_to_bson).collect()),
        Some(other) => Ok(vec![json_to_bson(other)]),
        None => Err(AdapterError::Other("IN/NOT IN requires a value".to_string())),
    }
}

fn cmp_doc(op: &str, v: Option<&JsonValue>) -> Result<Bson, AdapterError> {
    let Some(v) = v else {
        return Err(AdapterError::Other(format!("{op} requires a value")));
    };
    let mut d = Document::new();
    d.insert(op, json_to_bson(v));
    Ok(Bson::Document(d))
}

fn regex_doc(v: Option<&JsonValue>, affix: &str) -> Result<Bson, AdapterError> {
    let Some(v) = v else {
        return Err(AdapterError::Other("regex filter requires a value".to_string()));
    };
    let text = match v {
        JsonValue::String(s) => s.clone(),
        _ => v.to_string(),
    };
    let pattern = match affix {
        "^" => format!("^{text}"),
        "$" => format!("{text}$"),
        _ => text,
    };
    let mut d = Document::new();
    d.insert("$regex", pattern);
    d.insert("$options", "i");
    Ok(Bson::Document(d))
}

pub(crate) fn bson_to_json(b: &Bson) -> JsonValue {
    match b {
        Bson::Null => JsonValue::Null,
        Bson::Boolean(v) => JsonValue::Bool(*v),
        Bson::Int32(v) => JsonValue::from(*v),
        Bson::Int64(v) => JsonValue::from(*v),
        Bson::Double(v) => JsonValue::from(*v),
        Bson::String(v) => JsonValue::from(v.clone()),
        Bson::DateTime(v) => JsonValue::from(v.to_string()),
        Bson::ObjectId(v) => JsonValue::from(v.to_hex()),
        Bson::Timestamp(v) => JsonValue::from(format!("{}:{}", v.time, v.increment)),
        Bson::Binary(v) => JsonValue::from(format!("<binary:{} bytes>", v.bytes.len())),
        Bson::Decimal128(v) => JsonValue::from(v.to_string()),
        Bson::RegularExpression(v) => JsonValue::from(format!("/{}/{}", v.pattern, v.options)),
        Bson::Array(arr) => JsonValue::Array(arr.iter().map(bson_to_json).collect()),
        Bson::Document(doc) => {
            let mut out = serde_json::Map::new();
            for (k, v) in doc {
                out.insert(k.clone(), bson_to_json(v));
            }
            JsonValue::Object(out)
        }
        _ => JsonValue::from(b.to_string()),
    }
}

/// Max serialized size (bytes) of a single top-level field value before the
/// browse preview replaces it with a lightweight placeholder. Huge Mongo
/// documents (MBs of nested arrays/blobs per doc) otherwise make a 50-row grid
/// page transfer hundreds of MB and serialize for seconds — even though the
/// grid only renders a collapsed cell. The full value is fetched on demand via
/// `get_document` when the user opens that row's JSON view. Compass does the
/// same trick (truncated cells, full doc on click).
const PREVIEW_FIELD_MAX_BYTES: usize = 16 * 1024;

/// BSON → JSON for a browse PREVIEW cell. Identical to `bson_to_json` for small
/// values, but any single field whose value serializes larger than
/// `PREVIEW_FIELD_MAX_BYTES` is collapsed to a marker object the frontend
/// recognizes (`{ __tableRelayPreview: true, … }`) and renders as a "open to
/// view" stub. Scalars are never truncated (they're cheap and the grid shows
/// them inline); only arrays/documents/binary — the things that get huge — are.
pub(crate) fn bson_to_preview_json(b: &Bson) -> JsonValue {
    match b {
        // Containers + binary are the only values that grow unbounded. Measure
        // their encoded size and stub them out past the cap.
        Bson::Array(_) | Bson::Document(_) | Bson::Binary(_) => {
            let full = bson_to_json(b);
            let approx = approx_json_bytes(&full);
            if approx > PREVIEW_FIELD_MAX_BYTES {
                preview_stub(b, approx)
            } else {
                full
            }
        }
        // Scalars: cheap, render inline, never truncated.
        _ => bson_to_json(b),
    }
}

/// A compact placeholder for an oversized field value. The frontend keys off
/// `__tableRelayPreview` to show a stub cell and lazy-load the full document.
fn preview_stub(b: &Bson, approx_bytes: usize) -> JsonValue {
    let (kind, extra): (&str, Option<usize>) = match b {
        Bson::Array(a) => ("array", Some(a.len())),
        Bson::Document(d) => ("object", Some(d.len())),
        Bson::Binary(bin) => ("binData", Some(bin.bytes.len())),
        _ => ("value", None),
    };
    let mut m = serde_json::Map::new();
    m.insert("__tableRelayPreview".to_string(), JsonValue::Bool(true));
    m.insert("kind".to_string(), JsonValue::from(kind));
    m.insert("approxBytes".to_string(), JsonValue::from(approx_bytes));
    if let Some(n) = extra {
        m.insert("count".to_string(), JsonValue::from(n));
    }
    JsonValue::Object(m)
}

/// Format a byte count as a human-readable size (e.g. `1.5 GB`).
fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if n < 1024 {
        return format!("{n} B");
    }
    let mut size = n as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    format!("{size:.1} {}", UNITS[unit])
}

/// Format a duration in seconds as `Xd Yh Zm` (or smaller units when short).
fn human_duration(secs: u64) -> String {
    let days = secs / 86_400;
    let hours = (secs % 86_400) / 3_600;
    let mins = (secs % 3_600) / 60;
    if days > 0 {
        format!("{days}d {hours}h {mins}m")
    } else if hours > 0 {
        format!("{hours}h {mins}m")
    } else if mins > 0 {
        format!("{mins}m {}s", secs % 60)
    } else {
        format!("{secs}s")
    }
}

/// Cheap upper-bound estimate of a JSON value's serialized byte length.
/// Avoids a full `serde_json::to_string` allocation just to measure size —
/// we only need to know whether it crosses the cap, and we short-circuit as
/// soon as it does so genuinely huge values cost O(cap), not O(value).
fn approx_json_bytes(v: &JsonValue) -> usize {
    fn walk(v: &JsonValue, acc: &mut usize, cap: usize) {
        if *acc > cap {
            return; // already over the threshold; stop measuring
        }
        match v {
            JsonValue::Null => *acc += 4,
            JsonValue::Bool(_) => *acc += 5,
            JsonValue::Number(_) => *acc += 8,
            JsonValue::String(s) => *acc += s.len() + 2,
            JsonValue::Array(a) => {
                *acc += 2;
                for item in a {
                    *acc += 1;
                    walk(item, acc, cap);
                    if *acc > cap {
                        return;
                    }
                }
            }
            JsonValue::Object(m) => {
                *acc += 2;
                for (k, val) in m {
                    *acc += k.len() + 4;
                    walk(val, acc, cap);
                    if *acc > cap {
                        return;
                    }
                }
            }
        }
    }
    let mut acc = 0usize;
    walk(v, &mut acc, PREVIEW_FIELD_MAX_BYTES);
    acc
}

pub(crate) fn json_to_bson(v: &JsonValue) -> Bson {
    match v {
        JsonValue::Null => Bson::Null,
        JsonValue::Bool(v) => Bson::Boolean(*v),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i32::try_from(i).is_ok() {
                    Bson::Int32(i as i32)
                } else {
                    Bson::Int64(i)
                }
            } else if let Some(f) = n.as_f64() {
                Bson::Double(f)
            } else {
                Bson::Null
            }
        }
        JsonValue::String(s) => {
            if s.len() == 24 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                if let Ok(oid) = ObjectId::parse_str(s) {
                    return Bson::ObjectId(oid);
                }
            }
            Bson::String(s.clone())
        }
        JsonValue::Array(arr) => Bson::Array(arr.iter().map(json_to_bson).collect()),
        JsonValue::Object(map) => {
            let mut d = Document::new();
            for (k, v) in map {
                d.insert(k, json_to_bson(v));
            }
            Bson::Document(d)
        }
    }
}

pub(crate) fn bson_type_name(v: &Bson) -> &'static str {
    match v {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::Int32(_) => "int32",
        Bson::Int64(_) => "int64",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Binary(_) => "binData",
        Bson::Timestamp(_) => "timestamp",
        Bson::Decimal128(_) => "decimal",
        Bson::RegularExpression(_) => "regex",
        _ => "unknown",
    }
}

fn index_key_with_type(field: &str, value: &Bson) -> String {
    if field == "$**" || field.ends_with(".$**") {
        return format!("{field}:wildcard");
    }
    let suffix = match value {
        Bson::Int32(-1) | Bson::Int64(-1) => Some("desc"),
        Bson::Double(d) if *d == -1.0 => Some("desc"),
        Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) => None,
        Bson::String(s) => match s.as_str() {
            "text" => Some("text"),
            "2dsphere" => Some("2dsphere"),
            "2d" => Some("2d"),
            "hashed" => Some("hashed"),
            other if !other.is_empty() => return format!("{field}:{other}"),
            _ => None,
        },
        _ => None,
    };
    match suffix {
        Some(t) => format!("{field}:{t}"),
        None => field.to_string(),
    }
}

pub(crate) fn map_err(e: mongodb::error::Error) -> AdapterError {
    let msg = e.to_string();
    let low = msg.to_ascii_lowercase();
    if low.contains("authentication") || low.contains("auth") {
        return AdapterError::Authentication(msg);
    }
    if low.contains("timed out") || low.contains("timeout") {
        return AdapterError::Timeout;
    }
    if low.contains("failed to resolve") || low.contains("connection") || low.contains("server selection") {
        return AdapterError::Connection(msg);
    }
    AdapterError::Other(msg)
}

pub(crate) fn parse_json_document(raw: &str) -> Result<Document, AdapterError> {
    let json: JsonValue = parse_json_value(raw, "document")?;
    match json_to_bson(&json) {
        Bson::Document(d) => Ok(d),
        _ => Err(AdapterError::Syntax {
            message: "Expected a JSON object".to_string(),
            line: None,
            column: None,
        }),
    }
}

pub(crate) fn parse_json_array(raw: &str) -> Result<Vec<Bson>, AdapterError> {
    let json: JsonValue = parse_json_value(raw, "array")?;
    match json_to_bson(&json) {
        Bson::Array(a) => Ok(a),
        _ => Err(AdapterError::Syntax {
            message: "Expected a JSON array".to_string(),
            line: None,
            column: None,
        }),
    }
}

fn parse_json_value(raw: &str, kind: &str) -> Result<JsonValue, AdapterError> {
    if let Ok(v) = serde_json::from_str::<JsonValue>(raw) {
        return Ok(v);
    }
    let normalized = normalize_mongo_shell_json(raw);
    serde_json::from_str(&normalized).map_err(|e| AdapterError::Syntax {
        message: format!("Invalid JSON {kind}: {e}"),
        line: None,
        column: None,
    })
}

/// Accept common Mongo shell object literal syntax:
/// - single-quoted strings
/// - unquoted object keys (`$lookup`, `localField`, ...)
fn normalize_mongo_shell_json(raw: &str) -> String {
    let with_double = single_to_double_quoted(raw);
    quote_unquoted_object_keys(&with_double)
}

fn single_to_double_quoted(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    let mut in_double = false;
    let mut in_single = false;
    let mut escaped = false;
    for ch in input.chars() {
        if in_single {
            if escaped {
                // Keep escaped characters as-is inside converted strings.
                out.push('\\');
                out.push(ch);
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '\'' => {
                    out.push('"');
                    in_single = false;
                }
                '"' => out.push_str("\\\""),
                _ => out.push(ch),
            }
            continue;
        }
        if in_double {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_double = false;
            }
            continue;
        }

        match ch {
            '\'' => {
                out.push('"');
                in_single = true;
            }
            '"' => {
                out.push('"');
                in_double = true;
            }
            _ => out.push(ch),
        }
    }
    out
}

fn quote_unquoted_object_keys(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len() + 8);
    let mut i = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    // Stack tracks if current `{}` scope expects a key next (after `{` or `,`).
    let mut obj_expect_key: Vec<bool> = Vec::new();

    while i < chars.len() {
        let ch = chars[i];
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
                i += 1;
            }
            '{' => {
                obj_expect_key.push(true);
                out.push(ch);
                i += 1;
            }
            '}' => {
                obj_expect_key.pop();
                out.push(ch);
                i += 1;
            }
            ',' => {
                if let Some(top) = obj_expect_key.last_mut() {
                    *top = true;
                }
                out.push(ch);
                i += 1;
            }
            ':' => {
                if let Some(top) = obj_expect_key.last_mut() {
                    *top = false;
                }
                out.push(ch);
                i += 1;
            }
            c if c.is_whitespace() => {
                out.push(c);
                i += 1;
            }
            c if obj_expect_key.last().copied().unwrap_or(false)
                && (c.is_ascii_alphabetic() || c == '_' || c == '$') =>
            {
                let start = i;
                i += 1;
                while i < chars.len() {
                    let t = chars[i];
                    if t.is_ascii_alphanumeric() || t == '_' || t == '$' {
                        i += 1;
                    } else {
                        break;
                    }
                }

                let mut j = i;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && chars[j] == ':' {
                    let key: String = chars[start..i].iter().collect();
                    out.push('"');
                    out.push_str(&key);
                    out.push('"');
                    if let Some(top) = obj_expect_key.last_mut() {
                        *top = false;
                    }
                } else {
                    for c2 in &chars[start..i] {
                        out.push(*c2);
                    }
                }
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }

    out
}

#[cfg(test)]
mod sanitize_uri_tests {
    use super::sanitize_mongo_uri;

    #[test]
    fn strips_authmechanism_default() {
        assert_eq!(
            sanitize_mongo_uri("mongodb://u:p@h/db?authMechanism=DEFAULT"),
            "mongodb://u:p@h/db"
        );
        assert_eq!(
            sanitize_mongo_uri("mongodb://u:p@h/db?authSource=admin&authMechanism=DEFAULT"),
            "mongodb://u:p@h/db?authSource=admin"
        );
        assert_eq!(
            sanitize_mongo_uri("mongodb://u:p@h/db?authMechanism=DEFAULT&retryWrites=true"),
            "mongodb://u:p@h/db?retryWrites=true"
        );
    }

    #[test]
    fn keeps_real_mechanism_and_no_query() {
        assert_eq!(
            sanitize_mongo_uri("mongodb://h/db?authMechanism=SCRAM-SHA-256"),
            "mongodb://h/db?authMechanism=SCRAM-SHA-256"
        );
        assert_eq!(sanitize_mongo_uri("mongodb://h/db"), "mongodb://h/db");
    }
}

#[cfg(test)]
mod ping_db_tests {
    use super::resolve_ping_db;

    #[test]
    fn falls_back_to_admin_when_all_blank() {
        // The bug: a URI with no database path (`/?authMechanism=DEFAULT`) left
        // both source and database empty, producing a ping against "".
        assert_eq!(resolve_ping_db(None, None), "admin");
        assert_eq!(resolve_ping_db(Some(""), Some("")), "admin");
        assert_eq!(resolve_ping_db(Some("  "), None), "admin");
    }

    #[test]
    fn prefers_source_then_database() {
        assert_eq!(resolve_ping_db(Some("admin"), Some("app")), "admin");
        assert_eq!(resolve_ping_db(None, Some("app")), "app");
        assert_eq!(resolve_ping_db(Some(""), Some("app")), "app");
    }
}

#[cfg(test)]
mod index_key_tests {
    use super::index_key_with_type;
    use mongodb::bson::Bson;

    #[test]
    fn ascending_emits_bare_field() {
        assert_eq!(index_key_with_type("name", &Bson::Int32(1)), "name");
        assert_eq!(index_key_with_type("name", &Bson::Int64(1)), "name");
        assert_eq!(index_key_with_type("name", &Bson::Double(1.0)), "name");
    }

    #[test]
    fn descending_emits_desc_suffix() {
        assert_eq!(index_key_with_type("createdAt", &Bson::Int32(-1)), "createdAt:desc");
        assert_eq!(index_key_with_type("createdAt", &Bson::Double(-1.0)), "createdAt:desc");
    }

    #[test]
    fn special_kinds_round_trip() {
        assert_eq!(index_key_with_type("loc", &Bson::String("2dsphere".into())), "loc:2dsphere");
        assert_eq!(index_key_with_type("loc", &Bson::String("2d".into())), "loc:2d");
        assert_eq!(index_key_with_type("body", &Bson::String("text".into())), "body:text");
        assert_eq!(index_key_with_type("uid", &Bson::String("hashed".into())), "uid:hashed");
    }

    #[test]
    fn wildcard_path_is_tagged() {
        assert_eq!(index_key_with_type("$**", &Bson::Int32(1)), "$**:wildcard");
        assert_eq!(index_key_with_type("attrs.$**", &Bson::Int32(1)), "attrs.$**:wildcard");
    }

    #[test]
    fn unknown_string_kind_is_surfaced_not_dropped() {
        assert_eq!(index_key_with_type("g", &Bson::String("geoHaystack".into())), "g:geoHaystack");
    }
}

#[cfg(test)]
mod preview_tests {
    use super::{bson_to_preview_json, PREVIEW_FIELD_MAX_BYTES};
    use mongodb::bson::{Bson, Document};
    use serde_json::Value as JsonValue;

    fn is_stub(v: &JsonValue) -> bool {
        v.get("__tableRelayPreview")
            .and_then(|b| b.as_bool())
            .unwrap_or(false)
    }

    #[test]
    fn small_values_pass_through_untruncated() {
        // Scalars and small containers are returned verbatim.
        assert_eq!(bson_to_preview_json(&Bson::Int32(7)), JsonValue::from(7));
        assert_eq!(
            bson_to_preview_json(&Bson::String("hi".into())),
            JsonValue::from("hi")
        );
        let small = Bson::Array(vec![Bson::Int32(1), Bson::Int32(2), Bson::Int32(3)]);
        let out = bson_to_preview_json(&small);
        assert!(!is_stub(&out));
        assert_eq!(out.as_array().map(|a| a.len()), Some(3));
    }

    #[test]
    fn oversized_array_is_collapsed_to_stub() {
        // A big string array easily clears the 16KB cap.
        let big: Vec<Bson> = (0..5000)
            .map(|i| Bson::String(format!("element-number-{i}-with-some-padding")))
            .collect();
        let count = big.len();
        let out = bson_to_preview_json(&Bson::Array(big));
        assert!(is_stub(&out), "huge array should become a stub");
        assert_eq!(out.get("kind").and_then(|k| k.as_str()), Some("array"));
        assert_eq!(
            out.get("count").and_then(|c| c.as_u64()),
            Some(count as u64)
        );
        assert!(
            out.get("approxBytes").and_then(|b| b.as_u64()).unwrap_or(0)
                > PREVIEW_FIELD_MAX_BYTES as u64
        );
    }

    #[test]
    fn oversized_document_is_collapsed_to_stub() {
        let mut d = Document::new();
        for i in 0..2000 {
            d.insert(format!("field_{i}"), Bson::String("x".repeat(20)));
        }
        let out = bson_to_preview_json(&Bson::Document(d));
        assert!(is_stub(&out));
        assert_eq!(out.get("kind").and_then(|k| k.as_str()), Some("object"));
    }

    #[test]
    fn scalar_string_never_truncated_even_if_long() {
        // A long top-level scalar string is cheap to render inline; only the
        // unbounded container/binary kinds get collapsed.
        let long = Bson::String("a".repeat(PREVIEW_FIELD_MAX_BYTES * 2));
        let out = bson_to_preview_json(&long);
        assert!(!is_stub(&out));
        assert!(out.is_string());
    }
}
