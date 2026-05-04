//! Plain SQLite-backed connection store.
//!
//! No encryption, no master password — this is the dev/explicitly-insecure
//! variant. Passwords and SSH secrets are stored in the clear.
//!
//! When we re-add encryption later, the migration path is:
//!   1. Reintroduce the `vault` module from M0 commit history.
//!   2. Copy existing rows through an on-the-fly encrypt step.

pub mod repo;
pub mod repo_ai;
pub mod repo_ai_conv;
pub mod repo_rail;
pub mod schema;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

pub struct Store {
    pub(crate) db: Mutex<Connection>,
}

impl Store {
    pub fn open(path: PathBuf) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(StoreError::Io)?;
        }
        let mut conn = Connection::open(&path).map_err(StoreError::Sqlite)?;
        schema::migrate(&mut conn)?;
        Ok(Self { db: Mutex::new(conn) })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(String),
    #[error("not found")]
    NotFound,
}

impl serde::Serialize for StoreError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(serde::Serialize)]
        struct W<'a> {
            kind: &'a str,
            message: String,
        }
        let kind = match self {
            StoreError::Io(_) => "Io",
            StoreError::Sqlite(_) => "Sqlite",
            StoreError::Migration(_) => "Migration",
            StoreError::NotFound => "NotFound",
        };
        W { kind, message: self.to_string() }.serialize(s)
    }
}
