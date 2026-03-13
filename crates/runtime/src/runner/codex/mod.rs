mod args;
mod events;
mod stream;

use self::args::PreparedCodexCommand;
use self::stream::{CodexStreamState, handle_codex_stream, normalize_codex_stdout};
use super::DefaultStepRunner;
use super::events::ProgressEmitter;
use super::io::read_optional_text;
use crate::process::CommandOutput;
use rigg_core::progress::{ProviderEvent, StepProgressSink};
use rigg_core::{CapturedValue, ConversationHandle};
use rigg_engine::{EngineError, ExecutorError, RenderedCodexRequest, StepRunResult};

impl DefaultStepRunner {
    pub(super) fn execute_codex(
        &self,
        request: &RenderedCodexRequest,
        progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        let prepared = PreparedCodexCommand::from_request(request)?;
        self.run_codex_command(request, prepared, progress)
    }

    fn run_codex_command(
        &self,
        request: &RenderedCodexRequest,
        prepared: PreparedCodexCommand,
        progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        let PreparedCodexCommand { args, output_path, result_kind } = prepared;
        let mut stream_state = CodexStreamState::default();
        let output = crate::runner::io::run_tool_streaming(
            "codex",
            args,
            &request.cwd,
            &request.env,
            &mut |stream, chunk| handle_codex_stream(progress, &mut stream_state, stream, chunk),
        )?;
        let mut emitter = ProgressEmitter::new(progress);
        emitter.emit_provider_events(stream_state.finish_stdout());
        let provider_events = stream_state.take_provider_events();
        let result_text = output_path
            .as_ref()
            .map(|path| {
                read_optional_text(path).map_err(|error| {
                    error.with_partial_execution(build_codex_execution(
                        request,
                        &output,
                        &stream_state,
                        provider_events.clone(),
                        None,
                        None,
                    ))
                })
            })
            .transpose()?
            .flatten();
        let result = if output.exit_code == 0 {
            let result =
                result_kind.capture(result_text.as_deref(), &stream_state).map_err(|error| {
                    error.with_partial_execution(build_codex_execution(
                        request,
                        &output,
                        &stream_state,
                        provider_events.clone(),
                        result_text.as_deref(),
                        None,
                    ))
                })?;
            if result.is_none() && matches!(result_kind, args::CodexResultKind::ReviewStructured) {
                return Err(EngineError::Executor(ExecutorError::MissingCodexReviewOutput)
                    .with_partial_execution(build_codex_execution(
                        request,
                        &output,
                        &stream_state,
                        provider_events,
                        result_text.as_deref(),
                        None,
                    )));
            }
            result
        } else {
            None
        };
        Ok(build_codex_execution(
            request,
            &output,
            &stream_state,
            provider_events,
            result_text.as_deref(),
            result.as_ref(),
        ))
    }
}

fn build_codex_execution(
    request: &RenderedCodexRequest,
    output: &CommandOutput,
    stream_state: &CodexStreamState,
    provider_events: Vec<ProviderEvent>,
    result_text: Option<&str>,
    result: Option<&CapturedValue>,
) -> StepRunResult {
    let conversation_handle = if request.conversation.is_some() && output.exit_code == 0 {
        match (
            request
                .conversation
                .as_ref()
                .and_then(|conversation| conversation.resume_thread_id.as_ref()),
            stream_state.thread_id(),
        ) {
            (_, Some(thread_id)) => {
                Some(ConversationHandle::Codex { thread_id: thread_id.to_owned() })
            }
            (Some(previous), None) => {
                Some(ConversationHandle::Codex { thread_id: previous.clone() })
            }
            (None, None) => None,
        }
    } else {
        None
    };

    StepRunResult {
        started_at: output.started_at.clone(),
        finished_at: output.finished_at.clone(),
        duration_ms: output.duration_ms,
        exit_code: output.exit_code,
        stdout: normalize_codex_stdout(
            output.exit_code == 0,
            &output.stdout,
            result_text,
            result,
            stream_state,
        ),
        stderr: output.stderr.clone(),
        result: result.cloned(),
        conversation_handle,
        provider_events,
    }
}

