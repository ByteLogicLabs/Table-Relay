//! Update check via the GitHub Releases API — the latest *published* release
//! (the API's `releases/latest` excludes drafts and pre-releases), so we never
//! announce a version that was bumped in `main`'s package.json but not yet
//! shipped. Returns the release tag and the release page URL.
//!
//! This is the fallback the frontend uses when the Tauri updater's signed
//! `latest.json` isn't available; the updater path (which can auto-install) is
//! tried first. The running version is injected from package.json at build time
//! (see vite.config `APP_VERSION`) and compared against `version` on the JS side.
//!
//! Done in Rust (not a webview `fetch`) so it isn't subject to CORS, and so the
//! request carries a User-Agent, which the GitHub API requires.

use serde::Serialize;
use std::time::Duration;

/// Latest published release for the repo. `releases/latest` is the newest
/// non-draft, non-prerelease release — exactly what we want to offer users.
const RELEASES_URL: &str =
    "https://api.github.com/repos/ByteLogicLabs/Table-Relay/releases/latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    /// Version from the release `tag_name` (e.g. "0.2.4" or "v0.2.4"; the
    /// frontend comparison strips a leading "v").
    pub version: String,
    /// The release page (`html_url`) so the notice can link straight to it
    /// instead of the generic `/releases/latest` redirect.
    pub url: Option<String>,
}

/// Fetch the latest published release. Returns `None` on any failure — offline,
/// rate-limited, malformed, or a 404 when the repo has no published release yet.
/// An update check must never disrupt the app, so the caller simply skips the
/// notice when this is null.
#[tauri::command]
pub async fn check_latest_version() -> Option<LatestVersion> {
    let client = reqwest::Client::builder()
        .user_agent("Table-Relay-update-check")
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;

    let res = client
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .ok()?;
    // 404 = no published release yet; anything non-2xx = skip the notice.
    if !res.status().is_success() {
        return None;
    }
    let json: serde_json::Value = res.json().await.ok()?;
    let version = json.get("tag_name")?.as_str()?.trim().to_string();
    if version.is_empty() {
        return None;
    }
    let url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(LatestVersion { version, url })
}
