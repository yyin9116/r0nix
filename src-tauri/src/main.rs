// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let text_show = if cfg!(target_os = "windows") {
                "打开 r0nix"
            } else {
                "Show r0nix"
            };
            let text_hide = if cfg!(target_os = "windows") {
                "隐藏到托盘"
            } else {
                "Hide to tray"
            };
            let text_quit = if cfg!(target_os = "windows") {
                "退出"
            } else {
                "Quit"
            };
            let show_item = MenuItem::with_id(app, "tray-show", text_show, true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "tray-hide", text_hide, true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", text_quit, true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new().menu(&tray_menu);
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder
                .on_menu_event(|app: &tauri::AppHandle, event| {
                    match event.id.as_ref() {
                        "tray-show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "tray-hide" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                        "tray-quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray: &TrayIcon, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let visible = window.is_visible().unwrap_or(false);
                            if visible {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::Destroyed => {
                    let app = window.app_handle();
                    for (label, webview) in app.webview_windows() {
                        if label != "main" {
                            let _ = webview.close();
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            r0nix::tauri_commands::open_pdf,
            r0nix::tauri_commands::frontend_log,
            r0nix::tauri_commands::close_pdf,
            r0nix::tauri_commands::get_pdf_info,
            r0nix::tauri_commands::get_page_count,
            r0nix::tauri_commands::list_pdfs,
            r0nix::tauri_commands::read_opened_pdf_bytes,
            r0nix::tauri_commands::request_tiles,
            r0nix::tauri_commands::cancel_tile_request,
            r0nix::tauri_commands::export_page_png,
            r0nix::tauri_commands::export_page_svg,
            r0nix::tauri_commands::download_pdf_via_proxy,
            r0nix::tauri_commands::create_or_show_webview_tab,
            r0nix::tauri_commands::navigate_webview_tab,
            r0nix::tauri_commands::show_webview_tab,
            r0nix::tauri_commands::hide_webview_tab,
            r0nix::tauri_commands::sync_webview_tab_bounds,
            r0nix::tauri_commands::close_webview_tab,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