#[cfg(test)]
mod tests {
    use super::DefaultStepRunner;
    use rigg_core::conversation::ConversationProvider;
    use rigg_core::progress::{ProviderEvent, StepProgressSink};
    use rigg_core::{CapturedValue, CodexMode, StreamKind};
    use rigg_engine::{
        EngineError, ExecutorError, RenderedCodexAction, RenderedCodexConversation,
        RenderedCodexRequest,
    };
    use std::collections::BTreeMap;
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn normalizes_stdout_to_final_message() -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-codex-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("codex");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
    continue
  fi
  shift
done
printf '%s\n' '{"type":"agent_message_delta","delta":{"text":"Scanning files..."}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Scanning files..."}}'
printf '%s\n' '{"type":"error","message":"Authentication failed"}'
printf '%s' 'final answer' > "$output"
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedCodexRequest {
                cwd: temp_dir.clone(),
                artifacts_dir: temp_dir
                    .join(".rigg")
                    .join("runs")
                    .join("test-run")
                    .join("artifacts")
                    .join("codex"),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                result_schema: None,
                conversation: None,
                action: RenderedCodexAction::Exec {
                    prompt: "fix it".to_owned(),
                    model: None,
                    mode: CodexMode::Default,
                    add_dirs: Vec::new(),
                    persistence: rigg_core::Persistence::Ephemeral,
                },
            };
            let mut progress = RecordingProgressSink::default();
            let execution = DefaultStepRunner::default().execute_codex(&request, &mut progress)?;

            assert_eq!(execution.stdout, "final answer");
            assert_eq!(execution.result, Some(CapturedValue::Text("final answer".to_owned())));
            let artifact_files = fs::read_dir(&request.artifacts_dir)?
                .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
                .collect::<Result<Vec<_>, _>>()?;
            assert!(artifact_files.iter().any(|name| name.starts_with("exec-output-")));
            assert_eq!(
                progress.events,
                vec![
                    StepProgressEvent::Provider(ProviderEvent::Status {
                        provider: ConversationProvider::Codex,
                        message: "Scanning files...".to_owned()
                    }),
                    StepProgressEvent::Provider(ProviderEvent::Error {
                        provider: ConversationProvider::Codex,
                        message: "Authentication failed".to_owned()
                    }),
                ]
            );

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn keeps_structured_result_raw() -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-codex-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("codex");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
    continue
  fi
  shift
done
printf '%s\n' '{"type":"agent_message_delta","delta":{"text":"streaming..."}}'
printf '%s' '{"markdown":"ok"}' > "$output"
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedCodexRequest {
                cwd: temp_dir.clone(),
                artifacts_dir: temp_dir
                    .join(".rigg")
                    .join("runs")
                    .join("test-run")
                    .join("artifacts")
                    .join("codex"),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                result_schema: Some(serde_json::json!({
                    "type": "object",
                    "required": ["markdown"],
                    "properties": {
                        "markdown": { "type": "string" }
                    }
                })),
                conversation: None,
                action: RenderedCodexAction::Exec {
                    prompt: "fix it".to_owned(),
                    model: None,
                    mode: CodexMode::Default,
                    add_dirs: Vec::new(),
                    persistence: rigg_core::Persistence::Ephemeral,
                },
            };
            let mut progress = RecordingProgressSink::default();
            let execution = DefaultStepRunner::default().execute_codex(&request, &mut progress)?;

