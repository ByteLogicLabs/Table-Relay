use std::time::Instant;

use adapter_api::{AdapterError, ColumnMeta, QueryResult, StatementResult};
use futures::TryStreamExt;
use mongodb::bson::{Bson, Document, doc};
use mongodb::options::FindOptions;

use crate::MongoDriver;
use crate::mongo::{
    bson_to_json, columns_from_docs, map_err, parse_json_array, parse_json_document,
};

pub(crate) async fn execute_raw(
    driver: &MongoDriver,
    command: &str,
    row_limit: Option<u32>,
) -> Result<QueryResult, AdapterError> {
    let statements = split_statements(command);
    let mut out = Vec::with_capacity(statements.len());

    for sql in statements {
        let t0 = Instant::now();
        let result = run_statement(driver, &sql, row_limit).await;
        match result {
            Ok((columns, rows, affected)) => out.push(StatementResult {
                sql,
                duration_ms: t0.elapsed().as_secs_f64() * 1000.0,
                columns,
                rows,
                rows_affected: affected,
                error: None,
            }),
            Err(e) => out.push(StatementResult {
                sql,
                duration_ms: t0.elapsed().as_secs_f64() * 1000.0,
                columns: vec![],
                rows: vec![],
                rows_affected: None,
                error: Some(e.to_string()),
            }),
        }
    }

    Ok(QueryResult { statements: out })
}

