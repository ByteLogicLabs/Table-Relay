//! Import connections from a TablePlus `.tableplusconnection` export.
//!
//! The export file is encrypted with **RNCryptor v3** (the format TablePlus
//! uses for password-protected exports):
//!
//!   byte 0      : version (0x03)
//!   byte 1      : options (0x01 = password-based; we only support this)
//!   bytes 2..10 : encryption-key PBKDF2 salt (8 bytes)
//!   bytes 10..18: HMAC-key PBKDF2 salt (8 bytes)
//!   bytes 18..34: AES-CBC IV (16 bytes)
//!   bytes 34..N : AES-256-CBC ciphertext (PKCS#7 padded)
//!   last 32     : HMAC-SHA256 over everything preceding it
//!
//! Keys are derived with PBKDF2-HMAC-SHA1, 10_000 iterations, 32-byte output.
//!
//! Decrypted payload is a JSON array of TablePlus connection objects, which we
//! map onto our own `ConnectionProfileInput`. The command only DECODES and
//! returns the candidates — the frontend previews them and calls the existing
//! `connections_save` for the ones the user accepts.

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;
use sha2::Sha256;

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, thiserror::Error)]
pub enum TablePlusError {
    #[error("io error: {0}")]
    Io(String),
    #[error("file is not a valid TablePlus export (bad RNCryptor header)")]
    BadFormat,
    #[error("wrong password (decryption integrity check failed)")]
    BadPassword,
    #[error("decrypted payload is not valid TablePlus JSON: {0}")]
    BadPayload(String),
}

impl serde::Serialize for TablePlusError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct W<'a> {
            kind: &'a str,
            message: String,
        }
        let kind = match self {
            TablePlusError::Io(_) => "Io",
            TablePlusError::BadFormat => "BadFormat",
            TablePlusError::BadPassword => "BadPassword",
            TablePlusError::BadPayload(_) => "BadPayload",
        };
        W { kind, message: self.to_string() }.serialize(s)
    }
}

/// One importable connection plus enough context for the UI to preview it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: Option<String>,
    pub ssh_enabled: bool,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub ssh_auth_kind: Option<String>,
    pub ssh_key_path: Option<String>,
    pub ssh_password: Option<String>,
    pub color: Option<String>,
    pub environment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub candidates: Vec<ImportCandidate>,
    /// Connection names we skipped because their driver isn't supported here
    /// (e.g. BigQuery). Surfaced so the user knows nothing silently vanished.
    pub skipped: Vec<SkippedEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub name: String,
    pub driver: String,
    pub reason: String,
}

#[tauri::command]
pub fn tableplus_import(path: String, password: String) -> Result<ImportResult, TablePlusError> {
    let data = std::fs::read(&path).map_err(|e| TablePlusError::Io(e.to_string()))?;
    let plaintext = rncryptor_decrypt(&data, password.as_bytes())?;
    parse_connections(&plaintext)
}

// ── RNCryptor v3 ────────────────────────────────────────────────────────────

fn rncryptor_decrypt(data: &[u8], password: &[u8]) -> Result<Vec<u8>, TablePlusError> {
    // version(1) options(1) encSalt(8) hmacSalt(8) iv(16) ... hmac(32)
    const HEADER: usize = 1 + 1 + 8 + 8 + 16;
    const HMAC_LEN: usize = 32;
    if data.len() < HEADER + HMAC_LEN || data[0] != 0x03 {
        return Err(TablePlusError::BadFormat);
    }

    let enc_salt = &data[2..10];
    let hmac_salt = &data[10..18];
    let iv = &data[18..34];
    let (signed, file_hmac) = data.split_at(data.len() - HMAC_LEN);
    let ciphertext = &signed[HEADER..];

    let enc_key = pbkdf2_sha1(password, enc_salt);
    let hmac_key = pbkdf2_sha1(password, hmac_salt);

    // Verify HMAC over [version .. end-of-ciphertext] BEFORE decrypting. A
    // mismatch means a wrong password (or a tampered file).
    let mut mac = HmacSha256::new_from_slice(&hmac_key).expect("hmac key length");
    mac.update(signed);
    if mac.verify_slice(file_hmac).is_err() {
        return Err(TablePlusError::BadPassword);
    }

    let cipher = Aes256CbcDec::new_from_slices(&enc_key, iv).map_err(|_| TablePlusError::BadFormat)?;
    let mut buf = ciphertext.to_vec();
    let pt = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| TablePlusError::BadPassword)?;
    Ok(pt.to_vec())
}

fn pbkdf2_sha1(password: &[u8], salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2::<Hmac<Sha1>>(password, salt, 10_000, &mut key);
    key
}

// ── TablePlus JSON → ImportCandidate ────────────────────────────────────────

