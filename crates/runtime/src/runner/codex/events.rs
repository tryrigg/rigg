use super::super::lines::preview;
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum CodexStreamEvent {
    ToolUse { tool: String, detail: Option<String> },
    MessageDelta(String),
    Message(String),
    Error(String),
    Status(String),
    Ignore,
}

impl CodexStreamEvent {
    pub(super) fn from_line(line: &str) -> Self {
        let Ok(value) = serde_json::from_str::<JsonValue>(line) else {
            return Self::Ignore;
        };

        if let Some(status) = parse_status(&value) {
            return Self::Status(status);
        }
        if let Some(error) = parse_error(&value) {
            return Self::Error(error);
        }
        if let Some((tool, detail)) = parse_tool_use(&value) {
            return Self::ToolUse { tool, detail };
        }
        if let Some(message) = parse_message_delta(&value) {
            return Self::MessageDelta(message);
        }
        if let Some(message) = parse_message(&value) {
            return Self::Message(message);
        }
        Self::Ignore
    }
}

fn parse_tool_use(value: &JsonValue) -> Option<(String, Option<String>)> {
    let event_type = value.get("type").and_then(JsonValue::as_str).unwrap_or_default();
    if let Some(item) = value.get("item") {
        if let Some(tool) = item.get("name").and_then(JsonValue::as_str) {
            return Some((tool.to_owned(), codex_detail(item)));
        }
        if let Some(item_type) = item.get("type").and_then(JsonValue::as_str)
            && let Some(tool) = normalize_codex_tool_name(item_type)
        {
            return Some((tool, codex_detail(item)));
        }
    }

    if let Some(tool) = value
        .get("tool")
        .and_then(JsonValue::as_str)
        .or_else(|| value.get("tool_name").and_then(JsonValue::as_str))
    {
        return Some((tool.to_owned(), codex_detail(value)));
    }

    normalize_codex_tool_name(event_type)
        .map(|tool| (tool, codex_detail(value.get("payload").unwrap_or(value))))
}

fn parse_message_delta(value: &JsonValue) -> Option<String> {
    let event_type = value.get("type").and_then(JsonValue::as_str).unwrap_or_default();
    if event_type != "agent_message_delta" {
        return None;
    }

    extract_text(value.get("delta").unwrap_or(value))
}

fn parse_message(value: &JsonValue) -> Option<String> {
    let event_type = value.get("type").and_then(JsonValue::as_str).unwrap_or_default();
    if event_type == "item.completed"
        && value.get("item").and_then(|item| item.get("type")).and_then(JsonValue::as_str)
            == Some("agent_message")
    {
        return value
            .get("item")
            .and_then(|item| item.get("text"))
            .and_then(JsonValue::as_str)
            .map(extract_embedded_message);
    }
    if !event_type.contains("message")
        && !event_type.contains("turn")
        && !event_type.contains("reasoning")
    {
        return None;
    }

    extract_text(value.get("message").unwrap_or(value))
        .or_else(|| extract_text(value.get("content").unwrap_or(value)))
}

fn parse_error(value: &JsonValue) -> Option<String> {
    let event_type = value.get("type").and_then(JsonValue::as_str).unwrap_or_default();
    if event_type == "error" {
        return value
            .get("message")
            .and_then(extract_text)
            .or_else(|| value.get("error").and_then(extract_text))
            .or_else(|| extract_text(value));
    }

    if event_type == "item.completed"
        && value.get("item").and_then(|item| item.get("type")).and_then(JsonValue::as_str)
            == Some("error")
    {
        return value.get("item").and_then(|item| {
            item.get("message").and_then(extract_text).or_else(|| extract_text(item))
        });
    }

    None
}

fn parse_status(value: &JsonValue) -> Option<String> {
    let event_type = value.get("type").and_then(JsonValue::as_str).unwrap_or_default();
    match event_type {
        "thread.started" => value
            .get("thread_id")
            .and_then(JsonValue::as_str)
            .map(|thread_id| format!("thread started {thread_id}")),
        "turn.started" => Some("turn started".to_owned()),
        "turn.completed" => {
            usage_summary(value.get("usage")).map(|usage| format!("turn completed {usage}"))
        }
        _ => None,
    }
}

