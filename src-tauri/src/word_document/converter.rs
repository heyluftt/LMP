use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{self, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const LIBREOFFICE_CONVERSION_TIMEOUT: Duration = Duration::from_secs(25);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) enum LegacyDocConversion {
    Converted(String),
    MissingConverter,
    Failed,
}

pub(crate) fn convert_legacy_doc_to_text(path: &Path) -> LegacyDocConversion {
    let Some(soffice) = find_libreoffice_executable() else {
        return LegacyDocConversion::MissingConverter;
    };

    let temp_dir = unique_conversion_dir();
    let result = fs::create_dir_all(&temp_dir)
        .map_err(|_| ())
        .and_then(|_| run_libreoffice_conversion(&soffice, path, &temp_dir))
        .and_then(|_| read_converted_text(path, &temp_dir));

    remove_temp_conversion_dir(&temp_dir);

    match result {
        Ok(text) if !text.trim().is_empty() => LegacyDocConversion::Converted(text),
        _ => LegacyDocConversion::Failed,
    }
}

fn find_libreoffice_executable() -> Option<PathBuf> {
    find_executable_in_path("soffice.exe")
        .or_else(|| find_executable_in_path("soffice"))
        .or_else(|| {
            [
                r"C:\Program Files\LibreOffice\program\soffice.exe",
                r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
            ]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
        })
}

fn find_executable_in_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|entry| entry.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn run_libreoffice_conversion(soffice: &Path, input: &Path, output_dir: &Path) -> Result<(), ()> {
    let mut command = Command::new(soffice);
    command
        .arg("--headless")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--norestore")
        .arg("--nolockcheck")
        .arg("--convert-to")
        .arg("txt:Text")
        .arg("--outdir")
        .arg(output_dir)
        .arg(input)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    run_with_timeout(command, LIBREOFFICE_CONVERSION_TIMEOUT)
}

fn run_with_timeout(mut command: Command, timeout: Duration) -> Result<(), ()> {
    let start = Instant::now();
    let mut child = command.spawn().map_err(|_| ())?;

    loop {
        if let Some(status) = child.try_wait().map_err(|_| ())? {
            return status.success().then_some(()).ok_or(());
        }

        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(());
        }

        thread::sleep(Duration::from_millis(50));
    }
}

fn read_converted_text(input: &Path, output_dir: &Path) -> Result<String, ()> {
    let converted = find_converted_text_file(input, output_dir).ok_or(())?;
    let bytes = fs::read(converted).map_err(|_| ())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn find_converted_text_file(input: &Path, output_dir: &Path) -> Option<PathBuf> {
    if let Some(stem) = input.file_stem().and_then(|value| value.to_str()) {
        let expected = output_dir.join(format!("{stem}.txt"));
        if expected.is_file() {
            return Some(expected);
        }
    }

    fs::read_dir(output_dir).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        path.extension()
            .and_then(|value| value.to_str())
            .map(|extension| extension.eq_ignore_ascii_case("txt"))
            .filter(|is_text| *is_text)
            .map(|_| path)
    })
}

fn unique_conversion_dir() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    env::temp_dir().join(format!("lmp-word-{}-{timestamp}-{counter}", process::id()))
}

fn remove_temp_conversion_dir(path: &Path) {
    let is_lmp_temp_dir = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|name| name.starts_with("lmp-word-"))
        .unwrap_or(false);
    if is_lmp_temp_dir {
        let _ = fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converted_text_lookup_prefers_matching_stem() {
        let root = unique_conversion_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let input = root.join("sample.doc");
        let expected = root.join("sample.txt");
        fs::write(&expected, "text").expect("write converted text");

        assert_eq!(find_converted_text_file(&input, &root), Some(expected));
        remove_temp_conversion_dir(&root);
    }

    #[test]
    fn temp_cleanup_only_targets_lmp_word_dirs() {
        let root = unique_conversion_dir();
        fs::create_dir_all(&root).expect("temp dir");
        assert!(root.exists());
        remove_temp_conversion_dir(&root);
        assert!(!root.exists());
    }
}