fn parse_connections(plaintext: &[u8]) -> Result<ImportResult, TablePlusError> {
    let arr: Vec<serde_json::Value> =
        serde_json::from_slice(plaintext).map_err(|e| TablePlusError::BadPayload(e.to_string()))?;

    let mut candidates = Vec::new();
    let mut skipped = Vec::new();

    for c in &arr {
        let name = str_field(c, "ConnectionName").unwrap_or_else(|| "(unnamed)".into());
        let tp_driver = str_field(c, "Driver").unwrap_or_default();

        let driver = match map_driver(&tp_driver) {
            Some(d) => d,
            None => {
                // An empty Driver usually means an incomplete/placeholder row in
                // the export — skip silently. A non-empty but unknown driver
                // (BigQuery, etc.) we report so the user knows.
                if !tp_driver.is_empty() {
                    skipped.push(SkippedEntry {
                        name,
                        driver: tp_driver,
                        reason: "unsupported database type".into(),
                    });
                }
                continue;
            }
        };

        let host = str_field(c, "DatabaseHost").unwrap_or_else(|| "127.0.0.1".into());
        let port = parse_port(c, &tp_driver);

        let ssh_enabled = bool_field(c, "isOverSSH");
        let use_key = bool_field(c, "isUsePrivateKey");
        let (ssh_auth_kind, ssh_key_path) = if ssh_enabled {
            if use_key {
                (Some("key".to_string()), tls_key_first(c))
            } else {
                (Some("password".to_string()), None)
            }
        } else {
            (None, None)
        };

        candidates.push(ImportCandidate {
            name,
            driver: driver.to_string(),
            host,
            port,
            user: str_field(c, "DatabaseUser"),
            password: str_field(c, "DatabasePassword"),
            database: str_field(c, "DatabaseName"),
            ssl_mode: None,
            ssh_enabled,
            ssh_host: ssh_enabled.then(|| str_field(c, "ServerAddress")).flatten(),
            ssh_port: ssh_enabled.then(|| parse_u16(c, "ServerPort").or(Some(22))).flatten(),
            ssh_user: ssh_enabled.then(|| str_field(c, "ServerUser")).flatten(),
            ssh_auth_kind,
            ssh_key_path,
            ssh_password: ssh_enabled.then(|| str_field(c, "ServerPassword")).flatten(),
            color: str_field(c, "statusColor"),
            environment: str_field(c, "Enviroment"), // TablePlus's own spelling
        });
    }

    Ok(ImportResult { candidates, skipped })
}

/// TablePlus driver name → our `Driver` enum string. Returns None for empty or
/// unsupported drivers.
fn map_driver(tp: &str) -> Option<&'static str> {
    match tp {
        "MySQL" | "MariaDB" => Some("MySQL"),
        "PostgreSQL" | "Postgres" | "Redshift" | "CockroachDB" => Some("PostgreSQL"),
        "Redis" => Some("Redis"),
        "Mongo" | "MongoDB" => Some("MongoDB"),
        "SQLite" => Some("SQLite"),
        _ => None,
    }
}

/// Default port per driver if the export has none.
fn default_port(tp_driver: &str) -> u16 {
    match tp_driver {
        "PostgreSQL" | "Postgres" | "Redshift" | "CockroachDB" => 5432,
        "Redis" => 6379,
        "Mongo" | "MongoDB" => 27017,
        _ => 3306, // MySQL / MariaDB
    }
}

fn parse_port(c: &serde_json::Value, tp_driver: &str) -> u16 {
    parse_u16(c, "DatabasePort").unwrap_or_else(|| default_port(tp_driver))
}

// ── small JSON helpers ──────────────────────────────────────────────────────

/// TablePlus stores most scalars as strings, so accept either a JSON string or
/// number and return a non-empty owned String.
fn str_field(c: &serde_json::Value, key: &str) -> Option<String> {
    let v = c.get(key)?;
    let s = match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn parse_u16(c: &serde_json::Value, key: &str) -> Option<u16> {
    match c.get(key)? {
        serde_json::Value::String(s) => s.parse().ok(),
        serde_json::Value::Number(n) => n.as_u64().and_then(|x| u16::try_from(x).ok()),
        _ => None,
    }
}

fn bool_field(c: &serde_json::Value, key: &str) -> bool {
    c.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// `TlsKeyPaths` is a 3-element array `[ca, cert, key]` in TablePlus; for an SSH
/// private key the path lands in one of the slots. Return the first non-empty.
fn tls_key_first(c: &serde_json::Value) -> Option<String> {
    c.get("TlsKeyPaths")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str())
        .find(|s| !s.is_empty())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_rncryptor_header() {
        assert!(matches!(
            rncryptor_decrypt(b"not an rncryptor file at all....................................", b"x"),
            Err(TablePlusError::BadFormat)
        ));
    }

    #[test]
    fn maps_tableplus_drivers_and_ssh() {
        let json = serde_json::json!([
            {
                "ConnectionName": "Prod MySQL",
                "Driver": "MySQL",
                "DatabaseHost": "db.example.com",
                "DatabasePort": "3306",
                "DatabaseUser": "root",
                "DatabasePassword": "pw",
                "DatabaseName": "app",
                "isOverSSH": true,
                "isUsePrivateKey": true,
                "ServerAddress": "bastion.example.com",
                "ServerPort": "2222",
                "ServerUser": "deploy",
                "TlsKeyPaths": ["", "", "/home/me/.ssh/id_ed25519"],
                "statusColor": "#ff0000",
                "Enviroment": "production"
            },
            { "ConnectionName": "Analytics", "Driver": "BigQuery" },
            { "ConnectionName": "Cache", "Driver": "Redis", "DatabaseHost": "127.0.0.1" }
        ]);
        let res = parse_connections(serde_json::to_vec(&json).unwrap().as_slice()).unwrap();

        // BigQuery is unsupported → skipped (reported), not imported.
        assert_eq!(res.candidates.len(), 2);
        assert_eq!(res.skipped.len(), 1);
        assert_eq!(res.skipped[0].driver, "BigQuery");

        let my = &res.candidates[0];
        assert_eq!(my.driver, "MySQL");
        assert_eq!(my.port, 3306);
        assert!(my.ssh_enabled);
        assert_eq!(my.ssh_auth_kind.as_deref(), Some("key"));
        assert_eq!(my.ssh_key_path.as_deref(), Some("/home/me/.ssh/id_ed25519"));
        assert_eq!(my.ssh_port, Some(2222));
        assert_eq!(my.color.as_deref(), Some("#ff0000"));

        // Redis with no port → driver default (6379).
        let redis = &res.candidates[1];
        assert_eq!(redis.driver, "Redis");
        assert_eq!(redis.port, 6379);
    }
}
