mod ai;
mod commands;
mod db;
pub mod log;
mod ssh;
mod store;

use std::sync::Arc;

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

use crate::ai::download::DownloadRegistry;
use crate::ai::session::SessionSlot;
use crate::ai::tools::{ApprovalRegistry, AutoApprovals};
use crate::db::adapter_registry::FactoryRegistry;
use crate::db::registry::Registry;
use crate::db::subscriptions::SubscriptionRegistry;
use crate::store::Store;

/// Whether this process was launched as the MCP-server subcommand by one of the
/// wrapped CLIs. Checked in `main` before Tauri starts.
pub fn is_mcp_subcommand(args: &[String]) -> bool {
    crate::ai::mcp_stdio::is_mcp_subcommand(args)
}

/// Run the stdio↔TCP MCP relay to completion (no GUI). See
/// [`crate::ai::mcp_stdio`].
pub fn run_mcp_server(args: &[String]) -> std::process::ExitCode {
    crate::ai::mcp_stdio::run(args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Forward adapter-api log lines into the host log pipeline so adapter
    // diagnostics show up in `logs/app.log` alongside host logs.
    adapter_api::log::set_writer(crate::log::write_line);
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir unavailable");
            // The bundle identifier (and thus the app-data directory) has
            // changed twice: com.dbtable.app → com.tablerelay.app →
            // me.bytelogic.tablerelay. Carry the most recent prior store +
            // vault + oauth files forward so existing users keep their saved
            // connections, known SSH hosts, AI settings and chat history.
            migrate_legacy_app_data(&dir);
            let store = Arc::new(
                Store::open(dir.clone()).unwrap_or_else(|e| {
                    // Last-resort recovery: if the store can't open even after
                    // internal fallback (e.g. filesystem permission issue), wipe
                    // it and start clean rather than crashing the app.
                    crate::log::write_line("store", &format!("open failed ({e}), resetting store"));
                    let _ = std::fs::remove_file(dir.join("store.db.enc"));
                    Store::open(dir.clone()).expect("store open failed even after reset")
                }),
            );

            // Factory registry + built-in adapters. Must run before any
            // `db_connect` command can dispatch by adapter id.
            let factories = Arc::new(FactoryRegistry::new());
            crate::db::builtin::register_builtins(&factories, &store);

            app.manage(store.clone());
            app.manage(factories);
            app.manage(Arc::new(Registry::new()));
            app.manage(Arc::new(SubscriptionRegistry::new()));
            // AI session slot — None until the user clicks Start Chat.
            let ai_slot: SessionSlot = Arc::new(RwLock::new(None));
            app.manage(ai_slot);
            app.manage(Arc::new(DownloadRegistry::default()));
            app.manage(Arc::new(ApprovalRegistry::default()));
            app.manage(Arc::new(AutoApprovals::default()));
            // MCP bridge slot — None until the first CLI session lazily binds the
            // loopback server that exposes DB tools to the wrapped coding CLIs.
            let mcp_slot: crate::ai::mcp_bridge::McpBridgeSlot =
                Arc::new(RwLock::new(None));
            app.manage(mcp_slot);

            // Native menu bar. The File submenu adds Import SQL + Export
            // entries that emit webview events the frontend listens to.
            // Everything else (Edit/View/Window/Help) comes from Tauri's
            // predefined items so the usual Copy/Paste/Minimize/etc. work
            // out of the box — this used to all be provided by the default
            // menu when we didn't build our own.
            let handle = app.handle();
            // Menu ids use plain underscore tokens. Tauri's MenuId type
            // accepts arbitrary strings but `.` / `:` have caused silent
            // routing failures in practice — we keep the separator
            // between "namespace" and "action" as an underscore and
            // parse it back in `on_menu_event`.
            let import_sql = MenuItemBuilder::with_id("file_import", "Import…")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(handle)?;
            let export_data = MenuItemBuilder::with_id("file_export", "Export…")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(handle)?;
            let mut file_builder = SubmenuBuilder::new(handle, "File")
                .item(&import_sql)
                .item(&export_data)
                .separator();
            // On macOS, Settings / About / Quit live in the app menu (the
            // first, app-named submenu). Windows & Linux have no app menu, so
            // those entries would be unreachable — surface them in the File
            // menu there instead. Settings reuses the `app_settings` id so it
            // routes through the same `menu-app-settings` → open-settings flow.
            #[cfg(not(target_os = "macos"))]
            {
                let open_settings = MenuItemBuilder::with_id("app_settings", "Settings…")
                    .accelerator("CmdOrCtrl+,")
                    .build(handle)?;
                file_builder = file_builder
                    .item(&open_settings)
                    .item(&PredefinedMenuItem::about(handle, None, None)?)
                    .separator();
            }
            file_builder = file_builder.item(&PredefinedMenuItem::close_window(handle, None)?);
            #[cfg(not(target_os = "macos"))]
            {
                file_builder = file_builder.item(&PredefinedMenuItem::quit(handle, None)?);
            }
            let file_menu = file_builder.build()?;

            // Predefined submenus give us Copy/Paste, fullscreen, etc.
            // without having to rebuild each item by hand.
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&PredefinedMenuItem::fullscreen(handle, None)?)
                .build()?;
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .maximize()
                .separator()
                .item(&PredefinedMenuItem::close_window(handle, None)?)
                .build()?;

            let connection_picker = MenuItemBuilder::with_id("connection_picker", "List Connections…")
                .accelerator("CmdOrCtrl+Shift+C")
                .build(handle)?;
            let connection_new = MenuItemBuilder::with_id("connection_new", "New Connection")
                .accelerator("CmdOrCtrl+N")
                .build(handle)?;
            let connection_edit_current =
                MenuItemBuilder::with_id("connection_edit_current", "Edit Current Connection…")
                    .build(handle)?;
            let connection_open_database =
                MenuItemBuilder::with_id("connection_open_database", "Open Database…")
                    .build(handle)?;
            let connection_import_db =
                MenuItemBuilder::with_id("connection_import_db", "Import Data…")
                    .build(handle)?;
            let connection_export_db =
                MenuItemBuilder::with_id("connection_export_db", "Export Data…")
                    .build(handle)?;
            let connection_transfer =
                MenuItemBuilder::with_id("connection_transfer", "Import / Export Connections…")
                    .build(handle)?;
            let connection_menu = SubmenuBuilder::new(handle, "Connection")
                .item(&connection_picker)
                .item(&connection_new)
                .separator()
                .item(&connection_edit_current)
                .item(&connection_open_database)
                .separator()
                .item(&connection_import_db)
                .item(&connection_export_db)
                .separator()
                .item(&connection_transfer)
                .build()?;

            let mut menu_builder = MenuBuilder::new(handle);
            // macOS-only "app menu" (first menu, named after the bundle)
            // carries About / Quit. Without it the app has no Quit entry.
            #[cfg(target_os = "macos")]
            {
                let open_settings = MenuItemBuilder::with_id("app_settings", "Settings…")
                    .accelerator("CmdOrCtrl+,")
                    .build(handle)?;
                let app_menu = SubmenuBuilder::new(handle, "Table Relay")
                    .item(&PredefinedMenuItem::about(handle, None, None)?)
                    .separator()
                    .item(&open_settings)
                    .separator()
                    .item(&PredefinedMenuItem::services(handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(handle, None)?)
                    .item(&PredefinedMenuItem::hide_others(handle, None)?)
                    .item(&PredefinedMenuItem::show_all(handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(handle, None)?)
                    .build()?;
                menu_builder = menu_builder.item(&app_menu);
            }
            let menu = menu_builder
                .item(&file_menu)
                .item(&edit_menu)
                .item(&connection_menu)
                .item(&view_menu)
                .item(&window_menu)
                .build()?;
            app.set_menu(menu)?;

            // Route menu item clicks to the webview via Tauri events.
            // Frontend listens for `menu-file-import` / `menu-file-export`.
            // We log every menu event so a silent miss (e.g. a typo in
            // the item id) is visible in logs/app.log instead of looking
            // like "the button does nothing".
            app.on_menu_event(move |app_handle, event| {
                let id = event.id().as_ref().to_string();
                crate::log::write_line("menu", &format!("click: id={id}"));
                let channel = if let Some(action) = id.strip_prefix("file_") {
                    Some(format!("menu-file-{action}"))
                } else if let Some(action) = id.strip_prefix("app_") {
                    Some(format!("menu-app-{action}"))
                } else if let Some(action) = id.strip_prefix("connection_") {
                    Some(format!("menu-connection-{action}"))
                } else {
                    None
                };
                if let Some(ch) = channel {
                    match app_handle.emit(&ch, ()) {
                        Ok(()) => crate::log::write_line("menu", &format!("emitted: {ch}")),
                        Err(e) => {
                            crate::log::write_line("menu", &format!("emit failed: {ch}: {e}"))
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Frontend → log bridge (writes fe:<tag> lines into logs/app.log)
            crate::log::frontend_log,
            // Security / encrypted app store
            commands::security::security_status,
            commands::security::security_remove_backup,
            // Connection store (plain, no encryption)
            commands::store::connections_list,
            commands::store::connections_save,
            commands::store::connections_delete,
            commands::store::app_state_get,
            commands::store::app_state_set,
            commands::store::app_state_delete,
            commands::store::ai_settings_list,
            commands::store::ai_settings_get,
            commands::store::ai_settings_save,
            commands::store::ai_settings_forget,
            // TablePlus import (decrypt + map a .tableplusconnection export)
            commands::tableplus::tableplus_import,
            // Foreign-client import password decryption (Navicat / DBeaver)
            commands::foreign_import::navicat_decrypt_passwords,
            commands::foreign_import::dbeaver_decrypt_credentials,
            // Encrypted backup export/import (settings, connections, etc.)
            commands::secure_transfer::secure_export,
            commands::secure_transfer::secure_import,
            commands::secure_transfer::secure_is_encrypted,
            // DB
            commands::db::db_connect,
            commands::db::db_test_connection,
            commands::db::db_disconnect,
            commands::db::db_ping,
            commands::db::db_list_active,
            commands::db::db_list_schemas,
            commands::db::db_list_databases,
            commands::db::db_switch_database,
            commands::db::db_describe_table,
            commands::db::db_describe_schema,
            commands::db::db_list_relations,
            commands::db::db_run_query,
            commands::db::db_run_query_stream,
            commands::db::db_insert_rows,
            commands::db::db_update_rows,
            commands::db::db_modify_indexes,
            commands::db::db_delete_rows,
            commands::db::db_list_views,
            commands::db::db_list_routines,
            commands::db::db_describe_routine,
            commands::db::db_list_triggers,
            commands::db::db_describe_trigger,
            commands::db::db_save_trigger,
            commands::db::db_drop_trigger,
            commands::db::db_create_database,
            commands::db::db_list_charsets,
            commands::db::db_list_collations,
            // Multi-adapter surface (P4)
            commands::db::db_list_adapters,
            commands::db::db_browse,
            // Realtime (pub/sub, LISTEN/NOTIFY, change streams)
            commands::db::db_subscribe,
            commands::db::db_unsubscribe,
            // Process list + kill
            commands::db::db_process_list,
            commands::db::db_kill_process,
            commands::db::db_kill_processes,
            commands::db::db_analyze_command,
            // Rail tiles (pinned server + database pairs).
            commands::rail::rail_list,
            commands::rail::rail_pin,
            commands::rail::rail_unpin,
            commands::rail::rail_rename,
            commands::rail::rail_reorder,
            // AI (session-scoped; see ai-plan.md).
            commands::ai::ai_status,
            commands::ai::ai_start,
            commands::ai::ai_end,
            commands::ai::ai_new_chat,
            commands::ai::ai_list_models,
            commands::ai::ai_cli_available,
            commands::ai::ai_list_local_models,
            commands::ai::ai_download_model,
            commands::ai::ai_download_model_url,
            commands::ai::ai_cancel_download,
            commands::ai::ai_delete_model,
            commands::ai::ai_check_llama_server,
            commands::ai::ai_chat_send,
            commands::ai::ai_chat_stop,
            commands::ai::ai_restore_messages,
            commands::ai::ai_approve_tool_call,
            commands::ai::ai_get_auto_approvals,
            commands::ai::ai_set_auto_approvals,
            // Conversation persistence
            commands::ai::ai_conversation_list,
            commands::ai::ai_conversation_get,
            commands::ai::ai_conversation_create,
            commands::ai::ai_conversation_delete,
            commands::ai::ai_conversation_update_title,
            commands::ai::ai_conversation_save_message,
            commands::ai::ai_conversation_clear_messages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// One-time carry-forward of the local store after a bundle-identifier change
/// (and thus a different app-data directory). The id has changed twice:
/// `com.dbtable.app` → `com.tablerelay.app` → `me.bytelogic.tablerelay`.
///
/// `new_dir` is the current app-data dir (`…/me.bytelogic.tablerelay`). We only
/// act when the new dir has no store yet (a fresh post-rename install) and a
/// sibling dir from a previous identifier does — then we copy the store, vault
/// and oauth files across, preferring the most recent prior identifier. Never
/// overwrites a populated new store, so it's a no-op on every later launch.
fn migrate_legacy_app_data(new_dir: &std::path::Path) {
    // A "has data" dir is one that holds either the encrypted store
    // (`store.db.enc`, current format) or the legacy plaintext `store.db`.
    let has_store = |dir: &std::path::Path| {
        dir.join("store.db.enc").exists() || dir.join("store.db").exists()
    };

    if has_store(new_dir) {
        return; // already migrated (or a normal returning user) — nothing to do
    }

    let parent = match new_dir.parent() {
        Some(p) => p,
        None => return,
    };

    // Most recent prior identifier first, so a user upgrading from the
    // immediately previous build wins over a much older one.
    let old_dir = match ["com.tablerelay.app", "com.dbtable.app"]
        .into_iter()
        .map(|id| parent.join(id))
        .find(|d| has_store(d))
    {
        Some(d) => d,
        None => return, // nothing to migrate from
    };

    if let Err(e) = std::fs::create_dir_all(new_dir) {
        crate::log::write_line("migrate", &format!("create new app-data dir failed: {e}"));
        return;
    }

    let from = old_dir.file_name().and_then(|n| n.to_str()).unwrap_or("?");
    for name in [
        "store.db.enc",         // encrypted store (current)
        "store.db",             // legacy plaintext store
        "store.db.plain.backup", // plaintext migration backup, if any
        "vault.db",
        "gemini_oauth.json",
    ] {
        let src = old_dir.join(name);
        if !src.exists() {
            continue;
        }
        let dst = new_dir.join(name);
        match std::fs::copy(&src, &dst) {
            Ok(_) => crate::log::write_line(
                "migrate",
                &format!("carried forward {name} from {from}"),
            ),
            Err(e) => crate::log::write_line("migrate", &format!("copy {name} failed: {e}")),
        }
    }
}
