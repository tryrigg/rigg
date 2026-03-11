use crate::process::{
    CommandOutput, CommandSpec, CommandTimeouts, ProgramError, run_program_streaming,
};
use rigg_core::StreamKind;
use rigg_engine::{EngineError, ExecutorError};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const PROVIDER_HARD_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const PROVIDER_TERMINATE_GRACE: Duration = Duration::from_secs(5);

pub(super) fn run_tool_streaming(
    program: &str,
    args: Vec<OsString>,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    on_output: &mut dyn FnMut(StreamKind, &str),
) -> Result<CommandOutput, EngineError> {
    run_program_streaming(
        CommandSpec { program: OsString::from(program), args, stdin_text: None },
        cwd,
        env,
        provider_timeouts(),
        on_output,
    )
    .map_err(|source| map_tool_error(program, source))
}

pub(super) fn read_optional_text(path: &Path) -> Result<Option<String>, EngineError> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|source| {
        EngineError::Executor(ExecutorError::ReadFile { path: path.to_path_buf(), source })
    })?;
    Ok(Some(text))
}

pub(super) fn write_schema_file(
    artifacts_dir: &Path,
    prefix: &str,
    schema: Option<&JsonValue>,
) -> Result<Option<PathBuf>, EngineError> {
    let Some(schema) = schema else {
        return Ok(None);
    };

    let path = artifact_file(artifacts_dir, prefix, "json")?;
    fs::write(
        &path,
        serde_json::to_vec_pretty(schema).map_err(|source| {
            EngineError::Executor(ExecutorError::SerializeJson {
                operation: "structured output",
                source,
            })
        })?,
    )
    .map_err(|source| {
        EngineError::Executor(ExecutorError::WriteSchema { path: path.clone(), source })
    })?;
    Ok(Some(path))
}

pub(super) fn artifact_file(
    artifacts_dir: &Path,
    prefix: &str,
    ext: &str,
) -> Result<PathBuf, EngineError> {
    fs::create_dir_all(artifacts_dir).map_err(|source| {
        EngineError::Executor(ExecutorError::CreateDirectory {
            path: artifacts_dir.to_path_buf(),
            source,
        })
    })?;
    Ok(artifacts_dir.join(format!("{prefix}-{}.{}", Uuid::now_v7(), ext)))
}

pub(super) fn timestamp_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn provider_timeouts() -> CommandTimeouts {
    CommandTimeouts::new(Some(PROVIDER_HARD_TIMEOUT), PROVIDER_TERMINATE_GRACE)
}

fn map_tool_error(program: &str, error: ProgramError) -> EngineError {
    EngineError::Executor(match error {
        ProgramError::Spawn { source } | ProgramError::Io { source, .. } => {
            ExecutorError::RunTool { program: program.to_owned(), source }
        }
        ProgramError::MissingStdoutPipe | ProgramError::MissingStderrPipe => {
            ExecutorError::RunTool {
                program: program.to_owned(),
                source: std::io::Error::other("child stdout/stderr pipe was not available"),
            }
        }
        ProgramError::HardTimeout { timeout } => ExecutorError::StepTimedOut {
            program: program.to_owned(),
            timeout_ms: timeout.hard_timeout.as_millis(),
            grace_period_ms: timeout.grace_period.as_millis(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{PROVIDER_HARD_TIMEOUT, provider_timeouts};

    #[test]
    fn provider_runs_use_hard_timeout() {
        let timeouts = provider_timeouts();
        assert_eq!(timeouts.hard_timeout, Some(PROVIDER_HARD_TIMEOUT));
    }
}
