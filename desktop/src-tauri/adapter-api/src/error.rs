//! Unified error every adapter returns. Serializes to `{kind, message}`
//! so the UI can branch on `kind` and fall back to the human-readable
//! `message` for anything unknown.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("connection error: {0}")]
    Connection(String),
    #[error("authentication failed: {0}")]
    Authentication(String),
    #[error("syntax error: {message}")]
    Syntax {
        message: String,
        line: Option<u32>,
        column: Option<u32>,
    },
    #[error("not found: {0}")]
    NotFound(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("timeout")]
    Timeout,
    #[error("ssh tunnel error: {0}")]
    SshTunnel(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}

impl AdapterError {
    /// Is this the kind of error a reconnect could plausibly fix?
    /// Auth/NotFound/Syntax/Unsupported would produce the same error
    /// on a fresh pool — no point retrying.
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            AdapterError::Connection(_)
                | AdapterError::Timeout
                | AdapterError::Io(_)
                | AdapterError::SshTunnel(_)
        )
    }
}

impl Serialize for AdapterError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Wire<'a> {
            kind: &'a str,
            message: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            line: Option<u32>,
            #[serde(skip_serializing_if = "Option::is_none")]
            column: Option<u32>,
        }
        let (kind, line, column) = match self {
            AdapterError::Connection(_) => ("Connection", None, None),
            AdapterError::Authentication(_) => ("Authentication", None, None),
            AdapterError::Syntax { line, column, .. } => ("Syntax", *line, *column),
            AdapterError::NotFound(_) => ("NotFound", None, None),
            AdapterError::Unsupported(_) => ("Unsupported", None, None),
            AdapterError::Timeout => ("Timeout", None, None),
            AdapterError::SshTunnel(_) => ("SshTunnel", None, None),
            AdapterError::Io(_) => ("Io", None, None),
            AdapterError::Other(_) => ("Other", None, None),
        };
        Wire {
            kind,
            message: self.to_string(),
            line,
            column,
        }
        .serialize(s)
    }
}

/// Bridge from `sqlx::Error` — gated so non-sqlx adapters don't pull
/// sqlx. Every variant maps to the closest `AdapterError` kind so the
/// frontend's per-kind branching stays useful.
#[cfg(feature = "sqlx")]
impl From<sqlx::Error> for AdapterError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::Database(db) => {
                if let Some(code) = db.code() {
                    // MySQL: 28000 / 1045 = access denied.
                    if code == "28000" || code == "1045" {
                        return AdapterError::Authentication(db.message().to_string());
                    }
                }
                AdapterError::Syntax {
                    message: db.message().to_string(),
                    line: None,
                    column: None,
                }
            }
            sqlx::Error::Io(_) | sqlx::Error::Tls(_) => AdapterError::Connection(e.to_string()),
            sqlx::Error::PoolTimedOut => AdapterError::Timeout,
            _ => AdapterError::Other(e.to_string()),
        }
    }
}
