use super::events::CodexStreamEvent;
use crate::runner::events::{ProgressEmitter, ProviderEvent};
use crate::runner::lines::LineBuffer;
use rigg_core::conversation::ConversationProvider;
use rigg_core::progress::StepProgressSink;
use rigg_core::{CapturedValue, StreamKind};
use rigg_engine::{EngineError, ExecutorError};
use serde_json::Value as JsonValue;

#[derive(Debug, Default)]
pub(super) struct CodexStreamState {
    stdout_lines: LineBuffer,
    pending_message: String,
    stdout: String,
    review_output: Option<JsonValue>,
    review_output_text: Option<String>,
    thread_id: Option<String>,
    provider_events: Vec<ProviderEvent>,
}

impl CodexStreamState {
    pub(super) fn push_stdout(&mut self, chunk: &str) -> Vec<ProviderEvent> {
        let mut events = Vec::new();
        for line in self.stdout_lines.push(chunk) {
            self.handle_stdout_line(&line, &mut events);
        }
        events
    }

    pub(super) fn finish_stdout(&mut self) -> Vec<ProviderEvent> {
        let mut events = Vec::new();
        if let Some(line) = self.stdout_lines.finish() {
            self.handle_stdout_line(&line, &mut events);
        }
        self.flush_pending_message();
        events
    }

    fn handle_stdout_line(&mut self, line: &str, events: &mut Vec<ProviderEvent>) {
        if let Some(thread_id) = extract_thread_id(line) {
            self.thread_id = Some(thread_id);
        }
        match CodexStreamEvent::from_line(line) {
            CodexStreamEvent::ToolUse { tool, detail } => {
                self.push_provider_event(
                    events,
                    ProviderEvent::ToolUse { provider: ConversationProvider::Codex, tool, detail },
                );
            }
            CodexStreamEvent::MessageDelta(message) => {
                self.push_provider_event(
                    events,
                    ProviderEvent::Status {
                        provider: ConversationProvider::Codex,
                        message: message.clone(),
                    },
                );
                self.pending_message.push_str(&message);
            }
            CodexStreamEvent::Message(message) => {
                if self.pending_message.is_empty() {
                    self.push_provider_event(
                        events,
                        ProviderEvent::Status {
                            provider: ConversationProvider::Codex,
                            message: message.clone(),
                        },
                    );
                    self.push_stdout_line(&message);
                } else {
                    if let Some(suffix) = message.strip_prefix(&self.pending_message) {
                        if !suffix.is_empty() {
                            self.push_provider_event(
                                events,
                                ProviderEvent::Status {
                                    provider: ConversationProvider::Codex,
                                    message: suffix.to_owned(),
                                },
                            );
                        }
                    } else if self.pending_message != message {
                        self.push_provider_event(
                            events,
                            ProviderEvent::Status {
                                provider: ConversationProvider::Codex,
                                message: message.clone(),
                            },
                        );
                    }
                    self.pending_message = message;
                    self.flush_pending_message();
                }
            }
            CodexStreamEvent::ReviewOutput { value, raw_text } => {
                self.flush_pending_message();
                self.review_output = Some(value);
                self.review_output_text = Some(raw_text);
            }
            CodexStreamEvent::Error(error) => {
                self.push_provider_event(
                    events,
                    ProviderEvent::Error {
                        provider: ConversationProvider::Codex,
                        message: error.clone(),
                    },
                );
                self.flush_pending_message();
                self.push_stdout_line(&error);
            }
            CodexStreamEvent::Status(status) => {
                self.push_provider_event(
                    events,
                    ProviderEvent::Status {
                        provider: ConversationProvider::Codex,
                        message: status.clone(),
                    },
                );
                self.flush_pending_message();
                self.push_stdout_line(&status);
            }
            CodexStreamEvent::Ignore => {}
        }
    }

    fn push_provider_event(&mut self, events: &mut Vec<ProviderEvent>, event: ProviderEvent) {
        self.provider_events.push(event.clone());
        events.push(event);
    }

    pub(super) fn take_provider_events(&mut self) -> Vec<ProviderEvent> {
        std::mem::take(&mut self.provider_events)
    }

    fn flush_pending_message(&mut self) {
        if self.pending_message.is_empty() {
            return;
        }
        let message = std::mem::take(&mut self.pending_message);
        self.push_stdout_line(&message);
    }

    fn push_stdout_line(&mut self, line: &str) {
        if line.is_empty() {
            return;
        }
        if !self.stdout.is_empty() {
            self.stdout.push('\n');
        }
        self.stdout.push_str(line);
    }

