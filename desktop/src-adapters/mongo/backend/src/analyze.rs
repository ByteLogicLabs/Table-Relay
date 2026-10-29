//! Destructive-command detection for the Mongo shell syntax.

use adapter_api::{CommandWarning, WarningKind};

pub fn analyze_command(command: &str) -> Vec<CommandWarning> {
    let mut warnings = Vec::new();
    let trimmed = command.trim();

    if trimmed.is_empty() {
        return warnings;
    }

    // deleteMany({}) — empty filter = all docs
    if contains_pattern(trimmed, "deleteMany", "{}") {
        warnings.push(CommandWarning {
            kind: WarningKind::DestructiveNoWhere,
            message: "deleteMany({}) will delete all documents in the collection".into(),
            statement: trimmed.to_string(),
        });
    }

    // updateMany({}, ...) — empty filter = all docs
    if contains_pattern(trimmed, "updateMany", "{}") {
        warnings.push(CommandWarning {
            kind: WarningKind::BulkUpdate,
            message: "updateMany({}) will modify all documents in the collection".into(),
            statement: trimmed.to_string(),
        });
    }

    // drop()
    if trimmed.contains(".drop()") {
        warnings.push(CommandWarning {
            kind: WarningKind::DropObject,
            message: "drop() is irreversible".into(),
            statement: trimmed.to_string(),
        });
    }

    // dropDatabase()
    if trimmed.contains("dropDatabase()") {
        warnings.push(CommandWarning {
            kind: WarningKind::DropObject,
            message: "dropDatabase() is irreversible".into(),
            statement: trimmed.to_string(),
        });
    }

    warnings
}

fn contains_pattern(input: &str, method: &str, filter: &str) -> bool {
    let Some(method_pos) = input.find(method) else {
        return false;
    };
    let after = &input[method_pos + method.len()..];
    let after = after.trim_start();
    if !after.starts_with('(') {
        return false;
    }
    let inner = &after[1..];
    let inner = inner.trim_start();
    inner.starts_with(filter)
}
