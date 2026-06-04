//! `Adapter::browse` + `count_records` for the MySQL adapter.
//!
//! Previously the frontend built `SELECT * FROM … LIMIT N OFFSET M` itself;
//! under the adapter model it declares *what* it wants (`BrowseRequest`)
//! and the adapter translates. Values are always parameter-bound —
//! identifiers (schema / table / column) are backtick-quoted.

use std::time::Instant;

use adapter_api::{
    AdapterError, BrowseRequest, BrowseResult, ColumnMeta, CountRequest, Filter, FilterOp,
};
use adapter_api::log_line;
use serde_json::Value as JsonValue;
use sqlx::{Column, MySql, Row, TypeInfo};
use sqlx::mysql::{MySqlArguments, MySqlColumn, MySqlRow};
use sqlx::query::Query;

use crate::mysql::{bind_json, column_to_json, quote_ident};
use crate::MysqlDriver;

pub(crate) async fn browse(
    driver: &MysqlDriver,
    req: BrowseRequest,
) -> Result<BrowseResult, AdapterError> {
    let t_total = Instant::now();

    let page_number = req.page.number.max(1);
    let page_size = req.page.size.max(1);
    let offset = (page_number as u64 - 1) * (page_size as u64);

    // Build the SELECT. Identifiers quoted; values go through bind().
    let projection = if req.columns.is_empty() {
        "*".to_string()
    } else {
        req.columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut sql = format!("SELECT {projection} FROM ");
    sql.push_str(&quote_ident(&req.schema));
    sql.push('.');
    sql.push_str(&quote_ident(&req.table));

    let (where_sql, filter_values) = build_where(&req.filters)?;
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
        "browse",
        "{}.{} page={} size={} cols={} filters={} sort={} offset={}",
        req.schema,
        req.table,
        page_number,
        page_size,
        req.columns.len(),
        req.filters.len(),
        req.sort.len(),
        offset,
    );

    // Bind filter values.
    let mut q: Query<'_, MySql, MySqlArguments> = sqlx::query(&sql);
    for v in &filter_values {
        q = bind_json(q, v);
    }

    // Optionally do the count in the same await group so the UI gets both
    // numbers from the same database view.
    let count_fut = async {
        if req.include_total {
            count_inner(driver, &req.schema, &req.table, &req.filters).await
        } else {
            Ok(None)
        }
    };

    let rows_fut = async { q.fetch_all(&driver.pool).await.map_err(AdapterError::from) };

    let (rows_res, count_res) = tokio::join!(rows_fut, count_fut);
    let rows: Vec<MySqlRow> = rows_res.map_err(|e: AdapterError| e)?;
    let total_records = count_res?;

    let columns: Vec<ColumnMeta> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c: &MySqlColumn| ColumnMeta {
                name: c.name().to_string(),
                type_hint: c.type_info().name().to_string(),
            })
            .collect()
    } else {
        // Describe the statement so empty result sets still carry column
        // metadata the grid can render headers from.
        let mut conn = driver.pool.acquire().await.map_err(AdapterError::from)?;
        use sqlx::Executor;
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
        "browse",
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
    driver: &MysqlDriver,
    req: CountRequest,
) -> Result<Option<u64>, AdapterError> {
    count_inner(driver, &req.schema, &req.table, &req.filters).await
}

