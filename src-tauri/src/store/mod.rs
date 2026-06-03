//! Encrypted SQLite-backed app store.
//!
//! The database runs in memory while the app is unlocked. At rest we persist
//! an AES-GCM encrypted serialized SQLite snapshot at `store.db.enc`.
//! Existing plaintext `store.db` files are migrated after the user creates an
//! app password.

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
use argon2::Argon2;
use rand::RngCore;
use rusqlite::serialize::OwnedData;
use rusqlite::Connection;
use rusqlite::DatabaseName;
use serde::Serialize;
use zeroize::Zeroizing;

pub struct Store {
    inner: Mutex<StoreInner>,
    encrypted_path: PathBuf,
    plaintext_path: PathBuf,
    plaintext_backup_path: PathBuf,
}

struct StoreInner {
    db: Option<Connection>,
    key: Option<Zeroizing<[u8; 32]>>,
    salt: Option<[u8; SALT_LEN]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    pub state: SecurityState,
    pub encrypted_store_exists: bool,
    pub plaintext_store_exists: bool,
    pub plaintext_backup_exists: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecurityState {
    Uninitialized,
    NeedsMigration,
    Locked,
    Unlocked,
}

const MAGIC: &[u8; 8] = b"TRDBE01\n";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

impl Store {
    pub fn open(app_data_dir: PathBuf) -> Result<Self, StoreError> {
        std::fs::create_dir_all(&app_data_dir).map_err(StoreError::Io)?;
        let encrypted_path = app_data_dir.join("store.db.enc");
        let plaintext_path = app_data_dir.join("store.db");
        let plaintext_backup_path = app_data_dir.join("store.db.plain.backup");
        Ok(Self {
            inner: Mutex::new(StoreInner {
                db: None,
                key: None,
                salt: None,
            }),
            encrypted_path,
            plaintext_path,
            plaintext_backup_path,
        })
    }

    pub fn status(&self) -> SecurityStatus {
        let unlocked = self.inner.lock().map(|g| g.db.is_some()).unwrap_or(false);
        let encrypted_store_exists = self.encrypted_path.exists();
        let plaintext_store_exists = self.plaintext_path.exists();
        let plaintext_backup_exists = self.plaintext_backup_path.exists();
        let state = if unlocked {
            SecurityState::Unlocked
        } else if encrypted_store_exists {
            SecurityState::Locked
        } else if plaintext_store_exists {
            SecurityState::NeedsMigration
        } else {
            SecurityState::Uninitialized
        };
        SecurityStatus {
            state,
            encrypted_store_exists,
            plaintext_store_exists,
            plaintext_backup_exists,
        }
    }

    pub fn initialize(&self, password: &str) -> Result<SecurityStatus, StoreError> {
        if password.is_empty() {
            return Err(StoreError::Crypto("password cannot be empty".into()));
        }
        if self.encrypted_path.exists() {
            return Err(StoreError::Crypto("encrypted store already exists".into()));
        }

        let mut salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let key = derive_key(password, &salt)?;

        let mut conn = if self.plaintext_path.exists() {
            let mut plain = Connection::open(&self.plaintext_path).map_err(StoreError::Sqlite)?;
            schema::migrate(&mut plain)?;
            let bytes = serialize_conn(&plain)?;
            let mut mem = Connection::open_in_memory().map_err(StoreError::Sqlite)?;
            deserialize_conn(&mut mem, bytes)?;
            mem
        } else {
            let mut mem = Connection::open_in_memory().map_err(StoreError::Sqlite)?;
            schema::migrate(&mut mem)?;
            mem
        };
        schema::migrate(&mut conn)?;

        let snapshot = serialize_conn(&conn)?;
        write_encrypted(&self.encrypted_path, &snapshot, &key, salt)?;
        if self.plaintext_path.exists() {
            if self.plaintext_backup_path.exists() {
                std::fs::remove_file(&self.plaintext_backup_path).map_err(StoreError::Io)?;
            }
            std::fs::rename(&self.plaintext_path, &self.plaintext_backup_path)
                .map_err(StoreError::Io)?;
        }

        let mut inner = self.inner.lock().map_err(|_| StoreError::Locked)?;
        inner.db = Some(conn);
        inner.key = Some(Zeroizing::new(key));
        inner.salt = Some(salt);
        drop(inner);
        Ok(self.status())
    }

