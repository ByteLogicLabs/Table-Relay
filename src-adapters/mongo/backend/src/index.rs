// Structured index management for MongoDB. The host frontend's schema
// editor sends a single `ModifyIndexesRequest` per save; we apply the
// drops first, then the creates. Failures short-circuit — partial state
// is left in place and surfaced verbatim to the user, matching how
// `mutate` handles errors.
//
// Why drop-then-create order: re-creating an index with the same name as
// one being dropped would otherwise race; doing drops first lets the
// user "edit" an existing index by deleting it and adding it back.

use adapter_api::{AdapterError, IndexKeyValue, ModifyIndexesRequest};
use mongodb::bson::{Bson, Document};
use mongodb::options::{CreateIndexOptions, IndexOptions};
use mongodb::IndexModel;

use crate::mongo::map_err;
use crate::MongoDriver;

/// Translate a user-typed wildcard path into Mongo's canonical `$**`
/// shape. `*` or empty → `$**` (whole-doc), `path.*` → `path.$**`,
/// `path` → `path.$**`. Already-canonical paths are returned unchanged.
fn wildcard_path(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() || s == "*" {
        return "$**".to_string();
    }
    if s == "$**" || s.ends_with(".$**") {
        return s.to_string();
    }
    if let Some(prefix) = s.strip_suffix(".*") {
        return format!("{prefix}.$**");
    }
    format!("{s}.$**")
}

fn is_index_not_found(e: &mongodb::error::Error) -> bool {
    if let mongodb::error::ErrorKind::Command(cmd) = e.kind.as_ref() {
        if cmd.code == 27 {
            return true;
        }
    }
    let low = e.to_string().to_ascii_lowercase();
    low.contains("indexnotfound") || low.contains("index not found")
}

pub(crate) async fn modify_indexes(
    driver: &MongoDriver,
    req: ModifyIndexesRequest,
) -> Result<(), AdapterError> {
    let coll = driver.collection(&req.schema, &req.table);

    // Drops first. Skip the auto-managed `_id_` index defensively — the
    // server rejects dropping it with a `cannot drop _id index` error
    // that's more confusing than helpful when the UI sends a stale name.
    for name in &req.drop {
        if name == "_id_" || name.is_empty() {
            continue;
        }
        if let Err(e) = coll.drop_index(name, None).await {
            if is_index_not_found(&e) {
                continue;
            }
            return Err(map_err(e));
        }
    }

    // Creates. Each field carries its own key value (Compass-style), so a
    // compound index can mix asc/desc with one special key (e.g.
    // `{ region: 1, location: "2dsphere" }`). Server-side rules apply:
    // text+unique is rejected, multi-key hashed is rejected, etc. We
    // pre-check the obvious cross-field constraints and let the driver
    // surface anything else.
    for spec in &req.create {
        if spec.columns.is_empty() {
            return Err(AdapterError::Other(
                "Index must specify at least one field".to_string(),
            ));
        }

        // Pre-flight: text + unique isn't allowed on the server. Compass
        // greys out the option; we surface upfront for clarity.
        let has_text = spec
            .columns
            .iter()
            .any(|c| matches!(c.direction.unwrap_or_default(), IndexKeyValue::Text));
        if spec.unique && has_text {
            return Err(AdapterError::Other(
                "Text indexes cannot be unique".to_string(),
            ));
        }
        let has_wildcard = spec
            .columns
            .iter()
            .any(|c| matches!(c.direction.unwrap_or_default(), IndexKeyValue::Wildcard));
        if spec.unique && has_wildcard {
            return Err(AdapterError::Other(
                "Wildcard indexes cannot be unique".to_string(),
            ));
        }

        let mut keys = Document::new();
        for col in &spec.columns {
            let kv = col.direction.unwrap_or_default();
            match kv {
                IndexKeyValue::Asc => {
                    keys.insert(&col.name, Bson::Int32(1));
                }
                IndexKeyValue::Desc => {
                    keys.insert(&col.name, Bson::Int32(-1));
                }
                IndexKeyValue::Text => {
                    keys.insert(&col.name, Bson::String("text".to_string()));
                }
                IndexKeyValue::TwoDSphere => {
                    keys.insert(&col.name, Bson::String("2dsphere".to_string()));
                }
                IndexKeyValue::TwoD => {
                    keys.insert(&col.name, Bson::String("2d".to_string()));
                }
                IndexKeyValue::Hashed => {
                    keys.insert(&col.name, Bson::String("hashed".to_string()));
                }
                IndexKeyValue::Wildcard => {
                    // Wildcard rewrites the field name to its `$**` path;
                    // the value side is just `1`.
                    keys.insert(wildcard_path(&col.name), Bson::Int32(1));
                }
            }
        }

        let mut opts = IndexOptions::builder().build();
        if spec.unique {
            opts.unique = Some(true);
        }
        if let Some(name) = spec.name.as_deref() {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                opts.name = Some(trimmed.to_string());
            }
        }
        let model = IndexModel::builder().keys(keys).options(opts).build();
        coll.create_index(model, CreateIndexOptions::default())
            .await
            .map_err(map_err)?;
    }
    Ok(())
}
