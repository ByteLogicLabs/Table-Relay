//! `Adapter::mutate` for Redis. Only DELETE by key is supported in
//! the first cut — INSERT and UPDATE would require per-type branching
//! (which field of which hash? which index of which list?) that the
//! generic `MutateRequest::Insert { values }` shape doesn't carry.
//! The user's escape hatch is the query editor: `HSET key f v`, `LPUSH
//! k v`, etc. all go through `execute_raw`.

use adapter_api::{AdapterError, MutateRequest, Mutation, PrimaryKeyValue};

use crate::redis::{map_err, parse_db_name};
use crate::RedisDriver;

pub(crate) async fn mutate(
    driver: &RedisDriver,
    req: MutateRequest,
) -> Result<Mutation, AdapterError> {
    match req {
        MutateRequest::Delete { schema, table: _, primary_key } => {
            let db = parse_db_name(&schema)?;
            // Redis DEL is a single shot over any number of keys. The
            // grid supplies each key as a PrimaryKeyValue; we pull the
            // literal string out and splat them into one command.
            let keys: Vec<String> = primary_key
                .iter()
                .filter_map(pk_to_string)
                .collect();
            if keys.is_empty() {
                return Err(AdapterError::Unsupported(
                    "delete requires at least one key".into(),
                ));
            }

            let mut conn = driver.conn.lock().await;
            redis::cmd("SELECT")
                .arg(db)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(map_err)?;
            let deleted: u64 = {
                let mut cmd = redis::cmd("DEL");
                for k in &keys {
                    cmd.arg(k.as_str());
                }
                cmd.query_async(&mut *conn).await.map_err(map_err)?
            };
            redis::cmd("SELECT")
                .arg(driver.default_db)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(map_err)?;

            Ok(Mutation {
                records_affected: deleted,
                generated_primary_key: None,
            })
        }
        MutateRequest::Insert { .. } => Err(AdapterError::Unsupported(
            "Redis insert must go through the query editor (SET / HSET / LPUSH / …)".into(),
        )),
        MutateRequest::Update { .. } => Err(AdapterError::Unsupported(
            "Redis update must go through the query editor (SET / HSET / …)".into(),
        )),
    }
}

/// Coerce a `PrimaryKeyValue` whose column is `"key"` into its string
/// payload. Numbers are stringified; anything else falls through to
/// `None` and the caller treats it as "no valid key selected".
fn pk_to_string(pk: &PrimaryKeyValue) -> Option<String> {
    use serde_json::Value;
    // Only the `key` column identifies a Redis key; the synthetic
    // `field` / `index` / `member` columns on composite-typed virtual
    // tables are addressing *within* a key and don't identify a row
    // the adapter can delete on its own. We pick `key` out here and
    // ignore the rest — DEL is key-level.
    if !pk.column.eq_ignore_ascii_case("key") {
        return None;
    }
    match &pk.value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}
