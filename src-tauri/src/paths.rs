use std::{env, path::PathBuf};

pub fn lmp_data_dir() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("LOCALAPPDATA") {
        return Ok(PathBuf::from(path).join("LMP"));
    }
    if let Ok(path) = env::var("APPDATA") {
        return Ok(PathBuf::from(path).join("LMP"));
    }
    if let Ok(path) = env::var("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(path).join("LMP"));
    }
    if let Ok(path) = env::var("HOME") {
        return Ok(PathBuf::from(path).join(".config").join("LMP"));
    }

    Err("Could not locate an app data directory for LMP.".to_string())
}
