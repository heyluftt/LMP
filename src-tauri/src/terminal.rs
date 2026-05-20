use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
    thread,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
}

#[derive(Clone, Serialize)]
struct TerminalOutputPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExitPayload {
    id: String,
}

fn default_shell_program() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "powershell.exe"
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .as_deref()
            .unwrap_or("/bin/sh")
    }
}

fn build_shell_command(shell: Option<String>, cwd: Option<String>) -> CommandBuilder {
    let requested = shell
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    #[cfg(target_os = "windows")]
    let mut command = {
        let shell_name = requested.unwrap_or_else(|| default_shell_program().to_string());
        let lower = shell_name.to_ascii_lowercase();

        if lower.contains("cmd") {
            CommandBuilder::new("cmd.exe")
        } else if lower.contains("pwsh") {
            let mut cmd = CommandBuilder::new("pwsh.exe");
            cmd.arg("-NoLogo");
            cmd
        } else {
            let mut cmd = CommandBuilder::new("powershell.exe");
            cmd.arg("-NoLogo");
            cmd
        }
    };

    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let shell_name = requested.unwrap_or_else(|| default_shell_program().to_string());
        CommandBuilder::new(shell_name)
    };

    if let Some(cwd_value) = cwd {
        let path = PathBuf::from(cwd_value);
        if path.is_dir() {
            command.cwd(path);
        }
    }

    command
}

fn close_existing_session(state: &TerminalState, id: &str) {
    let existing = state.sessions.lock().ok().and_then(|mut sessions| sessions.remove(id));

    if let Some(mut session) = existing {
        let _ = session.child.kill();
    }
}

#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, TerminalState>,
    id: String,
    cwd: Option<String>,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(), String> {
    let id = id.trim().to_string();

    if id.is_empty() {
        return Err("terminal id is empty".to_string());
    }

    close_existing_session(&state, &id);

    let pty_system = native_pty_system();

    let pty_pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24).max(4),
            cols: cols.unwrap_or(80).max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to open pty: {error}"))?;

    let command = build_shell_command(shell, cwd);

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to spawn shell: {error}"))?;

    let mut reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to create terminal reader: {error}"))?;

    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to create terminal writer: {error}"))?;

    let reader_id = id.clone();
    let reader_app = app.clone();

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    let _ = reader_app.emit(
                        "terminal-output",
                        TerminalOutputPayload {
                            id: reader_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }

        let _ = reader_app.emit(
            "terminal-exit",
            TerminalExitPayload {
                id: reader_id.clone(),
            },
        );
    });

    let session = TerminalSession {
        writer,
        child,
        master: pty_pair.master,
    };

    state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock poisoned".to_string())?
        .insert(id, session);

    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock poisoned".to_string())?;

    let session = sessions
        .get_mut(id.trim())
        .ok_or_else(|| "terminal session not found".to_string())?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("failed to write to terminal: {error}"))?;

    session
        .writer
        .flush()
        .map_err(|error| format!("failed to flush terminal input: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock poisoned".to_string())?;

    let session = sessions
        .get_mut(id.trim())
        .ok_or_else(|| "terminal session not found".to_string())?;

    session
        .master
        .resize(PtySize {
            rows: rows.max(4),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to resize terminal: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn terminal_kill(
    state: State<'_, TerminalState>,
    id: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock poisoned".to_string())?
        .remove(id.trim());

    if let Some(mut session) = session {
        let _ = session.child.kill();
    }

    Ok(())
}
