//! Desktop integration: system tray, close-to-tray and the window shown on launch.
//!
//! Closing the window only hides it (unless the user turned that off), so event
//! reminders keep firing; the tray icon brings it back or quits for real.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, Runtime, Window, WindowEvent, Wry};

/// Launch argument added by the autostart entry: start hidden in the tray.
pub const MINIMIZED_ARG: &str = "--minimized";

struct CloseToTray(AtomicBool);

struct TrayMenu {
    open: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    app.manage(CloseToTray(AtomicBool::new(true)));

    let open = MenuItem::with_id(app, "open", "Open Calendar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Calendar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(TrayMenu { open, quit });

    // The window is created hidden so an autostart launch doesn't flash it on screen.
    if !std::env::args().any(|a| a == MINIMIZED_ARG) {
        show_main_window(app.handle());
    }
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.state::<CloseToTray>().0.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, enabled: bool) {
    app.state::<CloseToTray>().0.store(enabled, Ordering::Relaxed);
}

/// The tray menu is built before the webview knows the UI language, so it relabels it.
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, open: String, quit: String) -> Result<(), String> {
    let menu = app.state::<TrayMenu>();
    menu.open.set_text(open).map_err(|e| e.to_string())?;
    menu.quit.set_text(quit).map_err(|e| e.to_string())
}