/// Shared COUNT(*) path so `browse(include_total=true)` and the standalone
/// `count_records` command use the same SQL.
async fn count_inner(
    driver: &MysqlDriver,
    schema: &str,
    table: &str,
    filters: &[Filter],
) -> Result<Option<u64>, AdapterError> {
    let mut sql = String::from("SELECT COUNT(*) FROM ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));

    let (where_sql, filter_values) = build_where(filters)?;
    sql.push_str(&where_sql);

    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for v in &filter_values {
        // query_scalar takes the same bind API. `bind_json` is typed for
        // `Query<MySql, _>` so we reimplement the bind here — only a few
        // cases matter for counts.
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

/// Translate a `Vec<Filter>` into a `WHERE …` fragment + the ordered list of
/// values to bind. Empty input returns `("", [])`. Values that would be
/// interpolated into SQL (the `IN` / `NOT IN` lists) are handled safely —
/// each list element is added as its own placeholder.
fn build_where(
    filters: &[Filter],
) -> Result<(String, Vec<JsonValue>), AdapterError> {
    if filters.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    let mut sql = String::from(" WHERE ");
    let mut values: Vec<JsonValue> = Vec::new();
    for (i, f) in filters.iter().enumerate() {
        if i > 0 {
            sql.push_str(" AND ");
        }
        sql.push_str(&quote_ident(&f.column));
        match f.op {
            FilterOp::Eq => {
                sql.push_str(" = ?");
                values.push(require_value(f, "eq")?);
            }
            FilterOp::NotEq => {
                sql.push_str(" <> ?");
                values.push(require_value(f, "not_eq")?);
            }
            FilterOp::Lt => {
                sql.push_str(" < ?");
                values.push(require_value(f, "lt")?);
            }
            FilterOp::Lte => {
                sql.push_str(" <= ?");
                values.push(require_value(f, "lte")?);
            }
            FilterOp::Gt => {
                sql.push_str(" > ?");
                values.push(require_value(f, "gt")?);
            }
            FilterOp::Gte => {
                sql.push_str(" >= ?");
                values.push(require_value(f, "gte")?);
            }
            FilterOp::Contains => {
                sql.push_str(" LIKE ?");
                values.push(like_wrap(f, "%{}%")?);
            }
            FilterOp::NotContains => {
                sql.push_str(" NOT LIKE ?");
                values.push(like_wrap(f, "%{}%")?);
            }
            FilterOp::StartsWith => {
                sql.push_str(" LIKE ?");
                values.push(like_wrap(f, "{}%")?);
            }
            FilterOp::EndsWith => {
                sql.push_str(" LIKE ?");
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
                    // Empty IN always matches nothing; NOT IN always matches
                    // everything. Expressing that cleanly keeps the row-set
                    // consistent with the user's intent.
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
                        sql.push('?');
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

/// Wrap a string value in the LIKE template (`%{}%`, `{}%`, `%{}`). Only
/// strings make sense here; numbers/bools get coerced via `to_string` to
/// avoid MySQL's implicit-cast surprises.
fn like_wrap(f: &Filter, template: &str) -> Result<JsonValue, AdapterError> {
    let v = require_value(f, "like")?;
    let s = match v {
        JsonValue::String(s) => s,
        JsonValue::Null => {
            return Err(AdapterError::Unsupported(format!(
                "null value not supported for LIKE filter on `{}`",
                f.column
            )))
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
        let (sql, values) = build_where(&[]).unwrap();
        assert_eq!(sql, "");
        assert!(values.is_empty());
    }

    #[test]
    fn eq_filter_binds_one_placeholder() {
        let (sql, values) = build_where(&[
            filter("id", FilterOp::Eq, Some(json!(42))),
        ])
        .unwrap();
        assert_eq!(sql, " WHERE `id` = ?");
        assert_eq!(values, vec![json!(42)]);
    }

    #[test]
    fn is_null_has_no_placeholder() {
        let (sql, values) = build_where(&[
            filter("name", FilterOp::IsNull, None),
        ])
        .unwrap();
        assert_eq!(sql, " WHERE `name` IS NULL");
        assert!(values.is_empty());
    }

    #[test]
    fn contains_wraps_with_percent() {
        let (sql, values) = build_where(&[
            filter("email", FilterOp::Contains, Some(json!("@acme"))),
        ])
        .unwrap();
        assert_eq!(sql, " WHERE `email` LIKE ?");
        assert_eq!(values, vec![json!("%@acme%")]);
    }

    #[test]
    fn in_list_expands_placeholders_and_binds_each() {
        let (sql, values) = build_where(&[
            filter("status", FilterOp::In, Some(json!(["a", "b", "c"]))),
        ])
        .unwrap();
        assert_eq!(sql, " WHERE `status` IN (?, ?, ?)");
        assert_eq!(values, vec![json!("a"), json!("b"), json!("c")]);
    }

    #[test]
    fn empty_in_short_circuits_to_false() {
        let (sql, values) = build_where(&[
            filter("status", FilterOp::In, Some(json!([]))),
        ])
        .unwrap();
        assert!(sql.contains("1=0"), "got {sql}");
        assert!(values.is_empty());
    }

    #[test]
    fn backticks_in_column_name_are_escaped() {
        let (sql, _) = build_where(&[
            filter("weird`col", FilterOp::Eq, Some(json!(1))),
        ])
        .unwrap();
        assert_eq!(sql, " WHERE `weird``col` = ?");
    }

    #[test]
    fn multiple_filters_joined_with_and() {
        let (sql, values) = build_where(&[
            filter("a", FilterOp::Eq, Some(json!(1))),
            filter("b", FilterOp::Gt, Some(json!(2))),
        ])
        .unwrap();
        assert_eq!(sql, " WHERE `a` = ? AND `b` > ?");
        assert_eq!(values, vec![json!(1), json!(2)]);
    }
}
