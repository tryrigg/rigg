use super::super::json::extract_top_level_json_field;
use super::super::lines::preview;
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, PartialEq)]
pub(super) enum ClaudeStreamEvent {
    ToolUseStarted { tool: String },
    ToolInputDelta { partial_json: String },
    ToolUseCompleted,
    Message(String),
    StructuredOutput { value: JsonValue, raw_text: String },
    FinalMessage(String),
    Status(String),
    Ignore,
}

impl ClaudeStreamEvent {
    pub(super) fn from_line(line: &str) -> Self {
        let Ok(value) = serde_json::from_str::<JsonValue>(line) else {
            return Self::Ignore;
        };

        if let Some(structured_output) = value.get("structured_output") {
            return Self::StructuredOutput {
                value: structured_output.clone(),
                raw_text: extract_top_level_json_field(line, "structured_output")
                    .map(str::to_owned)
                    .unwrap_or_else(|| structured_output.to_string()),
            };
        }
        if let Some(event) = parse_tool_event(&value) {
            return event;
        }
        if let Some(message) = parse_final_message(&value) {
            return Self::FinalMessage(message);
        }
        if let Some(status) = parse_status(&value) {
            return Self::Status(status);
        }
        if let Some(message) = parse_message(&value) {
            return Self::Message(message);
        }
        Self::Ignore
    }
}

fn parse_tool_event(value: &JsonValue) -> Option<ClaudeStreamEvent> {
    let event = event_payload(value);
    let event_type = event.get("type").and_then(JsonValue::as_str).unwrap_or_default();
    if let Some(tool_use) = event.get("tool_use") {
        let tool = tool_use
            .get("name")
            .and_then(JsonValue::as_str)
            .or_else(|| event.get("name").and_then(JsonValue::as_str))?;
        return Some(ClaudeStreamEvent::ToolUseStarted { tool: tool.to_owned() });
    }

    if event_type == "content_block_start"
        && let Some(block) = event.get("content_block")
        && block.get("type").and_then(JsonValue::as_str) == Some("tool_use")
    {
        let tool = block.get("name").and_then(JsonValue::as_str)?;
        return Some(ClaudeStreamEvent::ToolUseStarted { tool: tool.to_owned() });
    }

    if event_type == "content_block_delta"
        && let Some(delta) = event.get("delta")
        && delta.get("type").and_then(JsonValue::as_str) == Some("input_json_delta")
    {
        return Some(ClaudeStreamEvent::ToolInputDelta {
            partial_json: delta
                .get("partial_json")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_owned(),
        });
    }

    if event_type == "content_block_stop" {
        return Some(ClaudeStreamEvent::ToolUseCompleted);
    }

    None
}

fn parse_message(value: &JsonValue) -> Option<String> {
    let event = event_payload(value);
    let event_type = event.get("type").and_then(JsonValue::as_str).unwrap_or_default();
    match event_type {
        "content_block_delta" => {
            let delta = event.get("delta")?;
            match delta.get("type").and_then(JsonValue::as_str).unwrap_or_default() {
                "thinking_delta" => None,
                "text_delta" => extract_text(delta),
                _ => None,
            }
        }
        _ => None,
    }
}

fn parse_final_message(value: &JsonValue) -> Option<String> {
    if value.get("type").and_then(JsonValue::as_str) == Some("result") {
        return value.get("result").and_then(extract_text).or_else(|| extract_text(value));
    }

    let event = event_payload(value);
    match event.get("type").and_then(JsonValue::as_str).unwrap_or_default() {
        "message" | "assistant" => extract_message_text(event),
        _ => None,
    }
}

fn parse_status(value: &JsonValue) -> Option<String> {
    let event_type = value.get("type").and_then(JsonValue::as_str).unwrap_or_default();
    match event_type {
        "system" => value
            .get("subtype")
            .and_then(JsonValue::as_str)
            .map(|subtype| format!("system {subtype}")),
        "assistant" => assistant_summary(value),
        "user" => None,
        "stream_event" => None,
        "result" => result_summary(value),
        _ => None,
    }
}

