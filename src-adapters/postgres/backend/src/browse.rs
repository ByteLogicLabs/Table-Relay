//! `Adapter::browse` + `count_records` for PostgreSQL. Mirrors the
//! MySQL adapter's shape (identifiers quoted, values parameter-bound)
//! but uses Postgres's `$N` placeholder syntax and double-quoted idents.

use std::time::Instant;

use adapter_api::log_line;
use adapter_api::{
    AdapterError, BrowseRequest, BrowseResult, ColumnMeta, CountRequest, Filter, FilterOp,
};
use serde_json::Value as JsonValue;
use sqlx::postgres::{PgArguments, PgColumn, PgRow};
use sqlx::query::Query;
use sqlx::{Column, Executor, Postgres, Row, TypeInfo};

use crate::postgres::{bind_json, column_to_json, quote_ident};
use crate::PostgresDriver;

pub(crate) async fn browse(
    driver: &PostgresDriver,
    req: BrowseRequest,
) -> Result<BrowseResult, AdapterError> {
    let t_total = Instant::now();

    let page_number = req.page.number.max(1);
    let page_size = req.page.size.max(1);
    let offset = (page_number as u64 - 1) * (page_size as u64);

    let mut sql = String::from("SELECT * FROM ");
    sql.push_str(&quote_ident(&req.schema));
    sql.push('.');
    sql.push_str(&quote_ident(&req.table));

    let (where_sql, filter_values) = build_where(&req.filters, 1)?;
    sql.push_str(&where_sql);

    if !req.sort.is_empty() {
        sql.push_str(" ORDER BY ");
        for (i, s) in req.sort.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&quote_ident(&s.column));
            sql.push(' ');
            sql.push_str(match s.direction {
                adapter_api::SortDirection::Asc => "ASC",
                adapter_api::SortDirection::Desc => "DESC",
            });
        }
    }

    sql.push_str(&format!(" LIMIT {page_size} OFFSET {offset}"));

    log_line!(
        "pg_browse",
        "{}.{} page={} size={} filters={} sort={} offset={}",
        req.schema,
        req.table,
        page_number,
        page_size,
        req.filters.len(),
        req.sort.len(),
        offset,
    );

    let mut q: Query<'_, Postgres, PgArguments> = sqlx::query(&sql);
    for v in &filter_values {
        q = bind_json(q, v);
    }

    let count_fut = async {
        if req.include_total {
            count_inner(driver, &req.schema, &req.table, &req.filters).await
        } else {
            Ok(None)
        }
    };

    let rows_fut = async { q.fetch_all(&driver.pool).await.map_err(AdapterError::from) };

    let (rows_res, count_res) = tokio::join!(rows_fut, count_fut);
    let rows: Vec<PgRow> = rows_res?;
    let total_records = count_res?;

    let columns: Vec<ColumnMeta> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c: &PgColumn| ColumnMeta {
                name: c.name().to_string(),
                type_hint: c.type_info().name().to_string(),
            })
            .collect()
    } else {
        let mut conn = driver.pool.acquire().await.map_err(AdapterError::from)?;
        conn.describe(sql.as_str())
            .await
            .ok()
            .map(|d| {
                d.columns()
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name().to_string(),
                        type_hint: c.type_info().name().to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    };

    let type_names: Vec<String> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c| c.type_info().name().to_string())
            .collect()
    } else {
        columns.iter().map(|c| c.type_hint.clone()).collect()
    };

    let json_rows: Vec<Vec<JsonValue>> = rows
        .iter()
        .map(|row| {
            row.columns()
                .iter()
                .enumerate()
                .map(|(i, _)| {
                    column_to_json(row, i, type_names.get(i).map(|s| s.as_str()).unwrap_or(""))
                })
                .collect()
        })
        .collect();

    let duration_ms = t_total.elapsed().as_secs_f64() * 1000.0;
    log_line!(
        "pg_browse",
        "  → {} rows ({:.1}ms), total_records={:?}",
        json_rows.len(),
        duration_ms,
        total_records,
    );

    Ok(BrowseResult {
        columns,
        rows: json_rows,
        duration_ms,
        page: page_number,
        total_records,
    })
}

