use super::args::ClaudeResultKind;
use super::events::ClaudeStreamEvent;
use crate::runner::events::{ProgressEmitter, ProviderEvent};
use crate::runner::lines::{LineBuffer, preview};
use rigg_core::conversation::ConversationProvider;
use rigg_core::progress::StepProgressSink;
use rigg_core::{CapturedValue, StreamKind};
use serde_json::Value as JsonValue;

#[derive(Debug, Default)]
pub(super) struct ClaudeStreamState {
    text: String,
    structured_output: Option<JsonValue>,
    structured_output_text: Option<String>,
    final_message: Option<String>,
    session_id: Option<String>,
    active_tool: Option<ActiveClaudeTool>,
    stdout_lines: LineBuffer,
    provider_events: Vec<ProviderEvent>,
}

impl ClaudeStreamState {
    fn observe(&mut self, event: &ClaudeStreamEvent) {
        match event {
            ClaudeStreamEvent::ToolUseStarted { tool } => {
                self.active_tool =
                    Some(ActiveClaudeTool { tool: tool.clone(), input_json: String::new() });
            }
            ClaudeStreamEvent::ToolInputDelta { partial_json } => {
                if let Some(active_tool) = &mut self.active_tool {
                    active_tool.input_json.push_str(partial_json);
                }
            }
            ClaudeStreamEvent::ToolUseCompleted
            | ClaudeStreamEvent::Status(_)
            | ClaudeStreamEvent::Ignore => {}
            ClaudeStreamEvent::Message(message) => {
                self.text.push_str(message);
            }
            ClaudeStreamEvent::StructuredOutput { value, raw_text } => {
                self.structured_output = Some(value.clone());
                self.structured_output_text = Some(raw_text.clone());
            }
            ClaudeStreamEvent::FinalMessage(message) => {
                self.final_message = Some(message.clone());
            }
        }
    }