    pub fn unlock(&self, password: &str) -> Result<SecurityStatus, StoreError> {
        if password.is_empty() {
            return Err(StoreError::Crypto("password cannot be empty".into()));
        }
        let encrypted = std::fs::read(&self.encrypted_path).map_err(StoreError::Io)?;
        let (salt, plaintext) = decrypt_store(&encrypted, password)?;
        let mut conn = Connection::open_in_memory().map_err(StoreError::Sqlite)?;
        deserialize_conn(&mut conn, plaintext)?;
        schema::migrate(&mut conn)?;

        let key = derive_key(password, &salt)?;
        let mut inner = self.inner.lock().map_err(|_| StoreError::Locked)?;
        inner.db = Some(conn);
        inner.key = Some(Zeroizing::new(key));
        inner.salt = Some(salt);
        drop(inner);
        Ok(self.status())
    }

    pub fn lock(&self) -> Result<SecurityStatus, StoreError> {
        let mut inner = self.inner.lock().map_err(|_| StoreError::Locked)?;
        inner.db = None;
        inner.key = None;
        inner.salt = None;
        drop(inner);
        Ok(self.status())
    }

    /// Delete the plaintext migration backup (`store.db.plain.backup`) once the
    /// user has confirmed the encrypted store opens correctly. No-op if it's
    /// already gone. Returns the refreshed status.
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
        let mut inner = self.inner.lock().map_err(|_| StoreError::Locked)?;
        let result = {
            let conn = inner.db.as_mut().ok_or(StoreError::Locked)?;
            f(conn)?
        };
        if persist_after {
            self.persist_locked(&inner)?;
        }
        Ok(result)
    }

    fn persist_locked(&self, inner: &StoreInner) -> Result<(), StoreError> {
        let conn = inner.db.as_ref().ok_or(StoreError::Locked)?;
        let key = inner.key.as_ref().ok_or(StoreError::Locked)?;
        let salt = inner.salt.ok_or(StoreError::Locked)?;
        let snapshot = serialize_conn(conn)?;
        write_encrypted(&self.encrypted_path, &snapshot, key, salt)
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

fn derive_key(password: &str, salt: &[u8; SALT_LEN]) -> Result<[u8; KEY_LEN], StoreError> {
    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| StoreError::Crypto(format!("key derivation failed: {e}")))?;
    Ok(key)
}

fn write_encrypted(
    path: &PathBuf,
    plaintext: &[u8],
    key: &[u8; KEY_LEN],
    salt: [u8; SALT_LEN],
) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(StoreError::Io)?;
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| StoreError::Crypto(format!("cipher init failed: {e}")))?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|e| StoreError::Crypto(format!("encrypt failed: {e}")))?;
    let mut out = Vec::with_capacity(MAGIC.len() + SALT_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    std::fs::write(path, out).map_err(StoreError::Io)
}

fn decrypt_store(bytes: &[u8], password: &str) -> Result<([u8; SALT_LEN], Vec<u8>), StoreError> {
    if bytes.len() < MAGIC.len() + SALT_LEN + NONCE_LEN || &bytes[..MAGIC.len()] != MAGIC {
        return Err(StoreError::Crypto("invalid encrypted store format".into()));
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[MAGIC.len()..MAGIC.len() + SALT_LEN]);
    let nonce_start = MAGIC.len() + SALT_LEN;
    let nonce_end = nonce_start + NONCE_LEN;
    let nonce = &bytes[nonce_start..nonce_end];
    let ciphertext = &bytes[nonce_end..];
    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| StoreError::Crypto(format!("cipher init failed: {e}")))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| StoreError::Crypto("incorrect password or corrupted store".into()))?;
    Ok((salt, plaintext))
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
        W {
            kind,
            message: self.to_string(),
        }
        .serialize(s)
    }
}