    pub(super) fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }

    pub(super) fn capture_review_result(&self) -> Result<Option<CapturedValue>, EngineError> {
        match (&self.review_output, &self.review_output_text) {
            (Some(value), _) => Ok(Some(CapturedValue::Json(value.clone()))),
            (None, Some(raw_text)) => serde_json::from_str(raw_text.trim())
                .map(CapturedValue::Json)
                .map(Some)
                .map_err(|source| {
                    EngineError::Executor(ExecutorError::ParseJsonOutput { tool: "codex", source })
                }),
            (None, None) => Ok(None),
        }
    }

    fn review_stdout(&self) -> Option<String> {
        self.review_output_text
            .clone()
            .or_else(|| self.review_output.as_ref().map(JsonValue::to_string))
    }
}

pub(super) fn handle_codex_stream(
    progress: &mut dyn StepProgressSink,
    stream_state: &mut CodexStreamState,
    stream: StreamKind,
    chunk: &str,
) {
    let mut progress = ProgressEmitter::new(progress);
    match stream {
        StreamKind::Stderr => progress.step_output(stream, chunk),
        StreamKind::Stdout => progress.emit_provider_events(stream_state.push_stdout(chunk)),
    }
}

pub(super) fn normalize_codex_stdout(
    succeeded: bool,
    raw_stdout: &str,
    result_text: Option<&str>,
    structured_result: Option<&CapturedValue>,
    stream_state: &CodexStreamState,
) -> String {
    if succeeded {
        if let Some(text) = stream_state.review_stdout() {
            return text;
        }
        if let Some(text) = result_text {
            return text.to_owned();
        }
        if let Some(CapturedValue::Json(value)) = structured_result {
            return value.to_string();
        }
    }
    if !stream_state.stdout.is_empty() {
        return stream_state.stdout.clone();
    }
    raw_stdout.to_owned()
}

