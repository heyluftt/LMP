use std::{fs, path::PathBuf};

use tauri::{PhysicalPosition, PhysicalSize, WindowEvent};

use crate::paths::lmp_data_dir;

const MIN_RESTORE_WIDTH: u32 = 1000;
const MIN_RESTORE_HEIGHT: u32 = 640;

#[derive(Clone, Copy)]
struct SavedWindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

pub fn restore_window_state(window: &tauri::WebviewWindow) {
    let Some(state) = read_saved_window_state() else {
        return;
    };
    if !saved_window_state_is_visible(window, state) {
        return;
    }

    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    if state.maximized {
        let _ = window.maximize();
    }
}

pub fn watch_window_state(window: &tauri::WebviewWindow) {
    let watched = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_)
        | WindowEvent::Resized(_)
        | WindowEvent::ScaleFactorChanged { .. } => {
            save_window_state(&watched);
        }
        WindowEvent::CloseRequested { .. } => {
            save_window_state(&watched);
        }
        _ => {}
    });
}

pub fn save_window_state(window: &tauri::WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    if window.is_fullscreen().unwrap_or(false) {
        return;
    }

    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    if size.width < MIN_RESTORE_WIDTH || size.height < MIN_RESTORE_HEIGHT {
        return;
    }

    let state = SavedWindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    };

    let Ok(path) = window_state_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let text = format!(
        "{},{},{},{},{}",
        state.x, state.y, state.width, state.height, state.maximized
    );
    let _ = fs::write(path, text);
}

fn read_saved_window_state() -> Option<SavedWindowState> {
    let path = window_state_path().ok()?;
    let text = fs::read_to_string(path).ok()?;
    let mut parts = text.trim().split(',');

    let mut state = SavedWindowState {
        x: parts.next()?.parse().ok()?,
        y: parts.next()?.parse().ok()?,
        width: parts.next()?.parse().ok()?,
        height: parts.next()?.parse().ok()?,
        maximized: parts.next()?.parse().ok()?,
    };

    state.width = state.width.max(MIN_RESTORE_WIDTH);
    state.height = state.height.max(MIN_RESTORE_HEIGHT);

    Some(state)
}

fn saved_window_state_is_visible(window: &tauri::WebviewWindow, state: SavedWindowState) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }

    let center_x = state.x + (state.width as i32 / 2);
    let center_y = state.y + (state.height as i32 / 2);

    monitors.into_iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let left = position.x;
        let top = position.y;
        let right = left + size.width as i32;
        let bottom = top + size.height as i32;

        center_x >= left && center_x <= right && center_y >= top && center_y <= bottom
    })
}

fn window_state_path() -> Result<PathBuf, String> {
    Ok(lmp_data_dir()?.join("window-state.v1"))
}
