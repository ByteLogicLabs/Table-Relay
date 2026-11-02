//! `Adapter::mutate` for the MySQL adapter. Dispatches on `MutateRequest`
//! to Insert / Update / Delete paths.

use adapter_api::{AdapterError, MutateRequest, Mutation, PrimaryKeyValue};
use adapter_api::log_line;

use crate::mysql::{bind_json, quote_ident};
use crate::MysqlDriver;

pub(crate) async fn mutate(
    driver: &MysqlDriver,
    req: MutateRequest,
) -> Result<Mutation, AdapterError> {
    match req {
        MutateRequest::Insert { schema, table, values } => {
            insert(driver, &schema, &table, values).await
        }
        MutateRequest::Update { schema, table, primary_key, changes } => {
            let rows = driver.update_rows(&schema, &table, &primary_key, &changes).await?;
            Ok(Mutation {
                records_affected: rows,
                generated_primary_key: None,
            })
        }
        MutateRequest::Delete { schema, table, primary_key } => {
            delete(driver, &schema, &table, &primary_key).await
        }
    }
}

async fn insert(
    driver: &MysqlDriver,
    schema: &str,
    table: &str,
    values: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<Mutation, AdapterError> {
    let mut sql = String::from("INSERT INTO ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));
    if values.is_empty() {
        // All-default insert.
        sql.push_str(" () VALUES ()");
    } else {
        sql.push_str(" (");
        for (i, col) in values.keys().enumerate() {
            if i > 0 { sql.push_str(", "); }
            sql.push_str(&quote_ident(col));
        }
        sql.push_str(") VALUES (");
        for i in 0..values.len() {
            if i > 0 { sql.push_str(", "); }
            sql.push('?');
        }
        sql.push(')');
    }

    log_line!("mutate.insert", "{}.{} cols={}", schema, table, values.len());

    let mut q = sqlx::query(&sql);
    for v in values.values() {
        q = bind_json(q, v);
    }
    let res = q.execute(&driver.pool).await.map_err(AdapterError::from)?;

    // MySQL exposes the generated auto-increment id via `last_insert_id()`
    // on the result. We don't know the PK column name here (would need
    // describe_table), so surface it under a generic `__insert_id` key that
    // callers can interpret. If the target table has a named auto-increment
    // PK, the caller can re-fetch with describe_table to resolve it.
    let mut generated = std::collections::BTreeMap::new();
    if res.last_insert_id() > 0 {
        generated.insert(
            "__insert_id".to_string(),
            serde_json::Value::from(res.last_insert_id()),
        );
    }

    Ok(Mutation {
        records_affected: res.rows_affected(),
        generated_primary_key: if generated.is_empty() { None } else { Some(generated) },
    })
}

async fn delete(
    driver: &MysqlDriver,
    schema: &str,
    table: &str,
    primary_key: &[PrimaryKeyValue],
) -> Result<Mutation, AdapterError> {
    if primary_key.is_empty() {
        return Err(AdapterError::Unsupported(
            "delete requires a primary key on the target row".into(),
        ));
    }

    let mut sql = String::from("DELETE FROM ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));
    sql.push_str(" WHERE ");
    for (i, pk) in primary_key.iter().enumerate() {
        if i > 0 { sql.push_str(" AND "); }
        sql.push_str(&quote_ident(&pk.column));
        sql.push_str(" = ?");
    }

    log_line!(
        "mutate.delete",
        "{}.{} pk_cols={}",
        schema,
        table,
        primary_key.len(),
    );

    let mut q = sqlx::query(&sql);
    for pk in primary_key {
        q = bind_json(q, &pk.value);
    }
    let res = q.execute(&driver.pool).await.map_err(AdapterError::from)?;

    Ok(Mutation {
        records_affected: res.rows_affected(),
        generated_primary_key: None,
    })
}
