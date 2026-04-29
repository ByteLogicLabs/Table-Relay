//! `Adapter::mutate` for the SQLite adapter. Dispatches on `MutateRequest`
//! to Insert / Update / Delete.

use adapter_api::log_line;
use adapter_api::{AdapterError, MutateRequest, Mutation, PrimaryKeyValue};

use crate::SqliteDriver;
use crate::sqlite::{bind_json, quote_ident};

pub(crate) async fn mutate(
    driver: &SqliteDriver,
    req: MutateRequest,
) -> Result<Mutation, AdapterError> {
    match req {
        MutateRequest::Insert { schema, table, values } => {
            ensure_main(&schema)?;
            insert(driver, &table, values).await
        }
        MutateRequest::Update { schema, table, primary_key, changes } => {
            let rows = driver
                .update_rows(&schema, &table, &primary_key, &changes)
                .await?;
            Ok(Mutation {
                records_affected: rows,
                generated_primary_key: None,
            })
        }
        MutateRequest::Delete { schema, table, primary_key } => {
            ensure_main(&schema)?;
            delete(driver, &table, &primary_key).await
        }
    }
}

fn ensure_main(schema: &str) -> Result<(), AdapterError> {
    if schema.is_empty() || schema.eq_ignore_ascii_case("main") {
        Ok(())
    } else {
        Err(AdapterError::NotFound(format!(
            "SQLite adapter only exposes the `main` schema; got `{schema}`"
        )))
    }
}

async fn insert(
    driver: &SqliteDriver,
    table: &str,
    values: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<Mutation, AdapterError> {
    let mut sql = String::from("INSERT INTO ");
    sql.push_str(&quote_ident(table));
    if values.is_empty() {
        // All-default insert.
        sql.push_str(" DEFAULT VALUES");
    } else {
        sql.push_str(" (");
        for (i, col) in values.keys().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&quote_ident(col));
        }
        sql.push_str(") VALUES (");
        for i in 0..values.len() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push('?');
        }
        sql.push(')');
    }

    log_line!("mutate.insert", "{} cols={}", table, values.len());

    let mut q = sqlx::query(&sql);
    for v in values.values() {
        q = bind_json(q, v);
    }
    let res = q.execute(&driver.pool).await?;

    // SQLite's `last_insert_rowid()` is available on the result — surface
    // it the same way MySQL surfaces `last_insert_id`, under `__insert_id`.
    // Callers that know the rowid column can resolve it by describe_table.
    let mut generated = std::collections::BTreeMap::new();
    let rowid = res.last_insert_rowid();
    if rowid != 0 {
        generated.insert(
            "__insert_id".to_string(),
            serde_json::Value::from(rowid),
        );
    }

    Ok(Mutation {
        records_affected: res.rows_affected(),
        generated_primary_key: if generated.is_empty() {
            None
        } else {
            Some(generated)
        },
    })
}

async fn delete(
    driver: &SqliteDriver,
    table: &str,
    primary_key: &[PrimaryKeyValue],
) -> Result<Mutation, AdapterError> {
    if primary_key.is_empty() {
        return Err(AdapterError::Unsupported(
            "delete requires a primary key on the target row".into(),
        ));
    }

    let mut sql = String::from("DELETE FROM ");
    sql.push_str(&quote_ident(table));
    sql.push_str(" WHERE ");
    for (i, pk) in primary_key.iter().enumerate() {
        if i > 0 {
            sql.push_str(" AND ");
        }
        sql.push_str(&quote_ident(&pk.column));
        sql.push_str(" = ?");
    }

    log_line!(
        "mutate.delete",
        "{} pk_cols={}",
        table,
        primary_key.len(),
    );

    let mut q = sqlx::query(&sql);
    for pk in primary_key {
        q = bind_json(q, &pk.value);
    }
    let res = q.execute(&driver.pool).await?;

    Ok(Mutation {
        records_affected: res.rows_affected(),
        generated_primary_key: None,
    })
}