fn extract_thread_id(line: &str) -> Option<String> {
    let value = serde_json::from_str::<JsonValue>(line).ok()?;
    if value.get("type").and_then(JsonValue::as_str) != Some("thread.started") {
        return None;
    }
    value.get("thread_id").and_then(JsonValue::as_str).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::{CodexStreamState, handle_codex_stream, normalize_codex_stdout};
    use rigg_core::conversation::ConversationProvider;
    use rigg_core::progress::{ProviderEvent, StepProgressSink};
    use rigg_core::{CapturedValue, StreamKind};
    use rigg_engine::{EngineError, ExecutorError};

    #[test]
    fn buffers_json_records_across_chunks() {
        let mut state = CodexStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"agent_message_delta","delta":{"text":"Scan"#,
        );
        handle_codex_stream(&mut progress, &mut state, StreamKind::Stdout, "ning files...\"}}\n");
        finish_codex_progress(&mut state, &mut progress);

        assert_eq!(
            progress.events,
            vec![ProviderEvent::Status {
                provider: ConversationProvider::Codex,
                message: "Scanning files...".to_owned()
            }]
        );
    }

    #[test]
    fn emits_error_events_to_progress() {
        let mut state = CodexStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"error","message":"Authentication failed"}"#,
        );
        finish_codex_progress(&mut state, &mut progress);

        assert_eq!(
            progress.events,
            vec![ProviderEvent::Error {
                provider: ConversationProvider::Codex,
                message: "Authentication failed".to_owned()
            }]
        );
    }

    #[test]
    fn prefers_completed_over_partial_deltas() {
        let mut state = CodexStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"agent_message_delta","delta":{"text":"Sca"}}"#,
        );
        handle_codex_stream(&mut progress, &mut state, StreamKind::Stdout, "\n");
        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Scanning files..."}}"#,
        );
        finish_codex_progress(&mut state, &mut progress);

        assert_eq!(state.stdout, "Scanning files...");
        assert!(state.pending_message.is_empty());
    }

    #[test]
    fn captures_review_output_as_structured_result() {
        let mut state = CodexStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"exited_review_mode","review_output":{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"looks good","overall_confidence_score":0.91}}"#,
        );
        finish_codex_progress(&mut state, &mut progress);

        assert_eq!(
            state.capture_review_result().unwrap(),
            Some(CapturedValue::Json(serde_json::json!({
                "findings": [],
                "overall_correctness": "patch is correct",
                "overall_explanation": "looks good",
                "overall_confidence_score": 0.91
            })))
        );
    }

    #[test]
    fn review_stdout_prefers_review_output_json() {
        let state = CodexStreamState {
            review_output_text: Some(
                r#"{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"looks good","overall_confidence_score":0.91}"#
                    .to_owned(),
            ),
            ..CodexStreamState::default()
        };

        assert_eq!(
            normalize_codex_stdout(true, "raw", None, None, &state),
            r#"{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"looks good","overall_confidence_score":0.91}"#
        );
    }

    #[test]
    fn review_result_can_fail_json_parsing_from_raw_text() {
        let state = CodexStreamState {
            review_output: None,
            review_output_text: Some("{".to_owned()),
            ..CodexStreamState::default()
        };

        assert!(matches!(
            state.capture_review_result(),
            Err(EngineError::Executor(ExecutorError::ParseJsonOutput { tool: "codex", .. }))
        ));
    }

    #[test]
    fn skips_duplicate_completed_after_deltas() {
        let mut state = CodexStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"agent_message_delta","delta":{"text":"Scanning "}}"#,
        );
        handle_codex_stream(&mut progress, &mut state, StreamKind::Stdout, "\n");
        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"agent_message_delta","delta":{"text":"files..."}}"#,
        );
        handle_codex_stream(&mut progress, &mut state, StreamKind::Stdout, "\n");
        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Scanning files..."}}"#,
        );
        finish_codex_progress(&mut state, &mut progress);

        assert_eq!(
            progress.events,
            vec![
                ProviderEvent::Status {
                    provider: ConversationProvider::Codex,
                    message: "Scanning ".to_owned()
                },
                ProviderEvent::Status {
                    provider: ConversationProvider::Codex,
                    message: "files...".to_owned()
                },
            ]
        );
        assert_eq!(state.stdout, "Scanning files...");
        assert!(state.pending_message.is_empty());
    }

    #[test]
    fn provider_messages_across_deltas() {
        let mut state = CodexStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"agent_message_delta","delta":{"text":"abc"}}"#,
        );
        handle_codex_stream(&mut progress, &mut state, StreamKind::Stdout, "\n");
        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"agent_message_delta","delta":{"text":"def"}}"#,
        );
        finish_codex_progress(&mut state, &mut progress);

        assert_eq!(
            progress.events,
            vec![
                ProviderEvent::Status {
                    provider: ConversationProvider::Codex,
                    message: "abc".to_owned()
                },
                ProviderEvent::Status {
                    provider: ConversationProvider::Codex,
                    message: "def".to_owned()
                }
            ]
        );
    }

    #[test]
    fn completed_message_keeps_prefix() {
        let mut state = CodexStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"agent_message_delta","delta":{"text":"abc"}}"#,
        );
        handle_codex_stream(&mut progress, &mut state, StreamKind::Stdout, "\n");
        handle_codex_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"abcdef"}}"#,
        );
        finish_codex_progress(&mut state, &mut progress);

        assert_eq!(
            progress.events,
            vec![
                ProviderEvent::Status {
                    provider: ConversationProvider::Codex,
                    message: "abc".to_owned()
                },
                ProviderEvent::Status {
                    provider: ConversationProvider::Codex,
                    message: "def".to_owned()
                }
            ]
        );
        assert_eq!(state.stdout, "abcdef");
        assert!(state.pending_message.is_empty());
    }

    #[test]
    fn preserves_raw_structured_stdout() -> Result<(), Box<dyn std::error::Error>> {
        let result_text = "{ \"markdown\" : \"ok\" }\n";
        let structured_result = CapturedValue::Json(serde_json::from_str(result_text.trim())?);

        assert_eq!(
            normalize_codex_stdout(
                true,
                "",
                Some(result_text),
                Some(&structured_result),
                &CodexStreamState::default(),
            ),
            result_text
        );
        Ok(())
    }

    fn finish_codex_progress(state: &mut CodexStreamState, progress: &mut impl StepProgressSink) {
        use crate::runner::events::ProgressEmitter;

        let mut emitter = ProgressEmitter::new(progress);
        emitter.emit_provider_events(state.finish_stdout());
    }

    #[derive(Debug, Default)]
    struct RecordingProgressSink {
        events: Vec<ProviderEvent>,
    }

    impl StepProgressSink for RecordingProgressSink {
        fn is_enabled(&self) -> bool {
            true
        }

        fn provider_event(&mut self, event: ProviderEvent) {
            self.events.push(event);
        }
    }
}