fn usage_summary(value: Option<&JsonValue>) -> Option<String> {
    let usage = value?;
    let input_tokens = usage.get("input_tokens").and_then(JsonValue::as_u64);
    let output_tokens = usage.get("output_tokens").and_then(JsonValue::as_u64);
    match (input_tokens, output_tokens) {
        (Some(input_tokens), Some(output_tokens)) => {
            Some(format!("input_tokens={input_tokens} output_tokens={output_tokens}"))
        }
        (Some(input_tokens), None) => Some(format!("input_tokens={input_tokens}")),
        (None, Some(output_tokens)) => Some(format!("output_tokens={output_tokens}")),
        (None, None) => None,
    }
}

fn normalize_codex_tool_name(event_type: &str) -> Option<String> {
    match event_type {
        value if value.contains("web_search") => Some("web_search".to_owned()),
        value if value.contains("exec_command") || value.contains("shell") => {
            Some("bash".to_owned())
        }
        value if value.contains("read") => Some("read".to_owned()),
        value
            if value.contains("write")
                || value.contains("edit")
                || value.contains("apply_patch") =>
        {
            Some("edit".to_owned())
        }
        value if value.ends_with("_call") => Some(value.trim_end_matches("_call").to_owned()),
        _ => None,
    }
}

fn codex_detail(value: &JsonValue) -> Option<String> {
    first_string(value, &["summary", "title", "command", "query", "path", "url"])
        .as_deref()
        .map(preview)
}

fn first_string(value: &JsonValue, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(found) = value.get(*key).and_then(JsonValue::as_str)
            && !found.trim().is_empty()
        {
            return Some(found.to_owned());
        }
    }

    match value {
        JsonValue::Array(items) => items.iter().find_map(|item| first_string(item, keys)),
        JsonValue::Object(map) => map.values().find_map(|item| first_string(item, keys)),
        _ => None,
    }
}

fn extract_text(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(text) if !text.trim().is_empty() => Some(text.to_owned()),
        JsonValue::Array(items) => {
            let parts = items.iter().filter_map(extract_text).collect::<Vec<_>>();
            if parts.is_empty() { None } else { Some(parts.join(" ")) }
        }
        JsonValue::Object(map) => ["text", "content", "message", "summary"]
            .iter()
            .find_map(|key| map.get(*key).and_then(extract_text)),
        _ => None,
    }
}

fn extract_embedded_message(text: &str) -> String {
    serde_json::from_str::<JsonValue>(text)
        .ok()
        .and_then(|value| first_string(&value, &["markdown", "text", "message"]))
        .unwrap_or_else(|| text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::CodexStreamEvent;

    fn check(json: &str, expected: CodexStreamEvent) {
        assert_eq!(CodexStreamEvent::from_line(json), expected);
    }

    #[test]
    fn parses_tool_event_from_item() {
        check(
            r#"{"type":"item.completed","item":{"type":"web_search_call","query":"rust channels"}}"#,
            CodexStreamEvent::ToolUse {
                tool: "web_search".to_owned(),
                detail: Some("rust channels".to_owned()),
            },
        );
    }

    #[test]
    fn parses_message_event() {
        check(
            r#"{"type":"agent_message_delta","delta":{"text":"Inspecting the repository now."}}"#,
            CodexStreamEvent::MessageDelta("Inspecting the repository now.".to_owned()),
        );
    }

    #[test]
    fn parses_top_level_error_event() {
        check(
            r#"{"type":"error","message":"Authentication failed"}"#,
            CodexStreamEvent::Error("Authentication failed".to_owned()),
        );
    }

    #[test]
    fn parses_item_completed_error_event() {
        check(
            r#"{"type":"item.completed","item":{"type":"error","message":"Network retry exhausted"}}"#,
            CodexStreamEvent::Error("Network retry exhausted".to_owned()),
        );
    }

    #[test]
    fn parses_turn_completed_status() {
        check(
            r#"{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":34}}"#,
            CodexStreamEvent::Status("turn completed input_tokens=12 output_tokens=34".to_owned()),
        );
    }

    #[test]
    fn parses_thread_started_as_status() {
        check(
            r#"{"type":"thread.started","thread_id":"thread_123"}"#,
            CodexStreamEvent::Status("thread started thread_123".to_owned()),
        );
    }

    #[test]
    fn parses_agent_message_item() {
        check(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Refined the plan."}}"#,
            CodexStreamEvent::Message("Refined the plan.".to_owned()),
        );
    }

    #[test]
    fn parses_agent_message_embedded_json() {
        check(
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"markdown\\\":\\\"# Refined Plan\\\\n\\\\nDetails\\\"}\"}}",
            CodexStreamEvent::Message("# Refined Plan\n\nDetails".to_owned()),
        );
    }
}
