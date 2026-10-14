// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Manager, WindowEvent};

const MACOS_TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon.png");

fn main() {
    // 打包产物自检：`r0nix --check-python-runtime`。发布流水线用它断言「包里的
    // Python 真的被用上了」—— 这类缺陷在构建机上永远看不出来，详见 py_render.rs。
    if let Some(code) = r0nix::py_render::python_runtime_self_check_if_requested() {
        std::process::exit(code);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Ok(removed) =
                r0nix::tauri_commands::cleanup_stale_web_pdf_temp_files(app.handle())
            {
                if removed > 0 {
                    eprintln!("[temp-cleanup] removed {removed} stale managed temp file(s)");
                }
            }
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
            if cfg!(target_os = "macos") {
                let icon = image::load_from_memory(MACOS_TRAY_ICON_PNG).map_err(|error| {
                    tauri::Error::AssetNotFound(format!("macOS tray icon: {error}"))
                })?;
                let rgba = icon.to_rgba8();
                let tray_icon = Image::new_owned(rgba.into_raw(), icon.width(), icon.height());
                tray_builder = tray_builder.icon(tray_icon).icon_as_template(true);
            } else if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder
                .on_menu_event(|app: &tauri::AppHandle, event| match event.id.as_ref() {
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
                    if cfg!(debug_assertions) {
                        return;
                    }
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
            r0nix::tauri_commands::read_text_file,
            r0nix::tauri_commands::write_text_file,
            r0nix::tauri_commands::write_binary_file,
            r0nix::tauri_commands::write_temp_file,
            r0nix::tauri_commands::remove_managed_web_pdf_temp,
            r0nix::tauri_commands::remove_managed_import_temp,
            r0nix::tauri_commands::collect_importable_paths,
            r0nix::tauri_commands::close_pdf,
            r0nix::tauri_commands::get_pdf_info,
            r0nix::tauri_commands::get_page_count,
            r0nix::tauri_commands::list_pdfs,
            r0nix::tauri_commands::read_opened_pdf_bytes,
            r0nix::tauri_commands::cancel_pdf_byte_read,
            r0nix::tauri_commands::dev_auto_open_path,
            r0nix::tauri_commands::dev_auto_close_after_ms,
            r0nix::tauri_commands::dev_auto_close_actions,
            r0nix::tauri_commands::dev_auto_cycle,
            r0nix::tauri_commands::cancel_pdf_page_count,
            r0nix::tauri_commands::request_tiles,
            r0nix::tauri_commands::cancel_tile_request,
            r0nix::tauri_commands::export_page_png,
            r0nix::tauri_commands::extract_pdf_image,
            r0nix::tauri_commands::export_page_svg,
            r0nix::tauri_commands::export_page_svg_crop,
            r0nix::tauri_commands::cancel_pdf_export,
            r0nix::tauri_commands::get_page_images,
            r0nix::tauri_commands::cancel_pdf_image_scan,
            r0nix::tauri_commands::get_pdf_reading_blocks,
            r0nix::tauri_commands::cancel_pdf_reading_blocks,
            r0nix::tauri_commands::download_pdf_via_proxy,
            r0nix::tauri_commands::download_pdf_to_temp,
            r0nix::tauri_commands::llm_chat_completion,
            r0nix::tauri_commands::cancel_llm_chat_completion,
            r0nix::tauri_commands::create_or_show_webview_tab,
            r0nix::tauri_commands::navigate_webview_tab,
            r0nix::tauri_commands::navigate_webview_tab_history,
            r0nix::tauri_commands::show_webview_tab,
            r0nix::tauri_commands::hide_webview_tab,
            r0nix::tauri_commands::sync_webview_tab_bounds,
            r0nix::tauri_commands::close_webview_tab,
            r0nix::tauri_commands::store_secret,
            r0nix::tauri_commands::load_secret,
            r0nix::tauri_commands::migrate_keychain_secret,
            r0nix::tauri_commands::app_data_dir,
            r0nix::tauri_commands::read_app_data_json,
            r0nix::tauri_commands::write_app_data_json,
            r0nix::tauri_commands::workspace_info,
            r0nix::tauri_commands::set_workspace_root,
            r0nix::tauri_commands::clear_workspace_cache,
            r0nix::tauri_commands::import_document_to_workspace,
            r0nix::tauri_commands::remove_workspace_document,
            r0nix::tauri_commands::reveal_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
