use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
pub(crate) struct CommandSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub stdin_text: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct CommandOutput {
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u128,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct ShellExecutor;

impl ShellExecutor {
    pub(crate) fn execute(
        &self,
        command: &str,
        cwd: &Path,
        env: &std::collections::BTreeMap<String, String>,
        stdin_text: Option<String>,
    ) -> Result<CommandOutput, std::io::Error> {
        run_program(
            CommandSpec {
                program: OsString::from("/bin/sh"),
                args: vec![OsString::from("-lc"), OsString::from(command)],
                stdin_text,
            },
            cwd,
            env,
        )
    }
}

pub(crate) fn run_program(
    spec: CommandSpec,
    cwd: &Path,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<CommandOutput, std::io::Error> {
    let started_at = timestamp_now();
    let start = std::time::Instant::now();
    let mut child = Command::new(&spec.program)
        .args(&spec.args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(if spec.stdin_text.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(stdin_text) = spec.stdin_text
        && let Some(mut stdin) = child.stdin.take()
    {
        stdin.write_all(stdin_text.as_bytes())?;
    }

    let output = child.wait_with_output()?;
    let mask = secret_values(env);
    let stdout = mask_text(&String::from_utf8_lossy(&output.stdout), &mask);
    let stderr = mask_text(&String::from_utf8_lossy(&output.stderr), &mask);
    let finished_at = timestamp_now();
    Ok(CommandOutput {
        started_at,
        finished_at,
        duration_ms: start.elapsed().as_millis(),
        exit_code: output.status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

fn secret_values(env: &std::collections::BTreeMap<String, String>) -> BTreeSet<String> {
    env.iter()
        .filter(|(key, value)| is_secret_key(key) && value.len() >= 3)
        .map(|(_, value)| value.clone())
        .collect()
}

fn is_secret_key(key: &str) -> bool {
    key.ends_with("_TOKEN")
        || key.ends_with("_SECRET")
        || key.ends_with("_PASSWORD")
        || key.ends_with("_KEY")
}

fn mask_text(text: &str, secrets: &BTreeSet<String>) -> String {
    secrets.iter().fold(text.to_owned(), |masked, secret| masked.replace(secret, "***"))
}

fn timestamp_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}