pub(crate) async fn count_records(
    driver: &PostgresDriver,
    req: CountRequest,
) -> Result<Option<u64>, AdapterError> {
    count_inner(driver, &req.schema, &req.table, &req.filters).await
}

async fn count_inner(
    driver: &PostgresDriver,
    schema: &str,
    table: &str,
    filters: &[Filter],
) -> Result<Option<u64>, AdapterError> {
    let mut sql = String::from("SELECT COUNT(*) FROM ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));

    let (where_sql, filter_values) = build_where(filters, 1)?;
    sql.push_str(&where_sql);

    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for v in &filter_values {
        q = match v {
            JsonValue::Null => q.bind(Option::<String>::None),
            JsonValue::Bool(b) => q.bind(*b),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    q.bind(i)
                } else if let Some(f) = n.as_f64() {
                    q.bind(f)
                } else {
                    q.bind(n.to_string())
                }
            }
            JsonValue::String(s) => q.bind(s.clone()),
            JsonValue::Array(_) | JsonValue::Object(_) => {
                q.bind(serde_json::to_string(v).unwrap_or_default())
            }
        };
    }

    let n: i64 = q.fetch_one(&driver.pool).await.map_err(AdapterError::from)?;
    Ok(Some(n.max(0) as u64))
}

/// `start_at` is the first `$N` index to emit — usually `1`, but callers
/// that want to sandwich filters into a bigger query can offset it.
fn build_where(
    filters: &[Filter],
    start_at: usize,
) -> Result<(String, Vec<JsonValue>), AdapterError> {
    if filters.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    let mut sql = String::from(" WHERE ");
    let mut values: Vec<JsonValue> = Vec::new();
    let mut next_placeholder = start_at;
    let mut ph = || {
        let n = next_placeholder;
        next_placeholder += 1;
        format!("${n}")
    };
    for (i, f) in filters.iter().enumerate() {
        if i > 0 {
            sql.push_str(" AND ");
        }
        sql.push_str(&quote_ident(&f.column));
        match f.op {
            FilterOp::Eq => {
                sql.push_str(&format!(" = {}", ph()));
                values.push(require_value(f, "eq")?);
            }
            FilterOp::NotEq => {
                sql.push_str(&format!(" <> {}", ph()));
                values.push(require_value(f, "not_eq")?);
            }
            FilterOp::Lt => {
                sql.push_str(&format!(" < {}", ph()));
                values.push(require_value(f, "lt")?);
            }
            FilterOp::Lte => {
                sql.push_str(&format!(" <= {}", ph()));
                values.push(require_value(f, "lte")?);
            }
            FilterOp::Gt => {
                sql.push_str(&format!(" > {}", ph()));
                values.push(require_value(f, "gt")?);
            }
            FilterOp::Gte => {
                sql.push_str(&format!(" >= {}", ph()));
                values.push(require_value(f, "gte")?);
            }
            FilterOp::Contains => {
                // ILIKE for case-insensitive substring match — matches
                // the spirit of MySQL's case-insensitive collation more
                // closely than plain LIKE under Postgres's default `C`
                // collation.
                sql.push_str(&format!(" ILIKE {}", ph()));
                values.push(like_wrap(f, "%{}%")?);
            }
            FilterOp::NotContains => {
                sql.push_str(&format!(" NOT ILIKE {}", ph()));
                values.push(like_wrap(f, "%{}%")?);
            }
            FilterOp::StartsWith => {
                sql.push_str(&format!(" ILIKE {}", ph()));
                values.push(like_wrap(f, "{}%")?);
            }
            FilterOp::EndsWith => {
                sql.push_str(&format!(" ILIKE {}", ph()));
                values.push(like_wrap(f, "%{}")?);
            }
            FilterOp::IsNull => {
                sql.push_str(" IS NULL");
            }
            FilterOp::IsNotNull => {
                sql.push_str(" IS NOT NULL");
            }
            FilterOp::In | FilterOp::NotIn => {
                let list = f
                    .value
                    .as_ref()
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| {
                        AdapterError::Unsupported(format!(
                            "{:?} requires an array value",
                            f.op
                        ))
                    })?;
                if list.is_empty() {
                    sql.push_str(match f.op {
                        FilterOp::In => " IN (NULL) AND 1=0",
                        _ => " IS NOT NULL",
                    });
                } else {
                    sql.push_str(match f.op {
                        FilterOp::In => " IN (",
                        _ => " NOT IN (",
                    });
                    for (j, item) in list.iter().enumerate() {
                        if j > 0 {
                            sql.push_str(", ");
                        }
                        sql.push_str(&ph());
                        values.push(item.clone());
                    }
                    sql.push(')');
                }
            }
        }
    }
    Ok((sql, values))
}

