mod args;
mod events;
mod stream;

use self::args::PreparedClaudeCommand;
use self::stream::{ClaudeStreamState, handle_claude_stream, normalize_claude_stdout};
use super::DefaultStepRunner;
use super::events::ProgressEmitter;
use rigg_core::ConversationHandle;
use rigg_core::progress::StepProgressSink;
use rigg_engine::{EngineError, RenderedClaudeRequest, StepRunResult};

impl DefaultStepRunner {
    pub(super) fn execute_claude(
        &self,
        request: &RenderedClaudeRequest,
        progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        let prepared = PreparedClaudeCommand::from_request(request);
        let mut stream_state = ClaudeStreamState::default();

        let output = crate::runner::io::run_tool_streaming(
            "claude",
            prepared.args,
            &request.cwd,
            &request.env,
            &mut |stream, chunk| handle_claude_stream(progress, &mut stream_state, stream, chunk),
        )?;

        let mut emitter = ProgressEmitter::new(progress);
        emitter.emit_provider_events(stream_state.finish_stdout());

        let succeeded = output.exit_code == 0;
        let result = if succeeded {
            match prepared.result_kind {
                args::ClaudeResultKind::Text => stream_state.text_result(),
                args::ClaudeResultKind::Structured => stream_state.structured_result(),
            }
        } else {
            None
        };
        let provider_events = stream_state.take_provider_events();
        let stdout =
            normalize_claude_stdout(succeeded, prepared.result_kind, &output.stdout, &stream_state);
        let conversation_handle = if request.conversation.is_some() && succeeded {
            let session_id = stream_state.session_id().map(str::to_owned);
            match (
                request
                    .conversation
                    .as_ref()
                    .and_then(|conversation| conversation.resume_session_id.as_ref()),
                session_id,
            ) {
                (_, Some(session_id)) => Some(ConversationHandle::Claude { session_id }),
                (Some(previous), None) => {
                    Some(ConversationHandle::Claude { session_id: previous.clone() })
                }
                (None, None) => None,
            }
        } else {
            None
        };

        Ok(StepRunResult {
            started_at: output.started_at,
            finished_at: output.finished_at,
            duration_ms: output.duration_ms,
            exit_code: output.exit_code,
            stdout,
            stderr: output.stderr,
            result,
            conversation_handle,
            provider_events,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::DefaultStepRunner;
    use rigg_core::progress::StepProgressSink;
    use rigg_core::{CapturedValue, PermissionMode};
    use rigg_engine::{RenderedClaudeConversation, RenderedClaudeRequest};
    use std::collections::BTreeMap;
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn conversation_step_preserves_text() -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-claude-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("claude");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
format=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-format" ]; then
    format="$2"
    shift 2
    continue
  fi
  shift
done
if [ "$format" != "stream-json" ]; then
  printf '%s\n' "unexpected output format: $format" >&2
  exit 9
fi
printf '%s\n' '{"type":"content_block_delta","delta":{"type":"text_delta","text":"```rust\n"}}'
printf '%s\n' '{"type":"content_block_delta","delta":{"type":"text_delta","text":"fn main() {}\n"}}'
printf '%s\n' '{"type":"content_block_delta","delta":{"type":"text_delta","text":"```"}}'
printf '%s\n' '{"type":"result","subtype":"success","session_id":"session-123"}'
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedClaudeRequest {
                cwd: temp_dir.clone(),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                prompt: "continue".to_owned(),
                model: None,
                permission_mode: PermissionMode::Default,
                add_dirs: Vec::new(),
                persistence: rigg_core::Persistence::Persist,
                conversation: Some(RenderedClaudeConversation {
                    resume_session_id: Some("session-123".to_owned()),
                }),
                result_schema: None,
            };
            let mut progress = DisabledProgressSink;
            let execution = DefaultStepRunner::default().execute_claude(&request, &mut progress)?;

            assert_eq!(execution.exit_code, 0);
            assert_eq!(execution.stdout, "```rust\nfn main() {}\n```");
            assert_eq!(
                execution.result,
                Some(CapturedValue::Text("```rust\nfn main() {}\n```".to_owned()))
            );
            assert_eq!(
                execution.conversation_handle,
                Some(rigg_core::ConversationHandle::Claude {
                    session_id: "session-123".to_owned(),
                })
            );

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn failed_conversation_skips_json_parsing() -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-claude-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("claude");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
printf '%s\n' 'Authentication failed'
printf '%s\n' 'bad auth' >&2
exit 2
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedClaudeRequest {
                cwd: temp_dir.clone(),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                prompt: "continue".to_owned(),
                model: None,
                permission_mode: PermissionMode::Default,
                add_dirs: Vec::new(),
                persistence: rigg_core::Persistence::Persist,
                conversation: Some(RenderedClaudeConversation { resume_session_id: None }),
                result_schema: None,
            };
            let mut progress = DisabledProgressSink;
            let execution = DefaultStepRunner::default().execute_claude(&request, &mut progress)?;

            assert_eq!(execution.exit_code, 2);
            assert_eq!(execution.stdout, "Authentication failed\n");
            assert_eq!(execution.stderr, "bad auth\n");
            assert_eq!(execution.result, None);
            assert_eq!(execution.conversation_handle, None);

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn successful_conversation_without_session_id_returns_partial_execution()
    -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-claude-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("claude");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
printf '%s\n' '{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}'
printf '%s\n' '{"type":"result","subtype":"success"}'
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedClaudeRequest {
                cwd: temp_dir.clone(),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                prompt: "continue".to_owned(),
                model: None,
                permission_mode: PermissionMode::Default,
                add_dirs: Vec::new(),
                persistence: rigg_core::Persistence::Persist,
                conversation: Some(RenderedClaudeConversation { resume_session_id: None }),
                result_schema: None,
            };
            let mut progress = DisabledProgressSink;
            let execution = DefaultStepRunner::default().execute_claude(&request, &mut progress)?;

            assert_eq!(execution.exit_code, 0);
            assert_eq!(execution.stdout, "partial");
            assert_eq!(execution.result, Some(CapturedValue::Text("partial".to_owned())));
            assert_eq!(execution.conversation_handle, None);

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[test]
    fn failed_stream_preserves_raw_stdout_after_partial_output()
    -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(not(unix))]
        {
            return Ok(());
        }

        #[cfg(unix)]
        {
            let temp_dir = std::env::temp_dir().join(format!(
                "rigg-claude-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
            ));
            fs::create_dir_all(&temp_dir)?;
            let tool_path = temp_dir.join("claude");
            fs::write(
                &tool_path,
                r#"#!/bin/sh
printf '%s\n' '{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}'
printf '%s\n' 'Authentication failed'
printf '%s\n' 'bad auth' >&2
exit 2
"#,
            )?;
            fs::set_permissions(&tool_path, fs::Permissions::from_mode(0o755))?;

            let request = RenderedClaudeRequest {
                cwd: temp_dir.clone(),
                env: BTreeMap::from([(
                    "PATH".to_owned(),
                    temp_dir.as_os_str().to_string_lossy().into_owned(),
                )]),
                prompt: "continue".to_owned(),
                model: None,
                permission_mode: PermissionMode::Default,
                add_dirs: Vec::new(),
                persistence: rigg_core::Persistence::Persist,
                conversation: Some(RenderedClaudeConversation { resume_session_id: None }),
                result_schema: None,
            };
            let mut progress = DisabledProgressSink;
            let execution = DefaultStepRunner::default().execute_claude(&request, &mut progress)?;

            assert_eq!(execution.exit_code, 2);
            assert_eq!(
                execution.stdout,
                concat!(
                    "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",",
                    "\"text\":\"partial\"}}\nAuthentication failed\n"
                )
            );
            assert_eq!(execution.stderr, "bad auth\n");
            assert_eq!(execution.result, None);
            assert_eq!(execution.conversation_handle, None);

            fs::remove_dir_all(&temp_dir)?;
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct DisabledProgressSink;

    impl StepProgressSink for DisabledProgressSink {
        fn is_enabled(&self) -> bool {
            false
        }
    }
}
