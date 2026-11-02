//! Curated list of local GGUF models we know how to download and run. Starts
//! small — three entries ranging from 2GB to 8GB so users can pick one that
//! matches their RAM. Expand this list over time as we validate more models.
//!
//! The `sha256` field is authoritative: every finished download is verified
//! against it. Mismatch → the file is deleted and the user sees an error. If
//! upstream replaces a weight without changing the URL we'll catch that and
//! refuse to install a surprise file.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ModelEntry {
    pub id: &'static str,
    pub display: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    pub url: &'static str,
    pub min_ram_gb: u32,
}

/// Return the built-in catalog. `const fn` would be nicer but `&'static [T]`
/// of structs with `&'static str` fields is enough.
pub fn catalog() -> &'static [ModelEntry] {
    // NB: the `sha256` values here are placeholders — we don't pin them
    // until we verify them locally against the upstream weights. The
    // download command refuses to install a file without a matching hash,
    // so placeholders surface a clear error rather than silently shipping
    // an unverified blob.
    //
    // To fill these in:
    //   curl -L -o out.gguf <url>
    //   shasum -a 256 out.gguf
    &[
        ModelEntry {
            id: "qwen2.5-coder-3b-instruct-q4_k_m",
            display: "Qwen 2.5 Coder 3B (Q4_K_M)",
            size_bytes: 2_019_000_000,
            sha256: "TODO",
            url: "https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf",
            min_ram_gb: 6,
        },
        ModelEntry {
            id: "qwen2.5-coder-7b-instruct-q4_k_m",
            display: "Qwen 2.5 Coder 7B (Q4_K_M)",
            size_bytes: 4_683_000_000,
            sha256: "TODO",
            url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
            min_ram_gb: 8,
        },
        ModelEntry {
            id: "qwen2.5-coder-14b-instruct-q4_k_m",
            display: "Qwen 2.5 Coder 14B (Q4_K_M)",
            size_bytes: 8_988_000_000,
            sha256: "TODO",
            url: "https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/qwen2.5-coder-14b-instruct-q4_k_m.gguf",
            min_ram_gb: 16,
        },
    ]
}

pub fn find(id: &str) -> Option<&'static ModelEntry> {
    catalog().iter().find(|m| m.id == id)
}