fn assistant_summary(value: &JsonValue) -> Option<String> {
    let content = value.get("message")?.get("content")?.as_array()?;
    content
        .iter()
        .find(|item| item.get("type").and_then(JsonValue::as_str) == Some("thinking"))
        .and_then(extract_text)
        .map(|text| format!("thinking {}", preview(&text)))
}

fn result_summary(value: &JsonValue) -> Option<String> {
    let duration_ms = value.get("duration_ms").and_then(JsonValue::as_u64);
    let input_tokens =
        value.get("usage").and_then(|usage| usage.get("input_tokens")).and_then(JsonValue::as_u64);
    let output_tokens =
        value.get("usage").and_then(|usage| usage.get("output_tokens")).and_then(JsonValue::as_u64);
    let cost = value.get("total_cost_usd").and_then(JsonValue::as_f64);

    let mut parts = Vec::new();
    if let Some(duration_ms) = duration_ms {
        parts.push(format!("duration_ms={duration_ms}"));
    }
    if let Some(input_tokens) = input_tokens {
        parts.push(format!("input_tokens={input_tokens}"));
    }
    if let Some(output_tokens) = output_tokens {
        parts.push(format!("output_tokens={output_tokens}"));
    }
    if let Some(cost) = cost {
        parts.push(format!("cost_usd={cost:.5}"));
    }
    if parts.is_empty() { None } else { Some(format!("result {}", parts.join(" "))) }
}

fn extract_message_text(value: &JsonValue) -> Option<String> {
    let message = value.get("message").unwrap_or(value);
    if let Some(content) = message.get("content").and_then(JsonValue::as_array) {
        let parts = content
            .iter()
            .filter(|item| item.get("type").and_then(JsonValue::as_str) == Some("text"))
            .filter_map(|item| item.get("text").and_then(JsonValue::as_str))
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>();
        if !parts.is_empty() {
            return Some(parts.join(""));
        }
    }

    extract_text(message)
}

fn extract_text(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(text) if !text.trim().is_empty() => Some(text.to_owned()),
        JsonValue::Array(items) => {
            let parts = items.iter().filter_map(extract_text).collect::<Vec<_>>();
            if parts.is_empty() { None } else { Some(parts.join(" ")) }
        }
        JsonValue::Object(map) => {
            if map.get("type").and_then(JsonValue::as_str) == Some("tool_use") {
                return None;
            }
            ["text", "thinking", "content", "message", "delta", "result"]
                .iter()
                .find_map(|key| map.get(*key).and_then(extract_text))
        }
        _ => None,
    }
}

fn event_payload(value: &JsonValue) -> &JsonValue {
    value.get("event").unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::ClaudeStreamEvent;

    fn check(json: &str, expected: ClaudeStreamEvent) {
        assert_eq!(ClaudeStreamEvent::from_line(json), expected);
    }

    #[test]
    fn parses_tool_events() {
        check(
            r#"{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}"#,
            ClaudeStreamEvent::ToolUseStarted { tool: "Bash".to_owned() },
        );
    }

    #[test]
    fn parses_message_events() {
        check(
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}"#,
            ClaudeStreamEvent::Message("Hello".to_owned()),
        );
    }

    #[test]
    fn parses_assistant_snapshot_as_final() {
        check(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#,
            ClaudeStreamEvent::FinalMessage("Hello".to_owned()),
        );
    }

    #[test]
    fn parses_status_events() {
        check(
            r#"{"type":"result","duration_ms":1200,"usage":{"input_tokens":12,"output_tokens":34},"total_cost_usd":0.01234}"#,
            ClaudeStreamEvent::Status(
                "result duration_ms=1200 input_tokens=12 output_tokens=34 cost_usd=0.01234"
                    .to_owned(),
            ),
        );
    }
}
