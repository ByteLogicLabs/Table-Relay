//! Destructive-command detection for the query editor warning system.
//! Regex-based, runs on the raw SQL text before execution.

use adapter_api::{CommandWarning, WarningKind};

use crate::mysql::split_statements;

/// Analyze a raw command (possibly multi-statement) and return warnings
/// for any destructive patterns detected. Returns an empty vec when
/// every statement looks safe.
pub fn analyze_command(command: &str) -> Vec<CommandWarning> {
    let statements = split_statements(command);
    let mut warnings = Vec::new();

    for sql in &statements {
        let trimmed = sql.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(w) = analyze_single(trimmed) {
            warnings.push(w);
        }
    }

    warnings
}

fn analyze_single(sql: &str) -> Option<CommandWarning> {
    let upper = sql.trim_start().to_ascii_uppercase();

    // DELETE without WHERE
    if upper.starts_with("DELETE") {
        let has_where = find_keyword(&upper, "WHERE");
        if !has_where {
            return Some(CommandWarning {
                kind: WarningKind::DestructiveNoWhere,
                message: "DELETE without WHERE clause will affect all rows".into(),
                statement: sql.to_string(),
            });
        }
    }

    // UPDATE without WHERE
    if upper.starts_with("UPDATE") {
        let has_where = find_keyword(&upper, "WHERE");
        if !has_where {
            return Some(CommandWarning {
                kind: WarningKind::DestructiveNoWhere,
                message: "UPDATE without WHERE clause will modify all rows".into(),
                statement: sql.to_string(),
            });
        }
    }

    // TRUNCATE
    if upper.starts_with("TRUNCATE") {
        return Some(CommandWarning {
            kind: WarningKind::TruncateTable,
            message: "TRUNCATE will remove all rows from the table".into(),
            statement: sql.to_string(),
        });
    }

    // DROP TABLE / DATABASE / SCHEMA / INDEX
    if upper.starts_with("DROP ") {
        let obj_type = upper[5..].trim_start();
        let kind = if obj_type.starts_with("TABLE") {
            WarningKind::DropObject
        } else if obj_type.starts_with("DATABASE") || obj_type.starts_with("SCHEMA") {
            WarningKind::DropObject
        } else if obj_type.starts_with("INDEX") {
            WarningKind::DropObject
        } else {
            WarningKind::DropObject
        };
        return Some(CommandWarning {
            kind,
            message: format!(
                "DROP {} is irreversible",
                obj_type.split_whitespace().next().unwrap_or("object")
            ),
            statement: sql.to_string(),
        });
    }

    // ALTER TABLE ... DROP
    if upper.starts_with("ALTER") && find_keyword(&upper, "DROP") {
        return Some(CommandWarning {
            kind: WarningKind::DropObject,
            message: "ALTER TABLE ... DROP is irreversible".into(),
            statement: sql.to_string(),
        });
    }

    None
}

/// Case-insensitive keyword search that respects basic quoting.
fn find_keyword(upper: &str, keyword: &str) -> bool {
    // Simple approach: look for the keyword as a whole word
    let mut start = 0;
    while let Some(pos) = upper[start..].find(keyword) {
        let abs_pos = start + pos;
        let before_ok = abs_pos == 0
            || !upper.as_bytes()[abs_pos - 1].is_ascii_alphanumeric();
        let after_pos = abs_pos + keyword.len();
        let after_ok = after_pos >= upper.len()
            || !upper.as_bytes()[after_pos].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = abs_pos + keyword.len();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_without_where() {
        let warnings = analyze_command("DELETE FROM users");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(warnings[0].kind, WarningKind::DestructiveNoWhere));
    }

    #[test]
    fn delete_with_where_is_safe() {
        let warnings = analyze_command("DELETE FROM users WHERE id = 1");
        assert!(warnings.is_empty());
    }

    #[test]
    fn update_without_where() {
        let warnings = analyze_command("UPDATE users SET active = 0");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(warnings[0].kind, WarningKind::DestructiveNoWhere));
    }

    #[test]
    fn update_with_where_is_safe() {
        let warnings = analyze_command("UPDATE users SET active = 0 WHERE id = 1");
        assert!(warnings.is_empty());
    }

    #[test]
    fn truncate_table() {
        let warnings = analyze_command("TRUNCATE TABLE users");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(warnings[0].kind, WarningKind::TruncateTable));
    }

    #[test]
    fn drop_table() {
        let warnings = analyze_command("DROP TABLE users");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(warnings[0].kind, WarningKind::DropObject));
    }

    #[test]
    fn drop_database() {
        let warnings = analyze_command("DROP DATABASE mydb");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(warnings[0].kind, WarningKind::DropObject));
    }

    #[test]
    fn alter_table_drop_column() {
        let warnings = analyze_command("ALTER TABLE users DROP COLUMN name");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(warnings[0].kind, WarningKind::DropObject));
    }

    #[test]
    fn multi_statement_mixed() {
        let warnings = analyze_command("SELECT 1; DELETE FROM users; UPDATE t SET x = 1");
        assert_eq!(warnings.len(), 2);
    }

    #[test]
    fn select_is_safe() {
        let warnings = analyze_command("SELECT * FROM users WHERE id = 1");
        assert!(warnings.is_empty());
    }

    #[test]
    fn insert_is_safe() {
        let warnings = analyze_command("INSERT INTO users (name) VALUES ('test')");
        assert!(warnings.is_empty());
    }
}
