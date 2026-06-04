//! AES-GCM encrypted SQLite-backed app store.
//!
//! The database runs in memory while open. At rest we persist an AES-GCM
//! encrypted serialized SQLite snapshot at `store.db.enc`. The key is
//! compiled into the binary — no password prompt, works on any OS.

pub mod repo;
pub mod repo_app_state;
pub mod repo_ai;
pub mod repo_ai_conv;
pub mod repo_rail;
pub mod schema;

use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use rusqlite::serialize::OwnedData;
use rusqlite::Connection;
use rusqlite::DatabaseName;
use serde::Serialize;

// APP_TOKEN is a 64-char hex string supplied by CI env or `.env` and baked in
// at compile time via build.rs. Do not provide a source-code fallback: release
// builds must use a project-specific token so encrypted stores remain
// consistent across app versions.
fn app_key() -> Result<[u8; 32], StoreError> {
    let hex = option_env!("APP_TOKEN")
        .ok_or_else(|| StoreError::Crypto("APP_TOKEN is not configured for this build".into()))?;
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(StoreError::Crypto("APP_TOKEN must be a 64-character hex string".into()));
    }
    let mut key = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate().take(32) {
        let hi = hex_nibble(chunk[0]);
        let lo = hex_nibble(chunk[1]);
        key[i] = (hi << 4) | lo;
    }
    Ok(key)
}

fn hex_nibble(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        b'A'..=b'F' => b - b'A' + 10,
        _ => 0,
    }
}

const MAGIC: &[u8; 8] = b"TRDBE02\n";
const NONCE_LEN: usize = 12;

pub struct Store {
    inner: Mutex<Option<Connection>>,
    encrypted_path: PathBuf,
    plaintext_path: PathBuf,
    plaintext_backup_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    pub state: SecurityState,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SecurityState {
    Unlocked,
}

impl Store {
    /// Open (or create) the store. Automatically unlocks using the app key.
    pub fn open(app_data_dir: PathBuf) -> Result<Self, StoreError> {
        std::fs::create_dir_all(&app_data_dir).map_err(StoreError::Io)?;
        let encrypted_path = app_data_dir.join("store.db.enc");
        let plaintext_path = app_data_dir.join("store.db");
        let plaintext_backup_path = app_data_dir.join("store.db.plain.backup");

        let store = Self {
            inner: Mutex::new(None),
            encrypted_path,
            plaintext_path,
            plaintext_backup_path,
        };
        store.auto_unlock()?;
        Ok(store)
    }

    fn auto_unlock(&self) -> Result<(), StoreError> {
        let conn = if self.encrypted_path.exists() {
            // Decrypt existing store. If decryption fails (e.g. the file was
            // encrypted with the old password-based scheme from a prior version),
            // move it aside and start fresh rather than crashing the app.
            let bytes = std::fs::read(&self.encrypted_path).map_err(StoreError::Io)?;
            match decrypt_store(&bytes) {
                Ok(plaintext) => {
                    let mut conn = Connection::open_in_memory().map_err(StoreError::Sqlite)?;
                    deserialize_conn(&mut conn, plaintext)?;
                    schema::migrate(&mut conn)?;
                    conn
                }
                Err(_) => {
                    // Back up the incompatible file before writing a fresh store.
                    // Only proceed if the rename succeeds — if it fails we would
                    // overwrite the only copy of the user's data, which is worse
                    // than crashing, so surface the error instead.
                    let bad = self.encrypted_path.with_extension("enc.incompatible");
                    std::fs::rename(&self.encrypted_path, &bad).map_err(StoreError::Io)?;
                    let mut conn = Connection::open_in_memory().map_err(StoreError::Sqlite)?;
                    schema::migrate(&mut conn)?;
                    let snapshot = serialize_conn(&conn)?;
                    write_encrypted(&self.encrypted_path, &snapshot)?;
                    conn
                }
            }
        } else if self.plaintext_path.exists() {
            // One-time migration from legacy plaintext store.
            let mut conn = Connection::open(&self.plaintext_path).map_err(StoreError::Sqlite)?;
            schema::migrate(&mut conn)?;
            let bytes = serialize_conn(&conn)?;
            let mut mem = Connection::open_in_memory().map_err(StoreError::Sqlite)?;
            deserialize_conn(&mut mem, bytes)?;
            schema::migrate(&mut mem)?;
            // Persist encrypted immediately.
            let snapshot = serialize_conn(&mem)?;
            write_encrypted(&self.encrypted_path, &snapshot)?;
            // Move plaintext aside as backup.
            if !self.plaintext_backup_path.exists() {
                let _ = std::fs::rename(&self.plaintext_path, &self.plaintext_backup_path);
            } else {
                let _ = std::fs::remove_file(&self.plaintext_path);
            }
            mem
        } else {
            // Fresh install — create empty schema.
            let mut conn = Connection::open_in_memory().map_err(StoreError::Sqlite)?;
            schema::migrate(&mut conn)?;
            let snapshot = serialize_conn(&conn)?;
            write_encrypted(&self.encrypted_path, &snapshot)?;
            conn
        };

        *self.inner.lock().map_err(|_| StoreError::Locked)? = Some(conn);
        Ok(())
    }

