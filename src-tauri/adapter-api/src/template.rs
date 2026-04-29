//! Tiny `{a.b.c}` template renderer used to splice runtime context
//! into adapter-shipped markdown templates (`templates/*.md` inside
//! each `src-adapters/<key>/` package).
//!
//! Rules — kept deliberately small so adapter authors can predict the
//! behavior without reading code:
//!
//! - `{path}` is replaced with the JSON value at `path`. Dotted parts
//!   walk objects (`{user.name}`); unsigned integers index arrays
//!   (`{tags.0}`).
//! - Strings render unquoted; other JSON values render via
//!   `serde_json` (so `42`, `true`, `null`, etc).
//! - Missing paths render as the empty string. Adapter templates are
//!   shipped by the adapter author, not user-supplied, so a typo there
//!   should produce a visibly empty hole — not a panic in the AI
//!   pipeline.
//! - `{{` and `}}` are literal `{` / `}`. No filters, no conditionals;
//!   if a template needs logic, it should live in code, not in
//!   markdown.

use serde_json::Value;

/// Render `template`, substituting `{path}` placeholders against `ctx`.
///
/// `ctx` is typically a `serde_json::json!({ ... })` object. Pass
/// `Value::Null` for a no-op render (any placeholder yields an empty
/// string).
pub fn render(template: &str, ctx: &Value) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // Escapes: `{{` -> `{`, `}}` -> `}`.
        if c == b'{' && bytes.get(i + 1) == Some(&b'{') {
            out.push('{');
            i += 2;
            continue;
        }
        if c == b'}' && bytes.get(i + 1) == Some(&b'}') {
            out.push('}');
            i += 2;
            continue;
        }
        if c == b'{' {
            // Find the matching close. `{path}` is single-line; a
            // newline inside aborts the expansion (treat the `{` as
            // literal so a stray brace in prose doesn't eat the rest
            // of the document).
            if let Some(end) = find_close(bytes, i + 1) {
                let raw = &template[i + 1..end];
                out.push_str(&lookup(ctx, raw.trim()));
                i = end + 1;
                continue;
            }
        }
        out.push(c as char);
        i += 1;
    }
    out
}

fn find_close(bytes: &[u8], start: usize) -> Option<usize> {
    let mut j = start;
    while j < bytes.len() {
        match bytes[j] {
            b'}' => return Some(j),
            b'\n' | b'{' => return None,
            _ => j += 1,
        }
    }
    None
}

fn lookup(ctx: &Value, path: &str) -> String {
    let mut cur = ctx;
    for part in path.split('.') {
        if part.is_empty() {
            return String::new();
        }
        cur = match cur {
            Value::Object(map) => match map.get(part) {
                Some(v) => v,
                None => return String::new(),
            },
            Value::Array(arr) => match part.parse::<usize>().ok().and_then(|i| arr.get(i)) {
                Some(v) => v,
                None => return String::new(),
            },
            _ => return String::new(),
        };
    }
    match cur {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn substitutes_dotted_paths() {
        let ctx = json!({ "user": { "name": "Ada" }, "tags": ["a", "b"] });
        assert_eq!(render("Hello {user.name}", &ctx), "Hello Ada");
        assert_eq!(render("first={tags.0}", &ctx), "first=a");
    }

    #[test]
    fn missing_paths_render_empty() {
        let ctx = json!({});
        assert_eq!(render("[{nope.here}]", &ctx), "[]");
    }

    #[test]
    fn double_braces_escape() {
        let ctx = json!({});
        assert_eq!(render("{{literal}}", &ctx), "{literal}");
    }

    #[test]
    fn unmatched_brace_is_literal() {
        let ctx = json!({});
        assert_eq!(render("a { b", &ctx), "a { b");
    }

    #[test]
    fn newline_inside_aborts_expansion() {
        let ctx = json!({});
        assert_eq!(render("a {\nb} c", &ctx), "a {\nb} c");
    }
}
