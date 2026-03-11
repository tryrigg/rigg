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

pub(crate) fn temp_root(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let root = std::env::temp_dir().join(format!("rigg-cli-{prefix}-{suffix}"));
    let _ = fs::create_dir_all(&root);
    root
}
