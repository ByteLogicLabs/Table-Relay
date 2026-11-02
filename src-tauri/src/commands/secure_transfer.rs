//! Password-encrypted export/import for backup files (settings, connections,
//! AI credentials, conversations).
//!
//! Files are encrypted with **RNCryptor v3** — the same AES-256-CBC +
//! PBKDF2-HMAC-SHA1 + HMAC-SHA256 format we already read for TablePlus imports.
//! Reusing it means our exports are interoperable with any RNCryptor tool and
//! the crypto lives in one place.
//!
//!   byte 0      : version (0x03)
//!   byte 1      : options (0x01 = password-based)
//!   bytes 2..10 : encryption-key PBKDF2 salt (8 bytes)
//!   bytes 10..18: HMAC-key PBKDF2 salt (8 bytes)
//!   bytes 18..34: AES-CBC IV (16 bytes)
//!   bytes 34..N : AES-256-CBC ciphertext (PKCS#7 padded)
//!   last 32     : HMAC-SHA256 over everything preceding it

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Serialize;
use sha1::Sha1;
use sha2::Sha256;

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, thiserror::Error)]
pub enum SecureError {
    #[error("io error: {0}")]
    Io(String),
    #[error("file is not an encrypted Table Relay export")]
    BadFormat,
    #[error("wrong password")]
    BadPassword,
    #[error("decrypted payload is not valid UTF-8: {0}")]
    BadPayload(String),
}

impl serde::Serialize for SecureError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct W<'a> {
            kind: &'a str,
            message: String,
        }
        let kind = match self {
            SecureError::Io(_) => "Io",
            SecureError::BadFormat => "BadFormat",
            SecureError::BadPassword => "BadPassword",
            SecureError::BadPayload(_) => "BadPayload",
        };
        W { kind, message: self.to_string() }.serialize(s)
    }
}

/// Encrypt `json` with `password` (RNCryptor v3) and write the bytes to `path`.
#[tauri::command]
pub fn secure_export(path: String, json: String, password: String) -> Result<(), SecureError> {
    let blob = rncryptor_encrypt(json.as_bytes(), password.as_bytes());
    std::fs::write(&path, blob).map_err(|e| SecureError::Io(e.to_string()))
}

/// Read `path`, RNCryptor-decrypt it with `password`, and return the JSON text.
#[tauri::command]
pub fn secure_import(path: String, password: String) -> Result<String, SecureError> {
    let data = std::fs::read(&path).map_err(|e| SecureError::Io(e.to_string()))?;
    let plaintext = rncryptor_decrypt(&data, password.as_bytes())?;
    String::from_utf8(plaintext).map_err(|e| SecureError::BadPayload(e.to_string()))
}

/// Cheap structural check: does this file look like an RNCryptor v3 blob?
/// Lets the frontend offer a password prompt only for encrypted files and read
/// older plaintext-JSON exports directly.
#[tauri::command]
pub fn secure_is_encrypted(path: String) -> Result<bool, SecureError> {
    let data = std::fs::read(&path).map_err(|e| SecureError::Io(e.to_string()))?;
    const HEADER: usize = 1 + 1 + 8 + 8 + 16;
    const HMAC_LEN: usize = 32;
    // Version byte 0x03, options 0x01, and enough length for header + hmac.
    Ok(data.len() >= HEADER + HMAC_LEN && data[0] == 0x03 && data[1] == 0x01)
}

// ── RNCryptor v3 ────────────────────────────────────────────────────────────

fn rncryptor_encrypt(plaintext: &[u8], password: &[u8]) -> Vec<u8> {
    let mut rng = rand::thread_rng();
    let mut enc_salt = [0u8; 8];
    let mut hmac_salt = [0u8; 8];
    let mut iv = [0u8; 16];
    rng.fill_bytes(&mut enc_salt);
    rng.fill_bytes(&mut hmac_salt);
    rng.fill_bytes(&mut iv);

    let enc_key = pbkdf2_sha1(password, &enc_salt);
    let hmac_key = pbkdf2_sha1(password, &hmac_salt);

    // Header: version, options, salts, iv.
    let mut out = Vec::with_capacity(34 + plaintext.len() + 16 + 32);
    out.push(0x03);
    out.push(0x01);
    out.extend_from_slice(&enc_salt);
    out.extend_from_slice(&hmac_salt);
    out.extend_from_slice(&iv);

    // Encrypt in place. PKCS#7 always adds 1..=16 bytes, so size the buffer up
    // to the next 16-byte boundary past the plaintext length.
    let cipher = Aes256CbcEnc::new_from_slices(&enc_key, &iv).expect("aes key/iv length");
    let mut buf = plaintext.to_vec();
    let msg_len = buf.len();
    buf.resize(msg_len + 16 - (msg_len % 16), 0);
    let ciphertext = cipher
        .encrypt_padded_mut::<Pkcs7>(&mut buf, msg_len)
        .expect("buffer sized for pkcs7 padding");
    out.extend_from_slice(ciphertext);

    // HMAC-SHA256 over [version .. end-of-ciphertext], appended at the end.
    let mut mac = HmacSha256::new_from_slice(&hmac_key).expect("hmac key length");
    mac.update(&out);
    let tag = mac.finalize().into_bytes();
    out.extend_from_slice(&tag);
    out
}

fn rncryptor_decrypt(data: &[u8], password: &[u8]) -> Result<Vec<u8>, SecureError> {
    const HEADER: usize = 1 + 1 + 8 + 8 + 16;
    const HMAC_LEN: usize = 32;
    if data.len() < HEADER + HMAC_LEN || data[0] != 0x03 {
        return Err(SecureError::BadFormat);
    }

    let enc_salt = &data[2..10];
    let hmac_salt = &data[10..18];
    let iv = &data[18..34];
    let (signed, file_hmac) = data.split_at(data.len() - HMAC_LEN);
    let ciphertext = &signed[HEADER..];

    let enc_key = pbkdf2_sha1(password, enc_salt);
    let hmac_key = pbkdf2_sha1(password, hmac_salt);

    let mut mac = HmacSha256::new_from_slice(&hmac_key).expect("hmac key length");
    mac.update(signed);
    if mac.verify_slice(file_hmac).is_err() {
        return Err(SecureError::BadPassword);
    }

    let cipher = Aes256CbcDec::new_from_slices(&enc_key, iv).map_err(|_| SecureError::BadFormat)?;
    let mut buf = ciphertext.to_vec();
    let pt = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| SecureError::BadPassword)?;
    Ok(pt.to_vec())
}

fn pbkdf2_sha1(password: &[u8], salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2::<Hmac<Sha1>>(password, salt, 10_000, &mut key);
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let blob = rncryptor_encrypt(b"{\"hello\":\"world\"}", b"hunter2");
        assert_eq!(blob[0], 0x03);
        assert_eq!(blob[1], 0x01);
        let pt = rncryptor_decrypt(&blob, b"hunter2").unwrap();
        assert_eq!(pt, b"{\"hello\":\"world\"}");
    }

    #[test]
    fn wrong_password_rejected() {
        let blob = rncryptor_encrypt(b"secret data", b"correct");
        assert!(matches!(rncryptor_decrypt(&blob, b"wrong"), Err(SecureError::BadPassword)));
    }

    #[test]
    fn plaintext_json_is_not_flagged_encrypted() {
        // A normal JSON file must not be mistaken for an RNCryptor blob.
        let json = b"{\n  \"version\": 1\n}";
        assert_ne!(json[0], 0x03);
    }
}
