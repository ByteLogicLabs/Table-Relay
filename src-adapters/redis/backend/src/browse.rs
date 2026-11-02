//! `Adapter::browse` + `count_records` for Redis.
//!
//! Redis has no server-side filter/sort/pagination primitive that
//! matches the `BrowseRequest` vocabulary, so the implementation is
//! deliberately simple:
//!
//!   1. Pick the target DB from the schema name (`db0` … `db15`).
//!   2. SCAN the keyspace, ignore keys whose TYPE doesn't match the
//!      virtual table (hash/list/set/zset/string/stream), buffer the
//!      first `page.number * page.size` matches, slice out the page.
//!   3. For each key, pull its value with the type-appropriate read
//!      and fan out into synthetic rows.
//!
//! The adapter manifest declares `server_filter = false` and
//! `server_sort = false`, so the UI hides those controls for Redis
//! connections. Filters passed in spite of that are ignored.

use std::time::Instant;

use adapter_api::log_line;
use adapter_api::{
    AdapterError, BrowseRequest, BrowseResult, ColumnMeta, CountRequest,
};
use redis::aio::MultiplexedConnection;
use redis::Value;
use serde_json::Value as JsonValue;

use crate::redis::{
    ensure_virtual_table, map_err, parse_db_name, synthetic_columns_for, value_to_json,
    virtual_table_to_redis_type, DEFAULT_SCAN_COUNT,
};
use crate::RedisDriver;

