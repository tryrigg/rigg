use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn run<'a>(
    cwd: &Path,
    args: impl IntoIterator<Item = &'a str>,
) -> Result<Output, std::io::Error> {
    Command::new(env!("CARGO_BIN_EXE_rigg")).current_dir(cwd).args(args).output()
}

#[allow(dead_code)]
pub(crate) fn run_with_env<'a, 'b>(
    cwd: &Path,
    args: impl IntoIterator<Item = &'a str>,
    env: impl IntoIterator<Item = (&'b str, String)>,
) -> Result<Output, std::io::Error> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rigg"));
    command.current_dir(cwd).args(args);
    for (key, value) in env {
        command.env(key, value);
    }
    command.output()
}

pub(crate) fn temp_root(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let root = std::env::temp_dir().join(format!("rigg-cli-{prefix}-{suffix}"));
    let _ = fs::create_dir_all(&root);
    root
}
