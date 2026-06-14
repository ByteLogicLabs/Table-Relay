//! `Adapter::mutate` for PostgreSQL. Mirrors the MySQL version but uses
//! `$N` placeholders, double-quoted identifiers, and `RETURNING` to
//! surface generated PK values on INSERT (Postgres doesn't have a
//! `last_insert_id()` equivalent).

use adapter_api::log_line;
use adapter_api::{AdapterError, MutateRequest, Mutation, PrimaryKeyValue};
use serde_json::Value as JsonValue;

use crate::postgres::{bind_json, bind_json_as_text, column_to_json, quote_ident};
use crate::PostgresDriver;

pub(crate) async fn mutate(
    driver: &PostgresDriver,
    req: MutateRequest,
) -> Result<Mutation, AdapterError> {
    match req {
        MutateRequest::Insert {
            schema,
            table,
            values,
        } => insert(driver, &schema, &table, values).await,
        MutateRequest::Update {
            schema,
            table,
            primary_key,
            changes,
        } => {
            let rows = driver
                .update_rows(&schema, &table, &primary_key, &changes)
                .await?;
            Ok(Mutation {
                records_affected: rows,
                generated_primary_key: None,
            })
        }
        MutateRequest::Delete {
            schema,
            table,
            primary_key,
        } => delete(driver, &schema, &table, &primary_key).await,
    }
}

/// Optional per-column cast type (e.g. `Some("vector")`) so a text-bound param
/// is coerced to a type Postgres won't implicitly cast from text. `casts[i]`
/// pairs with `columns[i]`; `None` means a bare placeholder.
pub(crate) fn build_insert_sql(
    schema: &str,
    table: &str,
    columns: &[&str],
    casts: &[Option<String>],
) -> String {
    let placeholder = |i: usize| match casts.get(i).and_then(|c| c.as_ref()) {
        Some(ty) => format!("${}::{ty}", i + 1),
        None => format!("${}", i + 1),
    };
    let mut sql = String::from("INSERT INTO ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));
    if columns.is_empty() {
        sql.push_str(" DEFAULT VALUES");
    } else {
        sql.push_str(" (");
        for (i, col) in columns.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&quote_ident(col));
        }
        sql.push_str(") VALUES (");
        for i in 0..columns.len() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&placeholder(i));
        }
        sql.push(')');
        // Ask for the generated PK back so the UI can address the freshly
        // inserted row. For tables without a PK this returns an empty row;
        // we treat that as "nothing generated".
        sql.push_str(" RETURNING *");
        return sql;
    }
    // Ask for the generated PK back so the UI can address the freshly
    // inserted row. For tables without a PK this returns an empty row;
    // we treat that as "nothing generated".
    sql.push_str(" RETURNING *");
    sql
}

async fn insert(
    driver: &PostgresDriver,
    schema: &str,
    table: &str,
    values: std::collections::BTreeMap<String, JsonValue>,
) -> Result<Mutation, AdapterError> {
    let col_refs: Vec<&str> = values.keys().map(String::as_str).collect();

    // Per-column write casts for exotic types (vector/range/inet/…); their
    // values bind as text so `$N::vector` etc. coerces correctly.
    let col_types = crate::browse::column_types(driver, schema, table).await;
    let cast_of = |name: &str| -> Option<String> {
        col_types
            .iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, t)| crate::browse::cast_for_write(t))
    };
    let casts: Vec<Option<String>> = col_refs.iter().map(|c| cast_of(c)).collect();
    let sql = build_insert_sql(schema, table, &col_refs, &casts);

    log_line!(
        "pg_mutate.insert",
        "{}.{} cols={}",
        schema,
        table,
        values.len()
    );

    let mut q = sqlx::query(&sql);
    for (col, v) in values.iter() {
        if cast_of(col).is_some() {
            q = bind_json_as_text(q, v);
        } else {
            q = bind_json(q, v);
        }
    }

    use sqlx::{Column, Row, TypeInfo};
    let row_opt = q.fetch_optional(&driver.pool).await.map_err(AdapterError::from)?;
    let generated = row_opt.map(|row| {
        let mut map = std::collections::BTreeMap::new();
        let cols = row.columns();
        let type_names: Vec<String> = cols
            .iter()
            .map(|c| c.type_info().name().to_string())
            .collect();
        for (i, col) in cols.iter().enumerate() {
            let name = col.name().to_string();
            let v = column_to_json(&row, i, &type_names[i]);
            map.insert(name, v);
        }
        map
    });

    // `rows_affected` is always 1 on a successful INSERT … VALUES (...).
    // We return that explicitly even though the caller can count keys
    // in `generated_primary_key`.
    Ok(Mutation {
        records_affected: if generated.is_some() { 1 } else { 0 },
        generated_primary_key: generated,
    })
}