async fn run_statement(
    driver: &MongoDriver,
    raw: &str,
    row_limit: Option<u32>,
) -> Result<(Vec<ColumnMeta>, Vec<Vec<serde_json::Value>>, Option<u64>), AdapterError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok((vec![], vec![], Some(0)));
    }

    if trimmed.starts_with('{') {
        let cmd = parse_json_document(trimmed)?;
        let db = driver.query_db(None)?;
        let res = db.run_command(cmd, None).await.map_err(map_err)?;
        let cols = vec![ColumnMeta {
            name: "result".to_string(),
            type_hint: "object".to_string(),
        }];
        let row = vec![bson_to_json(&Bson::Document(res))];
        return Ok((cols, vec![row], None));
    }

    if let Some((schema, args)) = parse_run_command(trimmed)? {
        let db = driver.query_db(schema.as_deref())?;
        let cmd = parse_json_document(args.trim())?;
        let res = db.run_command(cmd, None).await.map_err(map_err)?;
        let cols = vec![ColumnMeta {
            name: "result".to_string(),
            type_hint: "object".to_string(),
        }];
        let row = vec![bson_to_json(&Bson::Document(res))];
        return Ok((cols, vec![row], None));
    }

    let (schema, collection, op, args, tail) = parse_shell_command(trimmed)?;
    let db = driver.query_db(schema.as_deref())?;
    let coll = db.collection::<Document>(&collection);

    match op.as_str() {
        "find" => {
            let filter = if args.trim().is_empty() {
                doc! {}
            } else {
                parse_json_document(args.trim())?
            };
            let limit = parse_limit(&tail)?.or(row_limit.map(|n| n as i64));
            let mut opts = FindOptions::default();
            opts.limit = limit;
            let mut cur = coll.find(filter, opts).await.map_err(map_err)?;
            let mut docs = Vec::new();
            while let Some(d) = cur.try_next().await.map_err(map_err)? {
                docs.push(d);
            }
            let col_names = columns_from_docs(&docs);
            let rows = docs
                .iter()
                .map(|d| {
                    col_names
                        .iter()
                        .map(|c| bson_to_json(d.get(c).unwrap_or(&Bson::Null)))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let cols = col_names
                .iter()
                .map(|c| ColumnMeta {
                    name: c.clone(),
                    type_hint: "mixed".to_string(),
                })
                .collect();
            Ok((cols, rows, None))
        }
        "findOne" => {
            let filter = if args.trim().is_empty() {
                doc! {}
            } else {
                parse_json_document(args.trim())?
            };
            let doc_opt = coll.find_one(filter, None).await.map_err(map_err)?;
            let docs = doc_opt.into_iter().collect::<Vec<_>>();
            let col_names = columns_from_docs(&docs);
            let rows = docs
                .iter()
                .map(|d| {
                    col_names
                        .iter()
                        .map(|c| bson_to_json(d.get(c).unwrap_or(&Bson::Null)))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let cols = col_names
                .iter()
                .map(|c| ColumnMeta {
                    name: c.clone(),
                    type_hint: "mixed".to_string(),
                })
                .collect();
            Ok((cols, rows, None))
        }
        "insertOne" => {
            let payload = parse_json_document(args.trim())?;
            let res = coll.insert_one(payload, None).await.map_err(map_err)?;
            let cols = vec![ColumnMeta {
                name: "insertedId".to_string(),
                type_hint: "objectId".to_string(),
            }];
            let rows = vec![vec![bson_to_json(&res.inserted_id)]];
            Ok((cols, rows, Some(1)))
        }
        "updateOne" => {
            let (a, b) = split_two_args(args)?;
            let filter = parse_json_document(a.trim())?;
            let update = parse_json_document(b.trim())?;
            let res = coll.update_one(filter, update, None).await.map_err(map_err)?;
            let cols = vec![ColumnMeta {
                name: "modifiedCount".to_string(),
                type_hint: "int64".to_string(),
            }];
            let rows = vec![vec![serde_json::Value::from(res.modified_count)]];
            Ok((cols, rows, Some(res.modified_count)))
        }
        "deleteOne" => {
            let filter = parse_json_document(args.trim())?;
            let res = coll.delete_one(filter, None).await.map_err(map_err)?;
            let cols = vec![ColumnMeta {
                name: "deletedCount".to_string(),
                type_hint: "int64".to_string(),
            }];
            let rows = vec![vec![serde_json::Value::from(res.deleted_count)]];
            Ok((cols, rows, Some(res.deleted_count)))
        }
        "countDocuments" => {
            let filter = if args.trim().is_empty() {
                doc! {}
            } else {
                parse_json_document(args.trim())?
            };
            let n = coll.count_documents(filter, None).await.map_err(map_err)?;
            let cols = vec![ColumnMeta {
                name: "n".to_string(),
                type_hint: "int64".to_string(),
            }];
            let rows = vec![vec![serde_json::Value::from(n)]];
            Ok((cols, rows, Some(0)))
        }
        "aggregate" => {
            let pipeline = parse_json_array(args.trim())?
                .into_iter()
                .map(|b| match b {
                    Bson::Document(d) => Ok(d),
                    _ => Err(AdapterError::Syntax {
                        message: "aggregate pipeline must be an array of JSON objects".to_string(),
                        line: None,
                        column: None,
                    }),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut cur = coll.aggregate(pipeline, None).await.map_err(map_err)?;
            let mut docs = Vec::new();
            while let Some(d) = cur.try_next().await.map_err(map_err)? {
                docs.push(d);
            }
            let col_names = columns_from_docs(&docs);
            let rows = docs
                .iter()
                .map(|d| {
                    col_names
                        .iter()
                        .map(|c| bson_to_json(d.get(c).unwrap_or(&Bson::Null)))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let cols = col_names
                .iter()
                .map(|c| ColumnMeta {
                    name: c.clone(),
                    type_hint: "mixed".to_string(),
                })
                .collect();
            Ok((cols, rows, None))
        }
        _ => Err(AdapterError::Unsupported(format!(
            "Unsupported Mongo shell op `{op}`. Supported: find, findOne, insertOne, updateOne, deleteOne, countDocuments, aggregate"
        ))),
    }
}

fn parse_limit(tail: &str) -> Result<Option<i64>, AdapterError> {
    let t = tail.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if !t.starts_with(".limit(") {
        return Err(AdapterError::Syntax {
            message: format!("Unsupported trailing clause `{t}`. Only .limit(n) is supported after find()."),
            line: None,
            column: None,
        });
    }
    let end = t.rfind(')').ok_or_else(|| AdapterError::Syntax {
        message: "Missing closing ')' in limit()".to_string(),
        line: None,
        column: None,
    })?;
    let inner = &t[7..end];
    let n = inner.trim().parse::<i64>().map_err(|e| AdapterError::Syntax {
        message: format!("Invalid limit value: {e}"),
        line: None,
        column: None,
    })?;
    Ok(Some(n))
}

fn split_statements(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut depth_paren = 0i32;
    let mut depth_brace = 0i32;
    let mut depth_bracket = 0i32;
    let mut quote: Option<char> = None;
    let chars: Vec<char> = input.chars().collect();

    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q && !is_escaped(&chars, i) {
                quote = None;
            }
            i += 1;
            continue;
        }

        match c {
            '\'' | '"' => quote = Some(c),
            '(' => depth_paren += 1,
            ')' => depth_paren -= 1,
            '{' => depth_brace += 1,
            '}' => depth_brace -= 1,
            '[' => depth_bracket += 1,
            ']' => depth_bracket -= 1,
            ';' if depth_paren == 0 && depth_brace == 0 && depth_bracket == 0 => {
                let part: String = chars[start..i].iter().collect();
                let p = part.trim();
                if !p.is_empty() {
                    out.push(p.to_string());
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }

    if start < chars.len() {
        let part: String = chars[start..].iter().collect();
        let p = part.trim();
        if !p.is_empty() {
            out.push(p.to_string());
        }
    }

    out
}

fn parse_shell_command(input: &str) -> Result<(Option<String>, String, String, String, String), AdapterError> {
    let s = input.trim();
    if !s.starts_with("db.") {
        return Err(AdapterError::Syntax {
            message: "Mongo commands must start with `db.`".to_string(),
            line: None,
            column: None,
        });
    }

    let mut rest = &s[3..];
    let mut schema: Option<String> = None;

    if rest.starts_with("getSiblingDB(") {
        let (db_name, after) = parse_quoted_call(rest, "getSiblingDB")?;
        schema = Some(db_name);
        rest = after
            .strip_prefix('.')
            .ok_or_else(|| AdapterError::Syntax {
                message: "Expected `.` after getSiblingDB(...)".to_string(),
                line: None,
                column: None,
            })?;
    }

    let (collection, after_collection) = if rest.starts_with("getCollection(") {
        parse_quoted_call(rest, "getCollection")?
    } else {
        parse_collection_ident(rest)?
    };
    // Allow browsing a collection without an explicit method call:
    //   db.getCollection("users")
    //   db.users
    // This maps to the common shell default: find all docs.
    if after_collection.trim().is_empty() {
        return Ok((schema, collection, "find".to_string(), "{}".to_string(), String::new()));
    }
    let after_dot = after_collection
        .strip_prefix('.')
        .ok_or_else(|| AdapterError::Syntax {
            message: "Expected `.` after getCollection(...)".to_string(),
            line: None,
            column: None,
        })?;

    let op_end = after_dot.find('(').ok_or_else(|| AdapterError::Syntax {
        message: "Expected method call after collection".to_string(),
        line: None,
        column: None,
    })?;
    let op = after_dot[..op_end].trim().to_string();

    let (args, tail) = extract_call_args(&after_dot[op_end..])?;
    Ok((schema, collection, op, args, tail))
}

fn parse_run_command(input: &str) -> Result<Option<(Option<String>, String)>, AdapterError> {
    let s = input.trim();
    if !s.starts_with("db.") {
        return Ok(None);
    }
    let mut rest = &s[3..];
    let mut schema: Option<String> = None;

    if rest.starts_with("getSiblingDB(") {
        let (db_name, after) = parse_quoted_call(rest, "getSiblingDB")?;
        schema = Some(db_name);
        rest = after
            .strip_prefix('.')
            .ok_or_else(|| AdapterError::Syntax {
                message: "Expected `.` after getSiblingDB(...)".to_string(),
                line: None,
                column: None,
            })?;
    }

    if !rest.starts_with("runCommand(") {
        return Ok(None);
    }
    let (args, tail) = extract_call_args(&rest["runCommand".len()..])?;
    if !tail.trim().is_empty() {
        return Err(AdapterError::Syntax {
            message: "Unexpected trailing tokens after runCommand(...)".to_string(),
            line: None,
            column: None,
        });
    }
    Ok(Some((schema, args)))
}

fn parse_collection_ident(input: &str) -> Result<(String, &str), AdapterError> {
    let mut end = 0usize;
    for (i, c) in input.char_indices() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            end = i + c.len_utf8();
            continue;
        }
        break;
    }
    if end == 0 {
        return Err(AdapterError::Syntax {
            message: "Expected collection name or getCollection(...)".to_string(),
            line: None,
            column: None,
        });
    }
    Ok((input[..end].to_string(), &input[end..]))
}

fn parse_quoted_call<'a>(input: &'a str, name: &str) -> Result<(String, &'a str), AdapterError> {
    let prefix = format!("{name}(");
    let rest = input.strip_prefix(&prefix).ok_or_else(|| AdapterError::Syntax {
        message: format!("Expected `{name}(...)`"),
        line: None,
        column: None,
    })?;

    let quote = rest.chars().next().ok_or_else(|| AdapterError::Syntax {
        message: format!("Expected quoted argument in {name}(...)"),
        line: None,
        column: None,
    })?;
    if quote != '\'' && quote != '"' {
        return Err(AdapterError::Syntax {
            message: format!("Expected quoted argument in {name}(...)"),
            line: None,
            column: None,
        });
    }
    let mut i = 1usize;
    let bytes = rest.as_bytes();
    while i < rest.len() {
        if bytes[i] as char == quote && !is_escaped_byte(bytes, i) {
            break;
        }
        i += 1;
    }
    if i >= rest.len() {
        return Err(AdapterError::Syntax {
            message: format!("Unclosed quote in {name}(...)"),
            line: None,
            column: None,
        });
    }
    let value = &rest[1..i];
    let after = &rest[i + 1..];
    let after = after.strip_prefix(')').ok_or_else(|| AdapterError::Syntax {
        message: format!("Expected ')' to close {name}(...)"),
        line: None,
        column: None,
    })?;
    Ok((value.to_string(), after))
}

fn extract_call_args(input: &str) -> Result<(String, String), AdapterError> {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let chars: Vec<char> = input.chars().collect();
    let mut end = None;

    for (i, c) in chars.iter().enumerate() {
        if let Some(q) = quote {
            if *c == q && !is_escaped(&chars, i) {
                quote = None;
            }
            continue;
        }
        match *c {
            '\'' | '"' => quote = Some(*c),
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }

    let Some(end_idx) = end else {
        return Err(AdapterError::Syntax {
            message: "Unclosed function call".to_string(),
            line: None,
            column: None,
        });
    };

    if !input.starts_with('(') {
        return Err(AdapterError::Syntax {
            message: "Expected '('".to_string(),
            line: None,
            column: None,
        });
    }

    let args = input[1..end_idx].to_string();
    let tail = input[end_idx + 1..].to_string();
    Ok((args, tail))
}

fn split_two_args(input: String) -> Result<(String, String), AdapterError> {
    let mut depth_paren = 0i32;
    let mut depth_brace = 0i32;
    let mut depth_bracket = 0i32;
    let mut quote: Option<char> = None;
    let chars: Vec<char> = input.chars().collect();

    for (i, c) in chars.iter().enumerate() {
        if let Some(q) = quote {
            if *c == q && !is_escaped(&chars, i) {
                quote = None;
            }
            continue;
        }
        match *c {
            '\'' | '"' => quote = Some(*c),
            '(' => depth_paren += 1,
            ')' => depth_paren -= 1,
            '{' => depth_brace += 1,
            '}' => depth_brace -= 1,
            '[' => depth_bracket += 1,
            ']' => depth_bracket -= 1,
            ',' if depth_paren == 0 && depth_brace == 0 && depth_bracket == 0 => {
                let a: String = chars[..i].iter().collect();
                let b: String = chars[i + 1..].iter().collect();
                return Ok((a, b));
            }
            _ => {}
        }
    }

    Err(AdapterError::Syntax {
        message: "Expected two comma-separated JSON arguments".to_string(),
        line: None,
        column: None,
    })
}

fn is_escaped(chars: &[char], idx: usize) -> bool {
    if idx == 0 {
        return false;
    }
    let mut backslashes = 0usize;
    let mut i = idx;
    while i > 0 {
        i -= 1;
        if chars[i] == '\\' {
            backslashes += 1;
        } else {
            break;
        }
    }
    backslashes % 2 == 1
}

fn is_escaped_byte(bytes: &[u8], idx: usize) -> bool {
    if idx == 0 {
        return false;
    }
    let mut backslashes = 0usize;
    let mut i = idx;
    while i > 0 {
        i -= 1;
        if bytes[i] == b'\\' {
            backslashes += 1;
        } else {
            break;
        }
    }
    backslashes % 2 == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_statements_handles_escaped_quotes() {
        let cmd = r#"db.getSiblingDB('a').getCollection('c').insertOne({"text":"a\\\"b;still"}) ; db.getSiblingDB('a').getCollection('c').find({});"#;
        let parts = split_statements(cmd);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("insertOne"));
        assert!(parts[1].contains(".find("));
    }

    #[test]
    fn parse_shell_insert_handles_backslash_and_quote() {
        let cmd = r#"db.getSiblingDB('demo').getCollection('notes').insertOne({"value":"c:\\temp\\\"quoted\\\".txt"})"#;
        let (_schema, _collection, op, args, _tail) = parse_shell_command(cmd).expect("parse");
        assert_eq!(op, "insertOne");
        let doc = crate::mongo::parse_json_document(args.trim()).expect("valid json");
        assert_eq!(doc.get_str("value").unwrap_or(""), r#"c:\temp\"quoted\".txt"#);
    }

    #[test]
    fn split_two_args_handles_nested_strings() {
        let args = r#"{"_id":"abc"},{"$set":{"path":"c:\\x\\\"y\\\"","note":"a,b"}} "#.to_string();
        let (a, b) = split_two_args(args).expect("two args");
        assert!(a.contains(r#""_id""#));
        assert!(b.contains(r#""$set""#));
        let _ = crate::mongo::parse_json_document(a.trim()).expect("filter json");
        let _ = crate::mongo::parse_json_document(b.trim()).expect("update json");
    }

    #[test]
    fn parse_shell_bare_get_collection_defaults_to_find() {
        let cmd = r#"db.getCollection("ayah-translations")"#;
        let (schema, collection, op, args, tail) = parse_shell_command(cmd).expect("parse");
        assert_eq!(schema, None);
        assert_eq!(collection, "ayah-translations");
        assert_eq!(op, "find");
        assert_eq!(args, "{}");
        assert!(tail.is_empty());
    }

    #[test]
    fn parse_shell_bare_dot_collection_defaults_to_find() {
        let cmd = r#"db.ayah_translations"#;
        let (schema, collection, op, args, tail) = parse_shell_command(cmd).expect("parse");
        assert_eq!(schema, None);
        assert_eq!(collection, "ayah_translations");
        assert_eq!(op, "find");
        assert_eq!(args, "{}");
        assert!(tail.is_empty());
    }

    #[test]
    fn parse_json_array_accepts_mongo_shell_literals() {
        let pipeline = r#"[
          {
            $lookup: {
              from: 'surah-translations',
              localField: '_id',
              foreignField: 'surah',
              as: 'translations'
            }
          },
          { $limit: 100 }
        ]"#;
        let arr = crate::mongo::parse_json_array(pipeline).expect("parse mongo shell json");
        assert_eq!(arr.len(), 2);
    }
}
