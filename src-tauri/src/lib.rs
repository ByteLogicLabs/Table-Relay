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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Forward adapter-api log lines into the host log pipeline so adapter
    // diagnostics show up in `logs/app.log` alongside host logs.
    adapter_api::log::set_writer(crate::log::write_line);
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir unavailable");
            let store_path = dir.join("store.db");
            let store = Arc::new(
                Store::open(store_path).expect("failed to open connection store"),
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
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&import_sql)
                .item(&export_data)
                .separator()
                .item(&PredefinedMenuItem::close_window(handle, None)?)
                .build()?;

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

            let mut menu_builder = MenuBuilder::new(handle);
            // macOS-only "app menu" (first menu, named after the bundle)
            // carries About / Quit. Without it the app has no Quit entry.
            #[cfg(target_os = "macos")]
            {
                let app_menu = SubmenuBuilder::new(handle, "db-table")
                    .item(&PredefinedMenuItem::about(handle, None, None)?)
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
                if let Some(action) = id.strip_prefix("file_") {
                    let channel = format!("menu-file-{action}");
                    match app_handle.emit(&channel, ()) {
                        Ok(()) => crate::log::write_line("menu", &format!("emitted: {channel}")),
                        Err(e) => crate::log::write_line("menu", &format!("emit failed: {channel}: {e}")),
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Connection store (plain, no encryption)
            commands::store::connections_list,
            commands::store::connections_save,
            commands::store::connections_delete,
            commands::store::ai_settings_list,
            commands::store::ai_settings_get,
            commands::store::ai_settings_save,
            commands::store::ai_settings_forget,
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
            commands::ai::ai_list_local_models,
            commands::ai::ai_download_model,
            commands::ai::ai_cancel_download,
            commands::ai::ai_delete_model,
            commands::ai::ai_check_llama_server,
            commands::ai::ai_chat_send,
            commands::ai::ai_chat_stop,
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
