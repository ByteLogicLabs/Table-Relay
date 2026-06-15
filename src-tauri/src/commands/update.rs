//! Update check. Reads the published version from the project's GitHub `main`
//! branch `package.json` and returns it so the frontend can compare against the
//! running app version and surface an "update available" notice.
//!
//! The running version is injected from package.json at build time (see
//! vite.config `APP_VERSION`), so both sides of the comparison come from
//! package.json — the single file the team bumps per release.
//!
//! Done in Rust (not a webview `fetch`) so it isn't subject to CORS, and so the
//! request carries a normal User-Agent that GitHub's raw host is happy with.

use serde::Serialize;
use std::time::Duration;

/// Raw `main` `package.json` — the version source the team maintains.
const VERSION_URL: &str =
    "https://raw.githubusercontent.com/ByteLogicLabs/Table-Relay/main/package.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    /// The `version` field from the remote tauri.conf.json (e.g. "0.2.4").
    pub version: String,
}

/// Fetch the latest published version string. Returns `None` on any failure
/// (offline, rate-limited, malformed) — an update check must never disrupt the
/// app, so the caller simply skips the notice when this is null.
#[tauri::command]
pub async fn check_latest_version() -> Option<LatestVersion> {
    let client = reqwest::Client::builder()
        .user_agent("Table-Relay-update-check")
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;

    let res = client.get(VERSION_URL).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let json: serde_json::Value = res.json().await.ok()?;
    let version = json.get("version")?.as_str()?.trim().to_string();
    if version.is_empty() {
        return None;
    }
    Some(LatestVersion { version })
}