            assert_eq!(execution.stdout, r#"{"markdown":"ok"}"#);
            assert_eq!(
                execution.result,
                Some(CapturedValue::Json(serde_json::json!({"markdown":"ok"})))
            );
            let artifact_files = fs::read_dir(&request.artifacts_dir)?
                .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
                .collect::<Result<Vec<_>, _>>()?;
            assert!(artifact_files.iter().any(|name| name.starts_with("exec-output-")));
            assert!(artifact_files.iter().any(|name| name.starts_with("exec-schema-")));

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn review_uses_structured_review_output() -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-codex-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("codex");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
printf '%s\n' '{"type":"agent_message_delta","delta":{"text":"Reviewing diff..."}}'
printf '%s\n' '{"type":"exited_review_mode","review_output":{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"looks good","overall_confidence_score":0.91}}'
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedCodexRequest {
                cwd: temp_dir.clone(),
                artifacts_dir: temp_dir
                    .join(".rigg")
                    .join("runs")
                    .join("test-run")
                    .join("artifacts")
                    .join("codex"),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                result_schema: None,
                conversation: None,
                action: RenderedCodexAction::Review {
                    prompt: Some("review it".to_owned()),
                    model: None,
                    mode: CodexMode::Default,
                    title: None,
                    add_dirs: Vec::new(),
                    persistence: rigg_core::Persistence::Ephemeral,
                    scope: rigg_engine::RenderedReviewScope::Uncommitted,
                },
            };
            let mut progress = RecordingProgressSink::default();
            let execution = DefaultStepRunner::default().execute_codex(&request, &mut progress)?;

            assert_eq!(
                execution.stdout,
                r#"{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"looks good","overall_confidence_score":0.91}"#
            );
            assert_eq!(
                execution.result,
                Some(CapturedValue::Json(serde_json::json!({
                    "findings": [],
                    "overall_correctness": "patch is correct",
                    "overall_explanation": "looks good",
                    "overall_confidence_score": 0.91
                })))
            );

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn review_without_review_output_returns_partial_execution()
    -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-codex-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("codex");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
printf '%s\n' '{"type":"agent_message_delta","delta":{"text":"Reviewing diff..."}}'
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedCodexRequest {
                cwd: temp_dir.clone(),
                artifacts_dir: temp_dir
                    .join(".rigg")
                    .join("runs")
                    .join("test-run")
                    .join("artifacts")
                    .join("codex"),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                result_schema: None,
                conversation: None,
                action: RenderedCodexAction::Review {
                    prompt: Some("review it".to_owned()),
                    model: None,
                    mode: CodexMode::Default,
                    title: None,
                    add_dirs: Vec::new(),
                    persistence: rigg_core::Persistence::Ephemeral,
                    scope: rigg_engine::RenderedReviewScope::Uncommitted,
                },
            };
            let mut progress = RecordingProgressSink::default();
            let error = DefaultStepRunner::default()
                .execute_codex(&request, &mut progress)
                .expect_err("missing review output should fail");

            let EngineError::Executor(ExecutorError::StepPostProcess { execution, source }) = error
            else {
                panic!("expected partial execution error");
            };
            assert!(matches!(source.as_ref(), ExecutorError::MissingCodexReviewOutput));
            assert_eq!(execution.exit_code, 0);
            assert_eq!(execution.stdout, "Reviewing diff...");
            assert_eq!(execution.result, None);

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn failed_conversation_preserves_exit() -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-codex-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("codex");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
printf '%s\n' '{"type":"error","message":"Authentication failed"}'
printf '%s\n' 'bad auth' >&2
exit 2
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedCodexRequest {
                cwd: temp_dir.clone(),
                artifacts_dir: temp_dir
                    .join(".rigg")
                    .join("runs")
                    .join("test-run")
                    .join("artifacts")
                    .join("codex"),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                result_schema: None,
                conversation: Some(RenderedCodexConversation { resume_thread_id: None }),
                action: RenderedCodexAction::Exec {
                    prompt: "fix it".to_owned(),
                    model: None,
                    mode: CodexMode::Default,
                    add_dirs: Vec::new(),
                    persistence: rigg_core::Persistence::Persist,
                },
            };
            let mut progress = RecordingProgressSink::default();
            let execution = DefaultStepRunner::default().execute_codex(&request, &mut progress)?;

            assert_eq!(execution.exit_code, 2);
            assert_eq!(execution.stderr, "bad auth\n");
            assert_eq!(execution.conversation_handle, None);
            assert_eq!(progress.events.len(), 2);
            assert!(progress.events.iter().any(|event| matches!(
                event,
                StepProgressEvent::Provider(ProviderEvent::Error { message, .. })
                    if message == "Authentication failed"
            )));
            assert!(progress.events.iter().any(|event| matches!(
                event,
                StepProgressEvent::Output { stream: StreamKind::Stderr, chunk }
                    if chunk == "bad auth\n"
            )));

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn successful_conversation_without_thread_id_returns_partial_execution()
    -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-codex-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("codex");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
    continue
  fi
  shift
done
printf '%s\n' '{"type":"agent_message_delta","delta":{"text":"Scanning files..."}}'
printf '%s' 'final answer' > "$output"
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedCodexRequest {
                cwd: temp_dir.clone(),
                artifacts_dir: temp_dir
                    .join(".rigg")
                    .join("runs")
                    .join("test-run")
                    .join("artifacts")
                    .join("codex"),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                result_schema: None,
                conversation: Some(RenderedCodexConversation { resume_thread_id: None }),
                action: RenderedCodexAction::Exec {
                    prompt: "fix it".to_owned(),
                    model: None,
                    mode: CodexMode::Default,
                    add_dirs: Vec::new(),
                    persistence: rigg_core::Persistence::Persist,
                },
            };
            let mut progress = RecordingProgressSink::default();
            let execution = DefaultStepRunner::default().execute_codex(&request, &mut progress)?;

            assert_eq!(execution.exit_code, 0);
            assert_eq!(execution.stdout, "final answer");
            assert_eq!(execution.result, Some(CapturedValue::Text("final answer".to_owned())));
            assert_eq!(execution.conversation_handle, None);

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn failed_non_conversation_keeps_process_stdout_even_with_output_file()
    -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-codex-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("codex");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
    continue
  fi
  shift
done
printf '%s\n' 'provider failed'
printf '%s' 'partial result' > "$output"
exit 2
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedCodexRequest {
                cwd: temp_dir.clone(),
                artifacts_dir: temp_dir
                    .join(".rigg")
                    .join("runs")
                    .join("test-run")
                    .join("artifacts")
                    .join("codex"),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                result_schema: None,
                conversation: None,
                action: RenderedCodexAction::Exec {
                    prompt: "fix it".to_owned(),
                    model: None,
                    mode: CodexMode::Default,
                    add_dirs: Vec::new(),
                    persistence: rigg_core::Persistence::Ephemeral,
                },
            };
            let mut progress = RecordingProgressSink::default();
            let execution = DefaultStepRunner::default().execute_codex(&request, &mut progress)?;

            assert_eq!(execution.exit_code, 2);
            assert_eq!(execution.stdout, "provider failed\n");
            assert_eq!(execution.result, None);

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn malformed_structured_output_keeps_provider_events_in_partial_execution()
    -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-codex-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("codex");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
    continue
  fi
  shift
done
printf '%s\n' '{"type":"agent_message_delta","delta":{"text":"streaming..."}}'
printf '%s\n' '{"type":"error","message":"invalid JSON"}'
printf '%s' '{' > "$output"
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedCodexRequest {
                cwd: temp_dir.clone(),
                artifacts_dir: temp_dir
                    .join(".rigg")
                    .join("runs")
                    .join("test-run")
                    .join("artifacts")
                    .join("codex"),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                result_schema: Some(serde_json::json!({
                    "type": "object",
                    "required": ["markdown"],
                    "properties": {
                        "markdown": { "type": "string" }
                    }
                })),
                conversation: None,
                action: RenderedCodexAction::Exec {
                    prompt: "fix it".to_owned(),
                    model: None,
                    mode: CodexMode::Default,
                    add_dirs: Vec::new(),
                    persistence: rigg_core::Persistence::Ephemeral,
                },
            };
            let mut progress = RecordingProgressSink::default();
            let error = DefaultStepRunner::default()
                .execute_codex(&request, &mut progress)
                .expect_err("malformed JSON should fail");

            let EngineError::Executor(ExecutorError::StepPostProcess { execution, source }) = error
            else {
                panic!("expected partial execution error");
            };
            assert!(matches!(
                source.as_ref(),
                ExecutorError::ParseJsonOutput { tool: "codex", .. }
            ));
            assert_eq!(execution.exit_code, 0);
            assert_eq!(execution.stdout, "{");
            assert_eq!(execution.stderr, "");
            assert_eq!(execution.result, None);
            assert_eq!(execution.provider_events.len(), 2);
            assert!(matches!(
                &execution.provider_events[0],
                rigg_core::progress::ProviderEvent::Status { message, .. }
                    if message == "streaming..."
            ));
            assert!(matches!(
                &execution.provider_events[1],
                rigg_core::progress::ProviderEvent::Error { message, .. }
                    if message == "invalid JSON"
            ));
            assert_eq!(progress.events.len(), 2);

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct RecordingProgressSink {
        events: Vec<StepProgressEvent>,
    }

    impl StepProgressSink for RecordingProgressSink {
        fn is_enabled(&self) -> bool {
            true
        }

        fn step_output(&mut self, stream: StreamKind, chunk: &str) {
            self.events.push(StepProgressEvent::Output { stream, chunk: chunk.to_owned() });
        }

        fn provider_event(&mut self, event: ProviderEvent) {
            self.events.push(StepProgressEvent::Provider(event));
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum StepProgressEvent {
        Output { stream: StreamKind, chunk: String },
        Provider(ProviderEvent),
    }
}