    fn complete_tool(&mut self) -> Option<ProviderEvent> {
        let tool = self.active_tool.take()?;
        Some(ProviderEvent::ToolUse {
            provider: ConversationProvider::Claude,
            tool: tool.tool,
            detail: summarize_json_input(&tool.input_json),
        })
    }

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
        if let Some(event) = self.complete_tool() {
            self.emit_provider_event(&mut events, event, true);
        }
        if self.text.is_empty()
            && let Some(message) = self.final_message.as_deref()
        {
            self.emit_provider_event(&mut events, provider_message_event(preview(message)), false);
        }
        events
    }

    fn handle_stdout_line(&mut self, line: &str, events: &mut Vec<ProviderEvent>) {
        if let Some(session_id) = extract_session_id(line) {
            self.session_id = Some(session_id);
        }
        let event = ClaudeStreamEvent::from_line(line);
        match &event {
            ClaudeStreamEvent::ToolUseStarted { .. } => {}
            ClaudeStreamEvent::ToolUseCompleted => {
                if let Some(event) = self.complete_tool() {
                    self.emit_provider_event(events, event, true);
                }
            }
            ClaudeStreamEvent::Message(message) => {
                self.emit_provider_event(events, provider_message_event(preview(message)), false);
            }
            ClaudeStreamEvent::Status(message) => {
                self.emit_provider_event(events, provider_message_event(preview(message)), true);
            }
            ClaudeStreamEvent::FinalMessage(_) => {}
            ClaudeStreamEvent::ToolInputDelta { .. }
            | ClaudeStreamEvent::StructuredOutput { .. }
            | ClaudeStreamEvent::Ignore => {}
        }
        self.observe(&event);
    }

    fn emit_provider_event(
        &mut self,
        events: &mut Vec<ProviderEvent>,
        event: ProviderEvent,
        persist: bool,
    ) {
        if persist {
            self.provider_events.push(event.clone());
        }
        events.push(event);
    }

    pub(super) fn text_result(&self) -> Option<CapturedValue> {
        if !self.text.is_empty() {
            return Some(CapturedValue::Text(self.text.clone()));
        }
        self.final_message.clone().map(CapturedValue::Text)
    }

    #[cfg(test)]
    pub(super) fn into_structured_result(self) -> Option<CapturedValue> {
        self.structured_result()
    }

    pub(super) fn structured_result(&self) -> Option<CapturedValue> {
        self.structured_output_value().map(CapturedValue::Json)
    }

    fn text_stdout(&self) -> Option<String> {
        if !self.text.is_empty() {
            return Some(self.text.clone());
        }
        self.final_message.clone()
    }

    fn structured_output_value(&self) -> Option<JsonValue> {
        self.structured_output.clone().or_else(|| {
            self.final_message
                .as_deref()
                .and_then(|text| serde_json::from_str::<JsonValue>(text).ok())
        })
    }

    fn structured_output_stdout(&self) -> Option<String> {
        self.structured_output_text.clone().or_else(|| self.final_message.clone())
    }

    pub(super) fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub(super) fn take_provider_events(&mut self) -> Vec<ProviderEvent> {
        std::mem::take(&mut self.provider_events)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveClaudeTool {
    tool: String,
    input_json: String,
}

pub(super) fn handle_claude_stream(
    progress: &mut dyn StepProgressSink,
    stream_state: &mut ClaudeStreamState,
    stream: StreamKind,
    chunk: &str,
) {
    let mut progress = ProgressEmitter::new(progress);
    match stream {
        StreamKind::Stderr => progress.step_output(stream, chunk),
        StreamKind::Stdout => progress.emit_provider_events(stream_state.push_stdout(chunk)),
    }
}

pub(super) fn normalize_claude_stdout(
    succeeded: bool,
    result_kind: ClaudeResultKind,
    raw_stdout: &str,
    stream_state: &ClaudeStreamState,
) -> String {
    if !succeeded {
        return raw_stdout.to_owned();
    }
    match result_kind {
        ClaudeResultKind::Text => {
            stream_state.text_stdout().unwrap_or_else(|| raw_stdout.to_owned())
        }
        ClaudeResultKind::Structured => {
            stream_state.structured_output_stdout().unwrap_or_else(|| raw_stdout.to_owned())
        }
    }
}

fn summarize_json_input(input_json: &str) -> Option<String> {
    if input_json.trim().is_empty() {
        return None;
    }

    serde_json::from_str::<JsonValue>(input_json)
        .ok()
        .and_then(|value| summarize_value(&value))
        .or_else(|| Some(preview(input_json)))
}

fn provider_message_event(message: String) -> ProviderEvent {
    ProviderEvent::Status { provider: ConversationProvider::Claude, message }
}

fn extract_session_id(line: &str) -> Option<String> {
    serde_json::from_str::<JsonValue>(line)
        .ok()?
        .get("session_id")
        .and_then(JsonValue::as_str)
        .map(str::to_owned)
}

fn summarize_value(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::Object(map) => {
            let mut parts = Vec::new();
            for key in ["query", "command", "path", "markdown"] {
                if let Some(text) = map.get(key).and_then(JsonValue::as_str) {
                    parts.push(format!("{key}={}", preview(text)));
                }
            }
            if parts.is_empty() { Some(preview(&value.to_string())) } else { Some(parts.join(" ")) }
        }
        _ => Some(preview(&value.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::{ClaudeStreamState, handle_claude_stream, normalize_claude_stdout};
    use crate::runner::claude::args::ClaudeResultKind;
    use crate::runner::events::ProgressEmitter;
    use rigg_core::conversation::ConversationProvider;
    use rigg_core::progress::{NoopProgressSink, ProviderEvent, StepProgressSink};
    use rigg_core::{CapturedValue, StreamKind};

    #[test]
    fn buffers_json_records_across_chunks() {
        let mut state = ClaudeStreamState::default();
        let mut progress = NoopProgressSink;

        handle_claude_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"result","structured_output":{"markdown":"o"#,
        );
        handle_claude_stream(&mut progress, &mut state, StreamKind::Stdout, r#"k"}}"#);
        let _ = state.finish_stdout();

        let result = state.into_structured_result();
        assert_eq!(result, Some(CapturedValue::Json(serde_json::json!({"markdown":"ok"}))));
    }

    #[test]
    fn concatenates_message_deltas_without_inserting_newlines() {
        let mut state = ClaudeStreamState::default();
        let mut progress = RecordingProgressSink::default();
        handle_stdout_line(
            &mut state,
            &mut progress,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}"#,
        );
        handle_stdout_line(
            &mut state,
            &mut progress,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}"#,
        );

        assert_eq!(state.text, "Hello world");
    }

    #[test]
    fn emits_tool_use_once_after_completion() {
        let mut state = ClaudeStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_stdout_line(
            &mut state,
            &mut progress,
            r#"{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}"#,
        );
        handle_stdout_line(
            &mut state,
            &mut progress,
            r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"command\":\"git status\"}"}}"#,
        );
        handle_stdout_line(&mut state, &mut progress, r#"{"type":"content_block_stop"}"#);
        flush_claude_progress(&mut state, &mut progress);

        assert_eq!(
            progress.events,
            vec![ProviderEvent::ToolUse {
                provider: ConversationProvider::Claude,
                tool: "Bash".to_owned(),
                detail: Some("command=git status".to_owned())
            }]
        );
    }

    #[test]
    fn deduplicates_final_messages() {
        let mut state = ClaudeStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_stdout_line(
            &mut state,
            &mut progress,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in"}]}}"#,
        );
        handle_stdout_line(
            &mut state,
            &mut progress,
            r#"{"type":"result","result":"Not logged in"}"#,
        );
        flush_claude_progress(&mut state, &mut progress);

        assert_eq!(
            progress.events,
            vec![ProviderEvent::Status {
                provider: ConversationProvider::Claude,
                message: "Not logged in".to_owned()
            }]
        );
    }

    #[test]
    fn ignores_final_snapshot_when_text_exists() {
        let mut state = ClaudeStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_stdout_line(
            &mut state,
            &mut progress,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}"#,
        );
        handle_stdout_line(
            &mut state,
            &mut progress,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#,
        );
        flush_claude_progress(&mut state, &mut progress);

        assert_eq!(
            progress.events,
            vec![ProviderEvent::Status {
                provider: ConversationProvider::Claude,
                message: "Hello".to_owned()
            }]
        );
    }

    #[test]
    fn provider_messages_across_deltas() {
        let mut state = ClaudeStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_claude_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"abc"}}"#,
        );
        handle_claude_stream(&mut progress, &mut state, StreamKind::Stdout, "\n");
        handle_claude_stream(
            &mut progress,
            &mut state,
            StreamKind::Stdout,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"def"}}"#,
        );
        flush_claude_progress(&mut state, &mut progress);

        assert_eq!(
            progress.events,
            vec![
                ProviderEvent::Status {
                    provider: ConversationProvider::Claude,
                    message: "abc".to_owned()
                },
                ProviderEvent::Status {
                    provider: ConversationProvider::Claude,
                    message: "def".to_owned()
                }
            ]
        );
        assert!(state.take_provider_events().is_empty());
    }

    #[test]
    fn persists_statuses_but_not_text_deltas() {
        let mut state = ClaudeStreamState::default();
        let mut progress = RecordingProgressSink::default();

        handle_stdout_line(&mut state, &mut progress, r#"{"type":"system","subtype":"init"}"#);
        handle_stdout_line(
            &mut state,
            &mut progress,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"final answer"}}"#,
        );
        flush_claude_progress(&mut state, &mut progress);

        assert_eq!(
            state.take_provider_events(),
            vec![super::provider_message_event("system init".to_owned())]
        );
    }

    #[test]
    fn uses_text_as_stdout() {
        let state = ClaudeStreamState { text: "hello".to_owned(), ..ClaudeStreamState::default() };
        assert_eq!(normalize_claude_stdout(true, ClaudeResultKind::Text, "raw", &state,), "hello");
    }

    #[test]
    fn uses_structured_output_as_stdout() {
        let state = ClaudeStreamState {
            structured_output_text: Some(r#"{"markdown":"ok"}"#.to_owned()),
            ..ClaudeStreamState::default()
        };
        assert_eq!(
            normalize_claude_stdout(true, ClaudeResultKind::Structured, "raw", &state,),
            r#"{"markdown":"ok"}"#
        );
    }

    #[test]
    fn preserves_structured_stdout() {
        let state = ClaudeStreamState {
            structured_output_text: Some(
                r#"{ "markdown" : "ok", "flag" : true, "secret" : "true" }"#.to_owned(),
            ),
            ..ClaudeStreamState::default()
        };
        let stdout = normalize_claude_stdout(true, ClaudeResultKind::Structured, "raw", &state);
        assert_eq!(stdout, r#"{ "markdown" : "ok", "flag" : true, "secret" : "true" }"#);
    }

    #[test]
    fn preserves_raw_multiline_final_message() {
        let state = ClaudeStreamState {
            final_message: Some("line 1\nline 2".to_owned()),
            ..ClaudeStreamState::default()
        };
        assert_eq!(
            normalize_claude_stdout(true, ClaudeResultKind::Text, "raw", &state,),
            "line 1\nline 2"
        );
    }

    #[test]
    fn prefers_structured_over_partial() {
        let state = ClaudeStreamState {
            text: "partial".to_owned(),
            structured_output_text: Some(r#"{"markdown":"ok"}"#.to_owned()),
            ..ClaudeStreamState::default()
        };
        assert_eq!(
            normalize_claude_stdout(true, ClaudeResultKind::Structured, "raw", &state,),
            r#"{"markdown":"ok"}"#
        );
    }

    #[test]
    fn preserves_raw_stdout_on_failure() {
        let state = ClaudeStreamState {
            text: "partial".to_owned(),
            final_message: Some("final".to_owned()),
            ..ClaudeStreamState::default()
        };
        assert_eq!(
            normalize_claude_stdout(false, ClaudeResultKind::Text, "raw failure", &state,),
            "raw failure"
        );
    }

    #[test]
    fn parses_json_results() {
        let state = ClaudeStreamState {
            structured_output: Some(serde_json::json!({"markdown":"ok"})),
            ..ClaudeStreamState::default()
        };
        assert_eq!(
            state.into_structured_result(),
            Some(CapturedValue::Json(serde_json::json!({"markdown":"ok"})))
        );
    }

    fn handle_stdout_line(
        state: &mut ClaudeStreamState,
        progress: &mut impl StepProgressSink,
        line: &str,
    ) {
        let mut events = Vec::new();
        state.handle_stdout_line(line, &mut events);
        let mut emitter = ProgressEmitter::new(progress);
        emitter.emit_provider_events(events);
    }

    fn flush_claude_progress(state: &mut ClaudeStreamState, progress: &mut impl StepProgressSink) {
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