    pub fn status(&self) -> SecurityStatus {
        SecurityStatus { state: SecurityState::Unlocked }
    }

    pub fn remove_plaintext_backup(&self) -> Result<SecurityStatus, StoreError> {
        if self.plaintext_backup_path.exists() {
            std::fs::remove_file(&self.plaintext_backup_path).map_err(StoreError::Io)?;
        }
        Ok(self.status())
    }

    pub fn with_conn<R>(
        &self,
        persist_after: bool,
        f: impl FnOnce(&mut Connection) -> Result<R, StoreError>,
    ) -> Result<R, StoreError> {
        let mut guard = self.inner.lock().map_err(|_| StoreError::Locked)?;
        let result = {
            let conn = guard.as_mut().ok_or(StoreError::Locked)?;
            f(conn)?
        };
        if persist_after {
            let conn = guard.as_ref().ok_or(StoreError::Locked)?;
            let snapshot = serialize_conn(conn)?;
            write_encrypted(&self.encrypted_path, &snapshot)?;
        }
        Ok(result)
    }
}

fn serialize_conn(conn: &Connection) -> Result<Vec<u8>, StoreError> {
    let data = conn
        .serialize(DatabaseName::Main)
        .map_err(StoreError::Sqlite)?;
    Ok(data.to_vec())
}

fn deserialize_conn(conn: &mut Connection, bytes: Vec<u8>) -> Result<(), StoreError> {
    let len = bytes.len();
    let ptr = unsafe { rusqlite::ffi::sqlite3_malloc(len as i32) } as *mut u8;
    let Some(nonnull) = std::ptr::NonNull::new(ptr) else {
        return Err(StoreError::Crypto("sqlite allocation failed".into()));
    };
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), nonnull.as_ptr(), len);
        let owned = OwnedData::from_raw_nonnull(nonnull, len);
        conn.deserialize(DatabaseName::Main, owned, false)
            .map_err(StoreError::Sqlite)?;
    }
    Ok(())
}

fn write_encrypted(path: &PathBuf, plaintext: &[u8]) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(StoreError::Io)?;
    }
    let key = app_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| StoreError::Crypto(format!("cipher init: {e}")))?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|e| StoreError::Crypto(format!("encrypt: {e}")))?;
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    std::fs::write(path, out).map_err(StoreError::Io)
}

fn decrypt_store(bytes: &[u8]) -> Result<Vec<u8>, StoreError> {
    if bytes.len() < MAGIC.len() + NONCE_LEN || &bytes[..MAGIC.len()] != MAGIC {
        return Err(StoreError::Crypto("invalid or legacy store format — store will be reset".into()));
    }
    let nonce = &bytes[MAGIC.len()..MAGIC.len() + NONCE_LEN];
    let ciphertext = &bytes[MAGIC.len() + NONCE_LEN..];
    let key = app_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| StoreError::Crypto(format!("cipher init: {e}")))?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| StoreError::Crypto("decryption failed — store may be corrupted".into()))
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
    #[error("store is locked")]
    Locked,
    #[error("crypto error: {0}")]
    Crypto(String),
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
            StoreError::Locked => "Locked",
            StoreError::Crypto(_) => "Crypto",
        };
        W { kind, message: self.to_string() }.serialize(s)
    }
}