fn require_value(f: &Filter, op_name: &str) -> Result<JsonValue, AdapterError> {
    f.value.clone().ok_or_else(|| {
        AdapterError::Unsupported(format!("`{op_name}` filter on `{}` has no value", f.column))
    })
}

fn like_wrap(f: &Filter, template: &str) -> Result<JsonValue, AdapterError> {
    let v = require_value(f, "like")?;
    let s = match v {
        JsonValue::String(s) => s,
        JsonValue::Null => {
            return Err(AdapterError::Unsupported(format!(
                "null value not supported for LIKE filter on `{}`",
                f.column
            )));
        }
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        _ => v.to_string(),
    };
    Ok(JsonValue::String(template.replace("{}", &s)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn filter(col: &str, op: FilterOp, value: Option<JsonValue>) -> Filter {
        Filter {
            column: col.to_string(),
            op,
            value,
        }
    }

    #[test]
    fn empty_filters_yields_empty_where() {
        let (sql, values) = build_where(&[], 1).unwrap();
        assert_eq!(sql, "");
        assert!(values.is_empty());
    }

    #[test]
    fn eq_filter_uses_dollar_placeholder() {
        let (sql, values) =
            build_where(&[filter("id", FilterOp::Eq, Some(json!(42)))], 1).unwrap();
        assert_eq!(sql, r#" WHERE "id" = $1"#);
        assert_eq!(values, vec![json!(42)]);
    }

    #[test]
    fn double_quote_is_escaped() {
        let (sql, _) =
            build_where(&[filter(r#"w"c"#, FilterOp::Eq, Some(json!(1)))], 1).unwrap();
        assert_eq!(sql, r#" WHERE "w""c" = $1"#);
    }

    #[test]
    fn contains_uses_ilike() {
        let (sql, values) = build_where(
            &[filter("email", FilterOp::Contains, Some(json!("@acme")))],
            1,
        )
        .unwrap();
        assert_eq!(sql, r#" WHERE "email" ILIKE $1"#);
        assert_eq!(values, vec![json!("%@acme%")]);
    }

    #[test]
    fn in_list_expands_placeholders() {
        let (sql, values) = build_where(
            &[filter("status", FilterOp::In, Some(json!(["a", "b", "c"])))],
            1,
        )
        .unwrap();
        assert_eq!(sql, r#" WHERE "status" IN ($1, $2, $3)"#);
        assert_eq!(values, vec![json!("a"), json!("b"), json!("c")]);
    }

    #[test]
    fn empty_in_short_circuits_to_false() {
        let (sql, values) =
            build_where(&[filter("status", FilterOp::In, Some(json!([])))], 1).unwrap();
        assert!(sql.contains("1=0"), "got {sql}");
        assert!(values.is_empty());
    }
}