pub(crate) fn build_delete_sql(schema: &str, table: &str, pk_columns: &[&str]) -> String {
    let mut sql = String::from("DELETE FROM ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));
    sql.push_str(" WHERE ");
    for (i, col) in pk_columns.iter().enumerate() {
        if i > 0 {
            sql.push_str(" AND ");
        }
        // `::text` cast: see build_update_sql.
        sql.push_str(&format!("{}::text = ${}", quote_ident(col), i + 1));
    }
    sql
}

/// `set_casts[i]` optionally casts the i-th SET param to a type (e.g.
/// `Some("vector")`) for types Postgres won't implicitly cast from text.
pub(crate) fn build_update_sql(
    schema: &str,
    table: &str,
    set_columns: &[&str],
    pk_columns: &[&str],
    set_casts: &[Option<String>],
) -> String {
    let mut sql = String::from("UPDATE ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));
    sql.push_str(" SET ");
    let mut placeholder = 1usize;
    for (i, col) in set_columns.iter().enumerate() {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&quote_ident(col));
        match set_casts.get(i).and_then(|c| c.as_ref()) {
            Some(ty) => sql.push_str(&format!(" = ${placeholder}::{ty}")),
            None => sql.push_str(&format!(" = ${placeholder}")),
        }
        placeholder += 1;
    }
    sql.push_str(" WHERE ");
    for (i, col) in pk_columns.iter().enumerate() {
        if i > 0 {
            sql.push_str(" AND ");
        }
        // `"col"::text = $N` (text-bound param): Postgres has no implicit
        // `uuid = text` / `numeric = text` operator, so a bare `"id" = $N`
        // breaks editing on uuid/numeric/etc. PKs. Casting both sides to text
        // is type-safe for all scalar keys.
        sql.push_str(&format!("{}::text = ${placeholder}", quote_ident(col)));
        placeholder += 1;
    }
    sql
}

async fn delete(
    driver: &PostgresDriver,
    schema: &str,
    table: &str,
    primary_key: &[PrimaryKeyValue],
) -> Result<Mutation, AdapterError> {
    if primary_key.is_empty() {
        return Err(AdapterError::Unsupported(
            "delete requires a primary key on the target row".into(),
        ));
    }

    let pk_cols: Vec<&str> = primary_key.iter().map(|pk| pk.column.as_str()).collect();
    let sql = build_delete_sql(schema, table, &pk_cols);

    log_line!(
        "pg_mutate.delete",
        "{}.{} pk_cols={}",
        schema,
        table,
        primary_key.len(),
    );

    // PK compared via `"col"::text = $N` — bind keys as text (see build_update_sql).
    let mut q = sqlx::query(&sql);
    for pk in primary_key {
        q = bind_json_as_text(q, &pk.value);
    }
    let res = q.execute(&driver.pool).await.map_err(AdapterError::from)?;

    Ok(Mutation {
        records_affected: res.rows_affected(),
        generated_primary_key: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_uses_double_quoted_idents_and_dollar_placeholders() {
        let sql = build_insert_sql("public", "users", &["id", "name"], &[None, None]);
        assert_eq!(
            sql,
            r#"INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2) RETURNING *"#
        );
    }

    #[test]
    fn insert_escapes_double_quotes_in_idents() {
        let sql = build_insert_sql("weird\"schema", "weird\"table", &["weird\"col"], &[None]);
        assert!(sql.starts_with(r#"INSERT INTO "weird""schema"."weird""table" ("weird""col")"#));
    }

    #[test]
    fn insert_single_column_still_parens() {
        let sql = build_insert_sql("s", "t", &["a"], &[None]);
        assert_eq!(sql, r#"INSERT INTO "s"."t" ("a") VALUES ($1) RETURNING *"#);
    }

    #[test]
    fn insert_casts_exotic_columns() {
        let sql = build_insert_sql(
            "s",
            "t",
            &["id", "embedding"],
            &[None, Some("vector".to_string())],
        );
        assert_eq!(
            sql,
            r#"INSERT INTO "s"."t" ("id", "embedding") VALUES ($1, $2::vector) RETURNING *"#
        );
    }

    #[test]
    fn delete_numbers_placeholders_and_ands_predicates() {
        let sql = build_delete_sql("public", "users", &["id"]);
        assert_eq!(sql, r#"DELETE FROM "public"."users" WHERE "id"::text = $1"#);

        let sql2 = build_delete_sql("public", "users", &["tenant_id", "id"]);
        assert_eq!(
            sql2,
            r#"DELETE FROM "public"."users" WHERE "tenant_id"::text = $1 AND "id"::text = $2"#
        );
    }

    #[test]
    fn update_places_set_then_pk_placeholders() {
        let sql = build_update_sql("public", "users", &["email", "name"], &["id"], &[None, None]);
        assert_eq!(
            sql,
            r#"UPDATE "public"."users" SET "email" = $1, "name" = $2 WHERE "id"::text = $3"#
        );
    }

    #[test]
    fn update_composite_pk_continues_placeholder_numbering() {
        let sql = build_update_sql("s", "t", &["a"], &["p1", "p2"], &[None]);
        assert_eq!(
            sql,
            r#"UPDATE "s"."t" SET "a" = $1 WHERE "p1"::text = $2 AND "p2"::text = $3"#
        );
    }

    #[test]
    fn update_casts_exotic_set_columns() {
        let sql = build_update_sql(
            "s",
            "t",
            &["embedding"],
            &["id"],
            &[Some("vector".to_string())],
        );
        assert_eq!(
            sql,
            r#"UPDATE "s"."t" SET "embedding" = $1::vector WHERE "id"::text = $2"#
        );
    }

    #[test]
    fn update_never_uses_backticks() {
        let sql = build_update_sql("s", "t", &["x"], &["id"], &[None]);
        assert!(!sql.contains('`'), "postgres must not emit backticks: {sql}");
    }

    #[test]
    fn needs_text_cast_classifies_types() {
        use crate::browse::needs_text_cast;
        for t in ["vector", "int4range", "inet", "tsvector", "numeric[]", "point", "public.vector"] {
            assert!(needs_text_cast(t), "{t} should need a text cast");
        }
        for t in ["integer", "text", "uuid", "jsonb", "boolean", "integer[]", "uuid[]", "timestamptz"] {
            assert!(!needs_text_cast(t), "{t} should NOT need a text cast");
        }
    }
}
