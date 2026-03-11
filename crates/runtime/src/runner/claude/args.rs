use rigg_core::Persistence;
use rigg_engine::RenderedClaudeRequest;
use std::ffi::OsString;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ClaudeResultKind {
    Text,
    Structured,
}

impl ClaudeResultKind {
    pub(super) fn for_request(request: &RenderedClaudeRequest) -> Self {
        if request.result_schema.is_some() { Self::Structured } else { Self::Text }
    }
}

pub(super) struct PreparedClaudeCommand {
    pub(super) args: Vec<OsString>,
    pub(super) result_kind: ClaudeResultKind,
}

impl PreparedClaudeCommand {
    pub(super) fn from_request(request: &RenderedClaudeRequest) -> Self {
        let result_kind = ClaudeResultKind::for_request(request);
        let args = build_claude_args(request);
        Self { args, result_kind }
    }
}

pub(super) fn build_claude_args(request: &RenderedClaudeRequest) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-p"),
        OsString::from("--permission-mode"),
        OsString::from(request.permission_mode.as_str()),
        OsString::from("--output-format"),
        OsString::from("stream-json"),
        OsString::from("--verbose"),
        OsString::from("--include-partial-messages"),
    ];
    if let Some(model) = &request.model {
        args.push(OsString::from("--model"));
        args.push(OsString::from(model));
    }
    for add_dir in &request.add_dirs {
        args.push(OsString::from("--add-dir"));
        args.push(OsString::from(add_dir));
    }
    if matches!(request.persistence, Persistence::Ephemeral) {
        args.push(OsString::from("--no-session-persistence"));
    }
    if let Some(session_id) = request
        .conversation
        .as_ref()
        .and_then(|conversation| conversation.resume_session_id.as_ref())
    {
        args.push(OsString::from("--resume"));
        args.push(OsString::from(session_id));
    }
    if let Some(schema) = &request.result_schema {
        args.push(OsString::from("--json-schema"));
        args.push(OsString::from(schema.to_string()));
    }
    args.push(OsString::from(&request.prompt));
    args
}

#[cfg(test)]
mod tests {
    use super::{PreparedClaudeCommand, build_claude_args};
    use rigg_core::{PermissionMode, Persistence};
    use rigg_engine::{RenderedClaudeConversation, RenderedClaudeRequest};
    use std::collections::BTreeMap;
    use std::ffi::OsString;

    #[test]
    fn builds_streaming_args_with_add_dirs_non_persistent() -> Result<(), Box<dyn std::error::Error>>
    {
        let args = stringify(&build_claude_args(&RenderedClaudeRequest {
            cwd: std::env::temp_dir(),
            env: BTreeMap::new(),
            prompt: "summarize".to_owned(),
            model: Some("sonnet".to_owned()),
            permission_mode: PermissionMode::Plan,
            add_dirs: vec!["docs".to_owned(), "notes".to_owned()],
            persistence: Persistence::Ephemeral,
            conversation: None,
            result_schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "markdown": { "type": "string" }
                },
                "required": ["markdown"]
            })),
        }));

        assert_eq!(
            &args[..15],
            vec![
                "-p",
                "--permission-mode",
                "plan",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--model",
                "sonnet",
                "--add-dir",
                "docs",
                "--add-dir",
                "notes",
                "--no-session-persistence",
                "--json-schema",
            ]
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&args[15])?,
            serde_json::json!({
                "type": "object",
                "properties": {
                    "markdown": { "type": "string" }
                },
                "required": ["markdown"]
            })
        );
        assert_eq!(args[16], "summarize");
        Ok(())
    }

    #[test]
    fn always_builds_streaming_resume_args() {
        let args = build_claude_args(&RenderedClaudeRequest {
            cwd: std::env::temp_dir(),
            env: BTreeMap::new(),
            prompt: "continue".to_owned(),
            model: None,
            permission_mode: PermissionMode::Default,
            add_dirs: vec![],
            persistence: Persistence::Persist,
            conversation: Some(RenderedClaudeConversation {
                resume_session_id: Some("session-123".to_owned()),
            }),
            result_schema: None,
        });

        assert_eq!(
            stringify(&args),
            vec![
                "-p",
                "--permission-mode",
                "default",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--resume",
                "session-123",
                "continue",
            ]
        );
    }

    #[test]
    fn prepared_command_always_uses_streaming_args() {
        let prepared = PreparedClaudeCommand::from_request(&RenderedClaudeRequest {
            cwd: std::env::temp_dir(),
            env: BTreeMap::new(),
            prompt: "continue".to_owned(),
            model: None,
            permission_mode: PermissionMode::Default,
            add_dirs: vec![],
            persistence: Persistence::Persist,
            conversation: None,
            result_schema: None,
        });

        let args = stringify(&prepared.args);
        assert!(args.iter().any(|arg| arg == "stream-json"));
        assert!(args.iter().any(|arg| arg == "--verbose"));
        assert!(args.iter().any(|arg| arg == "--include-partial-messages"));
    }

    fn stringify(args: &[OsString]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect()
    }
}
