//! `Adapter::execute_raw` — thin wrapper that unlocks the connection
//! and hands off to the batch runner in `redis.rs`.

use adapter_api::{AdapterError, QueryResult};

use crate::redis::run_redis_commands;
use crate::RedisDriver;

pub(crate) async fn execute_raw(
    driver: &RedisDriver,
    command: &str,
    _row_limit: Option<u32>,
) -> Result<QueryResult, AdapterError> {
    let mut conn = driver.conn.lock().await;
    run_redis_commands(&mut conn, command).await
}
