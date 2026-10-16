//! Desktop integration: system tray, close-to-tray and the window shown on launch.
//!
//! Closing the window only hides it (unless the user turned that off), so event
//! reminders keep firing; the tray icon brings it back, lists the next events, or quits.

use serde::Deserialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};

/// Launch argument added by the autostart entry: start hidden in the tray.
pub const MINIMIZED_ARG: &str = "--minimized";
const TRAY_ID: &str = "main";
const EVENT_PREFIX: &str = "event:";

struct CloseToTray(AtomicBool);

#[derive(Deserialize)]
pub struct TrayEvent {
    key: String,
    label: String,
}

/// What the tray menu shows; the webview fills it in (language, upcoming events).
struct TrayState {
    open: String,
    quit: String,
    heading: String,
    empty: String,
    /// `None` while signed out: no "Upcoming" section at all.
    events: Option<Vec<TrayEvent>>,
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, state: &TrayState) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    if let Some(events) = &state.events {
        let heading = if events.is_empty() { &state.empty } else { &state.heading };
        menu.append(&MenuItem::with_id(app, "heading", heading, false, None::<&str>)?)?;
        for event in events {
            let id = format!("{EVENT_PREFIX}{}", event.key);
            menu.append(&MenuItem::with_id(app, id, &event.label, true, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, "open", &state.open, true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", &state.quit, true, None::<&str>)?)?;
    Ok(menu)
}

fn refresh_menu(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<TrayState>>();
    let state = state.lock().map_err(|e| e.to_string())?;
    let menu = build_menu(app, &state).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    app.manage(CloseToTray(AtomicBool::new(true)));

    let state = TrayState {
        open: "Open Calendar".into(),
        quit: "Quit".into(),
        heading: "Upcoming".into(),
        empty: "Nothing coming up".into(),
        events: None,
    };
    let menu = build_menu(app.handle(), &state)?;
    app.manage(Mutex::new(state));

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Calendar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            id => {
                if let Some(key) = id.strip_prefix(EVENT_PREFIX) {
                    show_main_window(app);
                    let _ = app.emit("tray-open-event", key);
                }
            }
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
pub fn set_tray_labels(app: AppHandle, open: String, quit: String, heading: String, empty: String) -> Result<(), String> {
    {
        let state = app.state::<Mutex<TrayState>>();
        let mut state = state.lock().map_err(|e| e.to_string())?;
        (state.open, state.quit, state.heading, state.empty) = (open, quit, heading, empty);
    }
    refresh_menu(&app)
}

/// The next few events, already labelled; `None` hides the section (signed out).
#[tauri::command]
pub fn set_tray_events(app: AppHandle, events: Option<Vec<TrayEvent>>) -> Result<(), String> {
    {
        let state = app.state::<Mutex<TrayState>>();
        state.lock().map_err(|e| e.to_string())?.events = events;
    }
    refresh_menu(&app)
}
