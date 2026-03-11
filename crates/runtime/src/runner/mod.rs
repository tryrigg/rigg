mod claude;
mod codex;
mod events;
mod io;
mod json;
mod lines;

use crate::process::{ProgramError, ShellExecutor};
use events::ProgressEmitter;
use rigg_core::progress::StepProgressSink;
use rigg_core::{CapturedValue, ShellOutput};
use rigg_engine::{
    EngineError, ExecutorError, RenderedShellRequest, RenderedWriteFileRequest, StepRunRequest,
    StepRunResult, StepRunner,
};
use std::fs;

#[derive(Debug, Default)]
pub struct DefaultStepRunner {
    shell: ShellExecutor,
}

impl StepRunner for DefaultStepRunner {
    fn run_step(
        &self,
        request: &StepRunRequest,
        progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        match request {
            StepRunRequest::Shell(request) => self.execute_shell(request, progress),
            StepRunRequest::Codex(request) => self.execute_codex(request, progress),
            StepRunRequest::Claude(request) => self.execute_claude(request, progress),
            StepRunRequest::WriteFile(request) => self.execute_write_file(request),
        }
    }
}

impl DefaultStepRunner {
    fn execute_shell(
        &self,
        request: &RenderedShellRequest,
        progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        let mut progress = ProgressEmitter::new(progress);
        let output = self
            .shell
            .execute(&request.command, &request.cwd, &request.env, None, &mut |stream, chunk| {
                progress.step_output(stream, chunk);
            })
            .map_err(map_shell_error)?;
        let result = match request.result_mode {
            ShellOutput::None => None,
            ShellOutput::Text | ShellOutput::Json => {
                Some(CapturedValue::Text(output.stdout.clone()))
            }
        };

        Ok(StepRunResult {
            started_at: output.started_at,
            finished_at: output.finished_at,
            duration_ms: output.duration_ms,
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            result,
            conversation_handle: None,
            provider_events: Vec::new(),
        })
    }

    fn execute_write_file(
        &self,
        request: &RenderedWriteFileRequest,
    ) -> Result<StepRunResult, EngineError> {
        let started_at = io::timestamp_now();
        let start = std::time::Instant::now();
        if let Some(parent) = request.path.parent() {
            fs::create_dir_all(parent).map_err(|source| {
                EngineError::Executor(ExecutorError::CreateDirectory {
                    path: parent.to_path_buf(),
                    source,
                })
            })?;
        }
        fs::write(&request.path, &request.contents).map_err(|source| {
            EngineError::Executor(ExecutorError::WriteFile { path: request.path.clone(), source })
        })?;
        let finished_at = io::timestamp_now();

        Ok(StepRunResult {
            started_at,
            finished_at,
            duration_ms: start.elapsed().as_millis(),
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            result: Some(CapturedValue::Json(serde_json::json!({
                "path": request.path.display().to_string()
            }))),
            conversation_handle: None,
            provider_events: Vec::new(),
        })
    }
}

fn map_shell_error(error: ProgramError) -> EngineError {
    EngineError::Executor(match error {
        ProgramError::Spawn { source } => ExecutorError::SpawnShell { source },
        ProgramError::Io { source, .. } => {
            ExecutorError::RunTool { program: "/bin/sh".to_owned(), source }
        }
        ProgramError::MissingStdoutPipe | ProgramError::MissingStderrPipe => {
            ExecutorError::RunTool {
                program: "/bin/sh".to_owned(),
                source: std::io::Error::other("child stdout/stderr pipe was not available"),
            }
        }
        ProgramError::HardTimeout { timeout } => ExecutorError::StepTimedOut {
            program: "/bin/sh".to_owned(),
            timeout_ms: timeout.hard_timeout.as_millis(),
            grace_period_ms: timeout.grace_period.as_millis(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::DefaultStepRunner;
    use super::events::ProgressEmitter;
    use rigg_core::progress::{NoopProgressSink, StepProgressSink};
    use rigg_core::{CapturedValue, ShellOutput, StreamKind};
    use rigg_engine::{RenderedShellRequest, StepRunRequest, StepRunner};
    use std::collections::BTreeMap;

    #[test]
    fn shell_json_preserves_raw_stdout() -> Result<(), Box<dyn std::error::Error>> {
        let execution = DefaultStepRunner::default().run_step(
            &StepRunRequest::Shell(RenderedShellRequest {
                cwd: std::env::temp_dir(),
                env: BTreeMap::new(),
                command: "printf '{'; exit 7".to_owned(),
                result_mode: ShellOutput::Json,
            }),
            &mut NoopProgressSink,
        )?;

        assert_eq!(execution.exit_code, 7);
        assert_eq!(execution.stdout, "{");
        assert_eq!(execution.result, Some(CapturedValue::Text("{".to_owned())));
        Ok(())
    }

    #[test]
    fn shell_json_result_preserves_stdout_for_valid_json() -> Result<(), Box<dyn std::error::Error>>
    {
        let execution = DefaultStepRunner::default().run_step(
            &StepRunRequest::Shell(RenderedShellRequest {
                cwd: std::env::temp_dir(),
                env: BTreeMap::new(),
                command: r#"printf '{"flag":true,"secret":"ok"}'"#.to_owned(),
                result_mode: ShellOutput::Json,
            }),
            &mut NoopProgressSink,
        )?;

        assert_eq!(
            execution.result,
            Some(CapturedValue::Text(r#"{"flag":true,"secret":"ok"}"#.to_owned()))
        );
        Ok(())
    }

    #[test]
    fn live_step_output_streams_raw_chunks() {
        let mut progress = RecordingProgressSink::default();
        let mut emitter = ProgressEmitter::new(&mut progress);
        emitter.step_output(rigg_core::StreamKind::Stdout, "abc");
        emitter.step_output(rigg_core::StreamKind::Stdout, "def");

        assert_eq!(
            progress.events,
            vec![(StreamKind::Stdout, "abc".to_owned()), (StreamKind::Stdout, "def".to_owned()),]
        );
    }

    #[derive(Debug, Default)]
    struct RecordingProgressSink {
        events: Vec<(StreamKind, String)>,
    }

    impl StepProgressSink for RecordingProgressSink {
        fn is_enabled(&self) -> bool {
            true
        }

        fn step_output(&mut self, stream: StreamKind, chunk: &str) {
            self.events.push((stream, chunk.to_owned()));
        }
    }
}
