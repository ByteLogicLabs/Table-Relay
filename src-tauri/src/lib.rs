mod ai;
mod commands;
mod db;
pub mod log;
mod ssh;
mod store;

use std::sync::Arc;

use tauri::menu::{
    IsMenuItem, Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::{Emitter, Manager, Wry};
use tokio::sync::RwLock;

/// Native-menu items that only make sense when at least one connection is open.
/// Stored in managed state so the frontend can grey them out (via the
/// `set_connection_menu_enabled` command) whenever the connection count changes.
/// Edit/Open/Import/Export all act on the *focused* connection, so with none
/// open they would only ever toast an error — better to disable them outright.
struct ConnectionMenuItems {
    items: Vec<MenuItem<Wry>>,
}

/// The whole "Connection" submenu plus where it lives in the menu bar. Shown
/// only once a connection is open; hidden on the home screen, where the home
/// view already surfaces every connection action (Connect / New / List / etc.).
/// Tauri 2 has no `set_visible`, so we insert/remove the submenu from the top
/// menu bar — same approach as [`QueryMenuItems`]. `index` is its fixed slot in
/// the bar (after Edit), captured at build time so re-insertion lands in place.
struct ConnectionMenu {
    menu: Menu<Wry>,
    submenu: Submenu<Wry>,
    index: usize,
    /// Tracks current state so repeated toggles don't double-insert / error.
    shown: std::sync::Mutex<bool>,
}

/// File-menu items that act on the query editor (Load / Save / Save Query As),
/// plus the separator that follows them. Shown only while a query tab is active.
/// Tauri 2 has no `set_visible`, so we genuinely insert/remove the items from
/// the File submenu instead — removing them also deactivates their ⌘S/⌘⇧S/⌘I
/// accelerators, freeing ⌘S for the data grid's "commit edits" on other tabs.
/// The frontend toggles this via `set_query_menu_visible`.
struct QueryMenuItems {
    file_menu: Submenu<Wry>,
    items: Vec<MenuItem<Wry>>,
    separator: PredefinedMenuItem<Wry>,
    /// Tracks current state so repeated toggles don't double-insert / error.
    shown: std::sync::Mutex<bool>,
}

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir unavailable");
            // Point file logging at <app-data>/logs so it works in release
            // builds (not just the dev source tree). Logging stays OFF until the
            // user opts in; `apply_persisted_logging` below restores their choice.
            crate::log::set_log_dir(&dir);
            // The bundle identifier (and thus the app-data directory) has
            // changed twice: com.dbtable.app → com.tablerelay.app →
            // me.bytelogic.tablerelay. Carry the most recent prior store +
            // vault + oauth files forward so existing users keep their saved
            // connections, known SSH hosts, AI settings and chat history.
            migrate_legacy_app_data(&dir);
            let store = Arc::new(match Store::open(dir.clone()) {
                Ok(s) => s,
                // The store is UNREADABLE but INTACT — either a wrong/missing
                // encryption token, or a schema newer than this build knows
                // (DB-ahead-of-code, e.g. a dev build opened after a newer
                // release wrote the store). Deleting it here would silently wipe
                // the user's connections — this exact path destroyed data
                // before. Never reset in this case; crash with a clear message
                // so the data is preserved and the build/branch can be fixed.
                Err(e) if e.is_unreadable_not_corrupt() => {
                    crate::log::write_line(
                        "store",
                        &format!("open failed ({e}); store is intact but unreadable by this build \
                                  — refusing to reset"),
                    );
                    panic!(
                        "Stored data could not be opened by this build, but it is intact. \
                         Refusing to reset so your connections are not lost. Cause: {e}. \
                         This usually means a different/missing encryption token, or running \
                         an older build against a store written by a newer one."
                    );
                }
                // Genuine I/O / corruption (not a token mismatch): self-heal by
                // resetting, since the file truly can't be opened either way.
                Err(e) => {
                    crate::log::write_line("store", &format!("open failed ({e}), resetting store"));
                    let _ = std::fs::remove_file(dir.join("store.db.enc"));
                    Store::open(dir.clone()).expect("store open failed even after reset")
                }
            });

            // Restore the user's file-logging preference (default OFF in
            // release). Must come after the store opens.
            crate::commands::logs::apply_persisted_logging(&store);

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
            let import_sql = MenuItemBuilder::with_id("file_import", "Import Data…")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(handle)?;
            let export_data = MenuItemBuilder::with_id("file_export", "Export Data…")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(handle)?;
            // Query-buffer file actions. These carry real accelerators so they
            // render natively (right-aligned shortcut column). ⌘S is shared with
            // the data grid's commit: the webview routes `menu-file-save_query`
            // context-aware — a query tab saves to file, a data-grid tab commits
            // pending edits. ⌘I is bound here (load query) and is distinct from
            // ⌘⇧I (Import Data, below).
            let load_query = MenuItemBuilder::with_id("file_load_query", "Load Query…")
                .accelerator("CmdOrCtrl+I")
                .build(handle)?;
            let save_query = MenuItemBuilder::with_id("file_save_query", "Save Query")
                .accelerator("CmdOrCtrl+S")
                .build(handle)?;
            let save_query_as = MenuItemBuilder::with_id("file_save_query_as", "Save Query As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(handle)?;
            // "Close Tab" menu entry. We deliberately DON'T bind it to
            // `CmdOrCtrl+W` here: the webview already owns ⌘W via a guarded
            // keydown handler (tabs-shell.tsx) that closes the active tab but
            // skips the action while the user is typing in Monaco / an input.
            // The old `close_window` predefined item used to steal ⌘W and quit
            // the whole single-window app — removing it (below) frees the key
            // for the webview. Clicking this menu item still works via the
            // emitted `menu-file-close_tab` event as a no-accelerator fallback.
            let close_tab = MenuItemBuilder::with_id("file_close_tab", "Close Tab")
                .build(handle)?;
            // The query items + their separator are NOT added here — they start
            // hidden and are inserted at the top of this submenu only while a
            // query tab is active (see `set_query_menu_visible`).
            let query_menu_separator = PredefinedMenuItem::separator(handle)?;
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
            file_builder = file_builder.item(&close_tab);
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
            // No `close_window` item here — its default ⌘W accelerator would
            // shadow the Close Tab binding and quit the single-window app.
            // The window is still closable via the title-bar control and ⌘Q.
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .maximize()
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

            // AI menu — opens the AI chat panel (frontend listens for
            // `menu-ai-chat`). Hidden for now; re-add `.item(&ai_menu)` to the
            // builder below to restore it.
            // let ai_chat = MenuItemBuilder::with_id("ai_chat", "AI Chat")
            //     .accelerator("CmdOrCtrl+Shift+A")
            //     .build(handle)?;
            // let ai_menu = SubmenuBuilder::new(handle, "AI").item(&ai_chat).build()?;

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
                // Connection submenu is omitted here on purpose — the app opens
                // on the home screen, which already exposes every connection
                // action, so we start without it and let the frontend insert it
                // (via `set_connection_menu_visible`) once a connection opens.
                // .item(&ai_menu) // hidden for now
                .item(&view_menu)
                .item(&window_menu)
                .build()?;
            app.set_menu(menu.clone())?;

            // Its slot is right after Edit: app(macOS)/File/Edit precede it.
            // The macOS app menu adds one leading entry, so the index shifts.
            let connection_index = if cfg!(target_os = "macos") { 3 } else { 2 };
            app.manage(ConnectionMenu {
                menu,
                submenu: connection_menu,
                index: connection_index,
                shown: std::sync::Mutex::new(false),
            });

            // Items that act on the focused connection start disabled — there's
            // no connection open at launch. The frontend re-enables them once a
            // connection exists, via `set_connection_menu_enabled`.
            let connection_menu_items = ConnectionMenuItems {
                items: vec![
                    connection_edit_current.clone(),
                    connection_open_database.clone(),
                    connection_import_db.clone(),
                    connection_export_db.clone(),
                ],
            };
            for item in &connection_menu_items.items {
                let _ = item.set_enabled(false);
            }
            app.manage(connection_menu_items);

            // Query file actions start hidden — no query tab is open at launch.
            // They were intentionally left out of the File submenu above; the
            // frontend inserts them (via `set_query_menu_visible`) only while a
            // query tab is active, which also gates their ⌘S/⌘⇧S/⌘I accelerators.
            app.manage(QueryMenuItems {
                file_menu: file_menu.clone(),
                items: vec![load_query, save_query, save_query_as],
                separator: query_menu_separator,
                shown: std::sync::Mutex::new(false),
            });

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
                } else if let Some(action) = id.strip_prefix("ai_") {
                    Some(format!("menu-ai-{action}"))
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
            // Update check: latest published version from GitHub package.json.
            commands::update::check_latest_version,
            // Logs panel: toggle, read, clear, reveal.
            commands::logs::logging_get_enabled,
            commands::logs::logging_set_enabled,
            commands::logs::logging_read,
            commands::logs::logging_clear,
            commands::logs::logging_open_dir,
            // Native-menu state: grey out connection-dependent items at home.
            set_connection_menu_enabled,
            // Native-menu state: hide the Connection submenu on the home screen.
            set_connection_menu_visible,
            // Native-menu state: show query file actions only on query tabs.
            set_query_menu_visible,
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
            commands::db::db_cancel_query,
            commands::db::db_insert_rows,
            commands::db::db_update_rows,
            commands::db::db_modify_indexes,
            commands::db::db_delete_rows,
            commands::db::db_list_views,
            commands::db::db_view_definition,
            commands::db::db_list_routines,
            commands::db::db_describe_routine,
            commands::db::db_list_triggers,
            commands::db::db_describe_trigger,
            commands::db::db_save_trigger,
            commands::db::db_drop_trigger,
            commands::db::db_create_database,
            commands::db::db_list_charsets,
            commands::db::db_list_collations,
            commands::db::db_list_all_collations,
            // Multi-adapter surface (P4)
            commands::db::db_list_adapters,
            commands::db::db_browse,
            commands::db::db_get_record,
            commands::db::db_server_details,
            // Realtime (pub/sub, LISTEN/NOTIFY, change streams)
            commands::db::db_subscribe,
            commands::db::db_unsubscribe,
            // Process list + kill
            commands::db::db_process_list,
            commands::db::db_kill_process,
            commands::db::db_kill_processes,
            commands::db::db_analyze_command,
            // User / role management.
            commands::db::db_can_manage_users,
            commands::db::db_list_users,
            commands::db::db_list_grants,
            commands::db::db_create_user,
            commands::db::db_alter_user,
            commands::db::db_drop_user,
            commands::db::db_grant_privileges,
            commands::db::db_revoke_privileges,
            commands::db::db_flush_privileges,
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
            commands::ai::ai_conversation_delete_all,
            commands::ai::ai_conversation_update_title,
            commands::ai::ai_conversation_set_model,
            commands::ai::ai_conversation_save_message,
            commands::ai::ai_conversation_clear_messages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Enable or disable the connection-dependent native menu items (Edit Current /
/// Open Database / Import Data / Export Data). The frontend calls this whenever
/// the saved-connection count changes: `true` once at least one connection
/// exists, `false` when there are none (so the items grey out on the home
/// screen instead of toasting "open a connection first").
#[tauri::command]
fn set_connection_menu_enabled(
    enabled: bool,
    items: tauri::State<'_, ConnectionMenuItems>,
) -> Result<(), String> {
    for item in &items.items {
        item.set_enabled(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Show or hide the query-editor File-menu items (Load Query / Save Query / Save
/// Query As) plus their trailing separator. The frontend calls this with `true`
/// when a query tab becomes active and `false` otherwise. We insert/remove the
/// items rather than disable them (Tauri 2 has no `set_visible`), so they truly
/// appear/disappear — and removing them deactivates their ⌘S/⌘⇧S/⌘I
/// accelerators, freeing ⌘S for the data grid's commit shortcut on other tabs.
#[tauri::command]
fn set_query_menu_visible(
    visible: bool,
    state: tauri::State<'_, QueryMenuItems>,
) -> Result<(), String> {
    let mut shown = state.shown.lock().map_err(|e| e.to_string())?;
    if *shown == visible {
        return Ok(()); // already in the requested state — nothing to do
    }
    if visible {
        // Insert at the top of the File submenu: items 0..n, then a separator.
        for (i, item) in state.items.iter().enumerate() {
            state
                .file_menu
                .insert(item as &dyn IsMenuItem<Wry>, i)
                .map_err(|e| e.to_string())?;
        }
        state
            .file_menu
            .insert(&state.separator as &dyn IsMenuItem<Wry>, state.items.len())
            .map_err(|e| e.to_string())?;
    } else {
        for item in &state.items {
            state
                .file_menu
                .remove(item as &dyn IsMenuItem<Wry>)
                .map_err(|e| e.to_string())?;
        }
        state
            .file_menu
            .remove(&state.separator as &dyn IsMenuItem<Wry>)
            .map_err(|e| e.to_string())?;
    }
    *shown = visible;
    Ok(())
}

/// Show or hide the whole "Connection" submenu in the native menu bar. The
/// frontend calls this with `false` on the home screen — where the home view
/// already provides Connect / New / List Connections, making the submenu
/// redundant — and `true` once a connection is open. Tauri 2 has no
/// `set_visible`, so we insert/remove the submenu from the menu bar (same as
/// `set_query_menu_visible`).
#[tauri::command]
fn set_connection_menu_visible(
    app: tauri::AppHandle,
    visible: bool,
    state: tauri::State<'_, ConnectionMenu>,
) -> Result<(), String> {
    let mut shown = state.shown.lock().map_err(|e| e.to_string())?;
    if *shown == visible {
        return Ok(()); // already in the requested state — nothing to do
    }
    if visible {
        // Clamp the index so a wrong constant can never make insert fail (which,
        // swallowed by the frontend's `.catch`, made the menu silently never
        // appear). Append at the end as a safe fallback.
        let len = state.menu.items().map(|i| i.len()).unwrap_or(0);
        let idx = state.index.min(len);
        state
            .menu
            .insert(&state.submenu as &dyn IsMenuItem<Wry>, idx)
            .map_err(|e| e.to_string())?;
    } else {
        state
            .menu
            .remove(&state.submenu as &dyn IsMenuItem<Wry>)
            .map_err(|e| e.to_string())?;
    }
    // macOS quirk: mutating the TOP-LEVEL menu bar after `set_menu` doesn't
    // refresh the live NSMenu — the change is recorded but not shown. Re-applying
    // the menu forces the menu bar to redraw. (Submenu mutations like the query
    // File items don't need this; top-level ones do.) Harmless on other OSes.
    app.set_menu(state.menu.clone()).map_err(|e| e.to_string())?;
    *shown = visible;
    Ok(())
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