pub(crate) async fn browse(
    driver: &RedisDriver,
    req: BrowseRequest,
) -> Result<BrowseResult, AdapterError> {
    let t_total = Instant::now();
    let db = parse_db_name(&req.schema)?;
    ensure_virtual_table(&req.table)?;
    let target_type = virtual_table_to_redis_type(&req.table);

    let page_number = req.page.number.max(1);
    let page_size = req.page.size.max(1);
    let want = (page_number as u64) * (page_size as u64);

    let mut conn = driver.conn.lock().await;
    redis::cmd("SELECT")
        .arg(db)
        .query_async::<()>(&mut *conn)
        .await
        .map_err(map_err)?;

    // Collect matching keys until we have enough for the requested
    // page OR SCAN reports cursor=0 (end). Buffering the prefix is
    // O(page * size) in memory; fine for UI grids.
    let mut keys: Vec<String> = Vec::new();
    let mut total_scanned: u64 = 0;
    let mut cursor: u64 = 0;
    loop {
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(DEFAULT_SCAN_COUNT)
            .query_async(&mut *conn)
            .await
            .map_err(map_err)?;
        cursor = next;
        for k in batch {
            total_scanned += 1;
            let t: String = redis::cmd("TYPE")
                .arg(&k)
                .query_async(&mut *conn)
                .await
                .map_err(map_err)?;
            if t == target_type {
                keys.push(k);
                if keys.len() as u64 >= want && !req.include_total {
                    // Have enough for the current page; no need to keep
                    // scanning unless the caller asked for a total.
                    break;
                }
            }
        }
        if cursor == 0 || (keys.len() as u64 >= want && !req.include_total) {
            break;
        }
    }

    // Slice the page.
    let offset = ((page_number as u64) - 1) * (page_size as u64);
    let end = offset.saturating_add(page_size as u64);
    let page_keys: &[String] = if (offset as usize) >= keys.len() {
        &[]
    } else {
        let end_idx = (end as usize).min(keys.len());
        &keys[(offset as usize)..end_idx]
    };

    // Build rows. Row layout depends on the virtual table — one key →
    // many rows for hashes (one per field), lists (one per index), sets
    // (one per member), zsets (one per member). Strings/streams produce
    // a single row per key.
    let mut rows: Vec<Vec<JsonValue>> = Vec::new();
    for key in page_keys {
        let ttl = fetch_ttl(&mut conn, key).await;
        match req.table.as_str() {
            "strings" => {
                let value: Value = redis::cmd("GET").arg(key).query_async(&mut *conn).await.map_err(map_err)?;
                rows.push(vec![JsonValue::String(key.clone()), value_to_json(&value), ttl]);
            }
            "hashes" => {
                let pairs: Vec<(String, Value)> = redis::cmd("HGETALL").arg(key).query_async(&mut *conn).await.map_err(map_err)?;
                for (field, val) in pairs {
                    rows.push(vec![
                        JsonValue::String(key.clone()),
                        JsonValue::String(field),
                        value_to_json(&val),
                        ttl.clone(),
                    ]);
                }
            }
            "lists" => {
                let items: Vec<Value> = redis::cmd("LRANGE").arg(key).arg(0).arg(-1).query_async(&mut *conn).await.map_err(map_err)?;
                for (idx, val) in items.iter().enumerate() {
                    rows.push(vec![
                        JsonValue::String(key.clone()),
                        JsonValue::from(idx as i64),
                        value_to_json(val),
                        ttl.clone(),
                    ]);
                }
            }
            "sets" => {
                let members: Vec<Value> = redis::cmd("SMEMBERS").arg(key).query_async(&mut *conn).await.map_err(map_err)?;
                for m in members {
                    rows.push(vec![JsonValue::String(key.clone()), value_to_json(&m), ttl.clone()]);
                }
            }
            "zsets" => {
                // ZRANGE .. WITHSCORES returns interleaved member/score.
                let raw: Vec<Value> = redis::cmd("ZRANGE").arg(key).arg(0).arg(-1).arg("WITHSCORES").query_async(&mut *conn).await.map_err(map_err)?;
                let mut i = 0;
                while i + 1 < raw.len() {
                    let member = value_to_json(&raw[i]);
                    let score = value_to_json(&raw[i + 1]);
                    rows.push(vec![JsonValue::String(key.clone()), member, score, ttl.clone()]);
                    i += 2;
                }
            }
            "streams" => {
                // XRANGE <key> - +  returns entries as [id, [f1, v1, f2, v2, ...]].
                let raw: Value = redis::cmd("XRANGE").arg(key).arg("-").arg("+").query_async(&mut *conn).await.map_err(map_err)?;
                if let Value::Array(entries) = raw {
                    for entry in entries {
                        if let Value::Array(pair) = entry {
                            if pair.len() >= 2 {
                                let id = value_to_json(&pair[0]);
                                let fields = value_to_json(&pair[1]);
                                rows.push(vec![
                                    JsonValue::String(key.clone()),
                                    id,
                                    fields,
                                    ttl.clone(),
                                ]);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // Restore default DB so unrelated follow-ups aren't surprised by
    // an unexpected SELECT state.
    redis::cmd("SELECT")
        .arg(driver.default_db)
        .query_async::<()>(&mut *conn)
        .await
        .map_err(map_err)?;

    // Column meta matches the synthetic shape used elsewhere.
    let columns: Vec<ColumnMeta> = synthetic_columns_for(&req.table)
        .into_iter()
        .map(|c| ColumnMeta { name: c.name, type_hint: c.data_type })
        .collect();

    let total_records = if req.include_total {
        Some(keys.len() as u64)
    } else {
        None
    };

    let duration_ms = t_total.elapsed().as_secs_f64() * 1000.0;
    log_line!(
        "redis_browse",
        "{}.{} page={} size={} → {} rows (scanned {}, type-matches {}, {:.1}ms)",
        req.schema,
        req.table,
        page_number,
        page_size,
        rows.len(),
        total_scanned,
        keys.len(),
        duration_ms,
    );

    Ok(BrowseResult {
        columns,
        rows,
        duration_ms,
        page: page_number,
        total_records,
    })
}

pub(crate) async fn count_records(
    driver: &RedisDriver,
    req: CountRequest,
) -> Result<Option<u64>, AdapterError> {
    let db = parse_db_name(&req.schema)?;
    ensure_virtual_table(&req.table)?;
    let target_type = virtual_table_to_redis_type(&req.table);

    let mut conn = driver.conn.lock().await;
    redis::cmd("SELECT")
        .arg(db)
        .query_async::<()>(&mut *conn)
        .await
        .map_err(map_err)?;

    let mut cursor: u64 = 0;
    let mut total: u64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(DEFAULT_SCAN_COUNT)
            .query_async(&mut *conn)
            .await
            .map_err(map_err)?;
        cursor = next;
        for k in &keys {
            let t: String = redis::cmd("TYPE")
                .arg(k)
                .query_async(&mut *conn)
                .await
                .map_err(map_err)?;
            if t == target_type {
                total += 1;
            }
        }
        if cursor == 0 {
            break;
        }
    }

    redis::cmd("SELECT")
        .arg(driver.default_db)
        .query_async::<()>(&mut *conn)
        .await
        .map_err(map_err)?;

    Ok(Some(total))
}

/// `TTL <key>` returns seconds-until-expiry; -1 = persistent, -2 = missing.
/// Surface -1/-2 as JSON nulls so the grid shows them as empty rather
/// than as magic numbers that look like dates.
async fn fetch_ttl(conn: &mut MultiplexedConnection, key: &str) -> JsonValue {
    match redis::cmd("TTL")
        .arg(key)
        .query_async::<i64>(&mut *conn)
        .await
    {
        Ok(t) if t >= 0 => JsonValue::from(t),
        _ => JsonValue::Null,
    }
}
