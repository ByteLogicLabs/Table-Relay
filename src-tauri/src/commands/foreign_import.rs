//! Password decryption for connection imports from other DB clients.
//!
//! The geometry (name/host/port/user/database) is parsed in the frontend from
//! each tool's export. The SECRETS, however, are encrypted with tool-specific
//! ciphers, so we decrypt them here where we already have AES/Blowfish:
//!
//!   • Navicat `.ncx` — password is an uppercase-hex string, either:
//!       V2 (Navicat 12+): AES-128-CBC, key `libcckeylibcckey`, iv `libcciv libcciv `
//!       V1 (Navicat ≤11): Blowfish-ECB with a custom CFB-like chaining, key
//!                         = SHA1("3DC5CA39"), iv = encrypt_ecb(0xFF*8)
//!     We try V2 first, then V1, and accept whichever yields valid UTF-8.
//!
//!   • DBeaver `credentials-config.json` — the whole file is AES-128-CBC with a
//!     hardcoded 16-byte key; the first 16 bytes of the plaintext are a junk/IV
//!     block to discard. Recoverable only when the user has NOT set a master
//!     password (then the key is derived from it / stored in the OS keychain).

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::cipher::generic_array::GenericArray;
use blowfish::Blowfish;
use sha1::{Digest, Sha1};
use std::collections::HashMap;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

// ── Navicat ──────────────────────────────────────────────────────────────────

/// Decrypt a batch of Navicat password hex strings, preserving order. Each entry
/// is `Some(plaintext)` on success or `None` if empty/undecryptable.
#[tauri::command]
pub fn navicat_decrypt_passwords(ciphers: Vec<String>) -> Vec<Option<String>> {
    ciphers.iter().map(|c| navicat_decrypt_one(c)).collect()
}

fn navicat_decrypt_one(hexstr: &str) -> Option<String> {
    let hexstr = hexstr.trim();
    if hexstr.is_empty() {
        return None;
    }
    let bytes = hex::decode(hexstr).ok()?;
    // V2 (AES) requires a 16-byte-multiple; try it first when that holds.
    if bytes.len() % 16 == 0 {
        if let Some(p) = navicat_decrypt_aes(&bytes) {
            return Some(p);
        }
    }
    navicat_decrypt_blowfish(&bytes)
}

fn navicat_decrypt_aes(ct: &[u8]) -> Option<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let key = b"libcckeylibcckey";
    let iv = b"libcciv libcciv ";
    let mut buf = ct.to_vec();
    let cipher = Aes128CbcDec::new_from_slices(key, iv).ok()?;
    let pt = cipher.decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?;
    let s = std::str::from_utf8(pt).ok()?;
    if s.is_empty() { None } else { Some(s.to_string()) }
}

fn navicat_decrypt_blowfish(ct: &[u8]) -> Option<String> {
    // Key = SHA1("3DC5CA39") (20 bytes, used directly as the Blowfish key).
    let key = Sha1::digest(b"3DC5CA39");
    // The default `Blowfish` is big-endian, which is what Navicat uses.
    let bf: Blowfish = Blowfish::new_from_slice(&key).ok()?;

    // IV = encrypt_ecb(0xFF * 8)
    let mut iv = [0xFFu8; 8];
    {
        let mut blk = GenericArray::clone_from_slice(&iv);
        bf.encrypt_block(&mut blk);
        iv.copy_from_slice(&blk);
    }

    let mut cv = iv;
    let mut out: Vec<u8> = Vec::with_capacity(ct.len());
    let rounds = ct.len() / 8;
    let leftover = ct.len() % 8;

    for i in 0..rounds {
        let block = &ct[i * 8..i * 8 + 8];
        // t = decrypt_ecb(block)
        let mut blk = GenericArray::clone_from_slice(block);
        bf.decrypt_block(&mut blk);
        // out += t XOR cv
        for j in 0..8 {
            out.push(blk[j] ^ cv[j]);
        }
        // cv = cv XOR ciphertext_block
        for j in 0..8 {
            cv[j] ^= block[j];
        }
    }

    if leftover > 0 {
        // cv = encrypt_ecb(cv); out += tail XOR cv[..leftover]
        let mut blk = GenericArray::clone_from_slice(&cv);
        bf.encrypt_block(&mut blk);
        let tail = &ct[rounds * 8..];
        for j in 0..leftover {
            out.push(tail[j] ^ blk[j]);
        }
    }

    let s = String::from_utf8(out).ok()?;
    if s.is_empty() { None } else { Some(s) }
}

// ── DBeaver ──────────────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize)]
pub struct DbeaverCred {
    pub user: Option<String>,
    pub password: Option<String>,
}

/// Decrypt a DBeaver `credentials-config.json` and return per-connection
/// credentials keyed by connection id. Returns an empty map (not an error) when
/// the file can't be decrypted with the hardcoded key — that means the user set
/// a master password, so the secrets simply aren't file-recoverable.
#[tauri::command]
pub fn dbeaver_decrypt_credentials(path: String) -> Result<HashMap<String, DbeaverCred>, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let plain = match dbeaver_decrypt(&data) {
        Some(p) => p,
        None => return Ok(HashMap::new()),
    };
    let json: serde_json::Value = match serde_json::from_slice(&plain) {
        Ok(v) => v,
        Err(_) => return Ok(HashMap::new()),
    };
    let obj = match json.as_object() {
        Some(o) => o,
        None => return Ok(HashMap::new()),
    };
    let mut out = HashMap::new();
    for (conn_id, node) in obj {
        // Credentials live under the "#connection" sub-node.
        let conn = node.get("#connection").and_then(|c| c.as_object());
        if let Some(conn) = conn {
            out.insert(
                conn_id.clone(),
                DbeaverCred {
                    user: conn.get("user").and_then(|v| v.as_str()).map(String::from),
                    password: conn.get("password").and_then(|v| v.as_str()).map(String::from),
                },
            );
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navicat_v2_aes_known_vectors() {
        assert_eq!(navicat_decrypt_one("E7D6D10725AD2445AA63C211943D447D").as_deref(), Some("test"));
        assert_eq!(navicat_decrypt_one("B2E75894499ED0305DFDA0869FE575F4").as_deref(), Some("PassW0rd"));
    }

    #[test]
    fn navicat_v1_blowfish_known_vectors() {
        // These aren't 16-byte multiples, so they route to the Blowfish path.
        assert_eq!(navicat_decrypt_one("50523D3B").as_deref(), Some("test"));
        assert_eq!(navicat_decrypt_one("3FA5111C08B57BFA").as_deref(), Some("PassW0rd"));
    }

    #[test]
    fn navicat_empty_is_none() {
        assert_eq!(navicat_decrypt_one(""), None);
        assert_eq!(navicat_decrypt_one("   "), None);
    }
}

fn dbeaver_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    // Hardcoded 16-byte key (raw bytes, ships in the open-source binary).
    const KEY: [u8; 16] = [
        0xba, 0xbb, 0x4a, 0x9f, 0x77, 0x4a, 0xb8, 0x53, 0xc9, 0x6c, 0x2d, 0x65, 0x3d, 0xfe, 0x54,
        0x4a,
    ];
    const IV: [u8; 16] = [0u8; 16];
    if data.len() < 16 || data.len() % 16 != 0 {
        return None;
    }
    let mut buf = data.to_vec();
    let cipher = Aes128CbcDec::new_from_slices(&KEY, &IV).ok()?;
    let pt = cipher.decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?;
    // The first 16-byte block of the plaintext is an IV/garbage block — discard.
    if pt.len() < 16 {
        return None;
    }
    Some(pt[16..].to_vec())
}
