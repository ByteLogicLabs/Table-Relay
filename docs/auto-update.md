# Auto-update (Tauri updater) - setup

In-app auto-update is wired on the **app side** (plugin, config, UI). Before it
works end to end you must generate signing keys and have CI publish the per-OS
update artifacts + a `latest.json`. Until then the notice falls back to opening
the GitHub releases page.

Works on **macOS, Windows, and Linux** from one mechanism.

## How it works

1. On launch (and every 30 min) the app calls the updater's `check()` against
   the endpoint in `tauri.conf.json` → a `latest.json` attached to the GitHub
   "latest" release.
2. If a newer, correctly-signed version exists, the bottom-right notice shows
   **Update now**. Clicking it downloads the platform bundle, verifies the
   signature, installs, and relaunches - no manual reinstall.
3. If the updater isn't configured/available, the notice shows **Download** and
   opens the releases page instead (the old behaviour).

## One-time: signing keys (REQUIRED)

The updater refuses unsigned updates. Generate a keypair:

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/table-relay.key
# prints a PUBLIC key and writes the PRIVATE key (+ a .pub) to that path
```

- Put the **public** key in `src-tauri/tauri.conf.json` →
  `plugins.updater.pubkey` (currently the placeholder
  `REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY`).
- Add the **private** key + its password as GitHub Actions secrets:
  - `TAURI_SIGNING_PRIVATE_KEY` = contents of the private key file
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the password you set

> This signature is the updater's own, independent of OS code-signing.

## CI: publish update artifacts + latest.json (TODO)

`bundle.createUpdaterArtifacts` is already `true`, so a signed `tauri build`
emits the update artifact + `.sig` per platform:

- **Windows** - `.msi`/NSIS `-setup.exe` + `.sig` (tauri-action handles this).
- **Linux** - `.AppImage` + `.sig`. NOTE: the Linux matrix entry in
  `.github/workflows/release.yml` is currently commented out - re-enable it.
- **macOS** - needs `.app.tar.gz` + `.sig`. The repo builds the `.dmg` with a
  custom `scripts/make-dmg.sh`, which does NOT emit the updater artifact, so add
  a step that runs the Tauri bundler (or `tauri build` with the updater target)
  to produce `Table Relay.app.tar.gz` + `.sig` and uploads them.

`tauri-action` can generate and upload `latest.json` automatically when the
signing secrets are present, for the bundles it builds. Because macOS uses the
custom DMG path, make sure the macOS entry ends up in `latest.json` (either by
letting tauri-action bundle macOS too, or by merging the macOS url+signature
into the generated `latest.json` before upload).

`latest.json` shape (one per release, attached to the GitHub release):

```json
{
  "version": "0.2.8",
  "notes": "…",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64":  { "url": "https://…/Table_Relay_aarch64.app.tar.gz", "signature": "…" },
    "darwin-x86_64":   { "url": "https://…/Table_Relay_x86_64.app.tar.gz",  "signature": "…" },
    "windows-x86_64":  { "url": "https://…/Table_Relay_x64-setup.exe",       "signature": "…" },
    "linux-x86_64":    { "url": "https://…/Table_Relay_amd64.AppImage",      "signature": "…" }
  }
}
```

The endpoint already configured resolves to the newest release's copy:
`https://github.com/ByteLogicLabs/Table-Relay/releases/latest/download/latest.json`.

## macOS / Windows caveat (signing vs notarization)

The updater verifies its own signature, but the downloaded app still faces the
OS gatekeeper. Builds are ad-hoc signed, NOT notarized, so a macOS auto-update
may show a "can't verify" prompt once (SmartScreen is the Windows analog). The
updater still works; full silent macOS updates need an Apple Developer ID cert +
notarization - a later step.

## Verifying

After keys + CI are in place, cut a release with a higher `version` (bump both
`package.json` and `src-tauri/tauri.conf.json`), then run an older build: the
notice should offer **Update now** and complete without a manual download.
