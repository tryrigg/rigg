use super::expr::{compile_template, compile_template_list};
use super::{ConfigError, ExprRules, FieldSite};
use rigg_core::{
    ActionKind, ActionNode, ClaudeStep, CodexAction, CodexExec, CodexMode, CodexReview, CodexStep,
    ConversationBinding, ConversationName, ConversationScope, JsonResultSchema, OutputSchema,
    PermissionMode, Persistence, ResultContract, ReviewScope, ShellOutput, ShellStep,
    WriteFileStep,
};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::str::FromStr;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCodexWith {
    action: RawCodexAction,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    mode: Option<RawCodexMode>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    target: Option<RawReviewTarget>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    commit: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    add_dirs: Vec<String>,
    #[serde(default)]
    persist: Option<bool>,
    #[serde(default)]
    conversation: Option<RawConversation>,
    #[serde(default)]
    output_schema: Option<JsonValue>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawClaudeWith {
    #[serde(rename = "action")]
    _action: RawClaudeAction,
    prompt: String,
    #[serde(default)]
    permission_mode: Option<RawPermissionMode>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    add_dirs: Vec<String>,
    #[serde(default)]
    persist: Option<bool>,
    #[serde(default)]
    conversation: Option<RawConversation>,
    #[serde(default)]
    output_schema: Option<JsonValue>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawShellWith {
    command: String,
    #[serde(default)]
    result: Option<RawShellOutput>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWriteFileWith {
    path: String,
    content: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawCodexAction {
    Review,
    Exec,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawCodexMode {
    Default,
    FullAuto,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawReviewTarget {
    Uncommitted,
    Base,
    Commit,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawClaudeAction {
    Prompt,
}

#[derive(Debug, Clone, Copy, Deserialize)]
enum RawPermissionMode {
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "acceptEdits")]
    AcceptEdits,
    #[serde(rename = "dontAsk")]
    DontAsk,
    #[serde(rename = "bypassPermissions")]
    BypassPermissions,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawShellOutput {
    None,
    Text,
    Json,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConversation {
    name: String,
    #[serde(default)]
    scope: Option<RawConversationScope>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawConversationScope {
    Iteration,
    Loop,
    Workflow,
}

impl From<RawCodexMode> for CodexMode {
    fn from(value: RawCodexMode) -> Self {
        match value {
            RawCodexMode::Default => Self::Default,
            RawCodexMode::FullAuto => Self::FullAuto,
        }
    }
}

impl From<RawPermissionMode> for PermissionMode {
    fn from(value: RawPermissionMode) -> Self {
        match value {
            RawPermissionMode::Default => Self::Default,
            RawPermissionMode::Plan => Self::Plan,
            RawPermissionMode::AcceptEdits => Self::AcceptEdits,
            RawPermissionMode::DontAsk => Self::DontAsk,
            RawPermissionMode::BypassPermissions => Self::BypassPermissions,
        }
    }
}

impl From<RawConversationScope> for ConversationScope {
    fn from(value: RawConversationScope) -> Self {
        match value {
            RawConversationScope::Iteration => Self::Iteration,
            RawConversationScope::Loop => Self::Loop,
            RawConversationScope::Workflow => Self::Workflow,
        }
    }
}

pub(super) fn compile_action(
    site: FieldSite<'_>,
    step_type: &str,
    with: Option<JsonValue>,
    rules: ExprRules<'_>,
    in_loop_body: bool,
) -> Result<ActionNode, ConfigError> {
    match step_type {
        "codex" => compile_codex(site, with, rules, in_loop_body),
        "claude" => compile_claude(site, with, rules, in_loop_body),
        "shell" => compile_shell(site, with, rules),
        "write_file" => compile_write_file(site, with, rules),
        _ => Err(ConfigError::UnsupportedStepType {
            path: site.path.to_path_buf(),
            location: site.location,
            workflow_id: site.workflow_id.to_string(),
            step_index: site.step_index,
            step_type: step_type.to_owned(),
        }),
    }
}

fn compile_codex(
    site: FieldSite<'_>,
    with: Option<JsonValue>,
    rules: ExprRules<'_>,
    in_loop_body: bool,
) -> Result<ActionNode, ConfigError> {
    let with = with.ok_or_else(|| invalid_with(site, "codex", "missing `with`".to_owned()))?;
    let raw: RawCodexWith = deserialize_with(site, "codex", with)?;
    let persistence = session_persistence(raw.persist);
    let add_dirs = compile_template_list(site, "with.add_dirs", raw.add_dirs, rules)?;
    let conversation = parse_conversation_binding(site, "codex", raw.conversation, in_loop_body)?;
    match raw.action {
        RawCodexAction::Review => {
            if conversation.is_some() {
                return Err(invalid_with(
                    site,
                    "codex",
                    "`review` does not accept `conversation`; use `action: exec`".to_owned(),
                ));
            }
            if raw.output_schema.is_some() {
                return Err(invalid_with(
                    site,
                    "codex",
                    "`review` does not support `with.output_schema`".to_owned(),
                ));
            }
            let scope = match (raw.target.as_ref(), raw.base.as_ref(), raw.commit.as_ref()) {
                (Some(RawReviewTarget::Uncommitted), None, None) => ReviewScope::Uncommitted,
                (Some(RawReviewTarget::Base), Some(base), None) | (None, Some(base), None) => {
                    ReviewScope::Base(compile_template(site, "with.base", base.clone(), rules)?)
                }
                (Some(RawReviewTarget::Commit), None, Some(commit)) => ReviewScope::Commit(
                    compile_template(site, "with.commit", commit.clone(), rules)?,
                ),
                _ => {
                    return Err(invalid_with(
                        site,
                        "codex",
                        "`review` requires exactly one of `target: uncommitted`, `target: base` with `base`, or `target: commit` with `commit`"
                            .to_owned(),
                    ));
                }
            };
            Ok(ActionNode {
                action: ActionKind::Codex(CodexStep {
                    action: CodexAction::Review(CodexReview {
                        prompt: raw
                            .prompt
                            .map(|prompt| compile_template(site, "with.prompt", prompt, rules))
                            .transpose()?,
                        model: raw.model,
                        mode: raw.mode.unwrap_or(RawCodexMode::Default).into(),
                        title: raw
                            .title
                            .map(|title| compile_template(site, "with.title", title, rules))
                            .transpose()?,
                        add_dirs,
                        persistence,
                        scope,
                    }),
                }),
                result_contract: ResultContract::Text,
            })
        }
        RawCodexAction::Exec => {
            if raw.target.is_some()
                || raw.base.is_some()
                || raw.commit.is_some()
                || raw.title.is_some()
            {
                return Err(invalid_with(
                    site,
                    "codex",
                    "`exec` does not accept `target`, `base`, `commit`, or `title`".to_owned(),
                ));
            }
            if matches!(persistence, Persistence::Ephemeral) && conversation.is_some() {
                return Err(invalid_with(
                    site,
                    "codex",
                    "`conversation` requires session persistence; remove `persist: false`"
                        .to_owned(),
                ));
            }
            let output_schema = compile_output_schema(site, "codex", raw.output_schema)?;
            Ok(ActionNode {
                action: ActionKind::Codex(CodexStep {
                    action: CodexAction::Exec(CodexExec {
                        prompt: compile_template(
                            site,
                            "with.prompt",
                            raw.prompt.ok_or_else(|| {
                                invalid_with(site, "codex", "`exec` requires `prompt`".to_owned())
                            })?,
                            rules,
                        )?,
                        model: raw.model,
                        mode: raw.mode.unwrap_or(RawCodexMode::Default).into(),
                        add_dirs,
                        persistence,
                        conversation,
                    }),
                }),
                result_contract: output_schema
                    .map(|schema| ResultContract::Json { schema: Some(schema) })
                    .unwrap_or(ResultContract::Text),
            })
        }
    }
}

fn compile_claude(
    site: FieldSite<'_>,
    with: Option<JsonValue>,
    rules: ExprRules<'_>,
    in_loop_body: bool,
) -> Result<ActionNode, ConfigError> {
    let with = with.ok_or_else(|| invalid_with(site, "claude", "missing `with`".to_owned()))?;
    let raw: RawClaudeWith = deserialize_with(site, "claude", with)?;
    let conversation = parse_conversation_binding(site, "claude", raw.conversation, in_loop_body)?;
    let persistence = session_persistence(raw.persist);
    if matches!(persistence, Persistence::Ephemeral) && conversation.is_some() {
        return Err(invalid_with(
            site,
            "claude",
            "`conversation` requires session persistence; remove `persist: false`".to_owned(),
        ));
    }
    let output_schema = compile_output_schema(site, "claude", raw.output_schema)?;
    Ok(ActionNode {
        action: ActionKind::Claude(ClaudeStep {
            prompt: compile_template(site, "with.prompt", raw.prompt, rules)?,
            model: raw.model,
            permission_mode: raw.permission_mode.unwrap_or(RawPermissionMode::Default).into(),
            add_dirs: compile_template_list(site, "with.add_dirs", raw.add_dirs, rules)?,
            persistence,
            conversation,
        }),
        result_contract: output_schema
            .map(|schema| ResultContract::Json { schema: Some(schema) })
            .unwrap_or(ResultContract::Text),
    })
}

fn compile_shell(
    site: FieldSite<'_>,
    with: Option<JsonValue>,
    rules: ExprRules<'_>,
) -> Result<ActionNode, ConfigError> {
    let with = with.ok_or_else(|| invalid_with(site, "shell", "missing `with`".to_owned()))?;
    let raw: RawShellWith = deserialize_with(site, "shell", with)?;
    let result_mode = match raw.result.unwrap_or(RawShellOutput::Text) {
        RawShellOutput::None => ShellOutput::None,
        RawShellOutput::Text => ShellOutput::Text,
        RawShellOutput::Json => ShellOutput::Json,
    };
    let result_contract = match result_mode {
        ShellOutput::None => ResultContract::None,
        ShellOutput::Text => ResultContract::Text,
        ShellOutput::Json => ResultContract::Json { schema: None },
    };
    Ok(ActionNode {
        action: ActionKind::Shell(ShellStep {
            command: compile_template(site, "with.command", raw.command, rules)?,
            result_mode,
        }),
        result_contract,
    })
}

fn compile_write_file(
    site: FieldSite<'_>,
    with: Option<JsonValue>,
    rules: ExprRules<'_>,
) -> Result<ActionNode, ConfigError> {
    let with = with.ok_or_else(|| invalid_with(site, "write_file", "missing `with`".to_owned()))?;
    let raw: RawWriteFileWith = deserialize_with(site, "write_file", with)?;
    Ok(ActionNode {
        action: ActionKind::WriteFile(WriteFileStep {
            path: compile_template(site, "with.path", raw.path, rules)?,
            content: compile_template(site, "with.content", raw.content, rules)?,
        }),
        result_contract: ResultContract::WriteFile,
    })
}

fn parse_conversation_binding(
    site: FieldSite<'_>,
    step_type: &str,
    conversation: Option<RawConversation>,
    in_loop_body: bool,
) -> Result<Option<ConversationBinding>, ConfigError> {
    let Some(conversation) = conversation else {
        return Ok(None);
    };

    let name = ConversationName::from_str(&conversation.name).map_err(|error| {
        invalid_with(site, step_type, format!("invalid `conversation.name`: {error}"))
    })?;
    let scope = conversation.scope.map(ConversationScope::from).unwrap_or(if in_loop_body {
        ConversationScope::Iteration
    } else {
        ConversationScope::Workflow
    });

    if !in_loop_body && !matches!(scope, ConversationScope::Workflow) {
        return Err(invalid_with(
            site,
            step_type,
            format!("`conversation.scope: {scope}` is only allowed inside a `loop` body"),
        ));
    }

    Ok(Some(ConversationBinding { name, scope }))
}

fn compile_output_schema(
    site: FieldSite<'_>,
    step_type: &str,
    schema: Option<JsonValue>,
) -> Result<Option<JsonResultSchema>, ConfigError> {
    let Some(schema) = schema else {
        return Ok(None);
    };
    let parsed = JsonResultSchema::parse_at(&schema, "with.output_schema")
        .map_err(|error| invalid_with(site, step_type, error.to_string()))?;
    if !matches!(parsed.structured(), OutputSchema::Object { .. }) {
        return Err(invalid_with(
            site,
            step_type,
            "`with.output_schema` must use `type: object`".to_owned(),
        ));
    }
    Ok(Some(parsed))
}

fn session_persistence(raw: Option<bool>) -> Persistence {
    match raw.unwrap_or(true) {
        true => Persistence::Persist,
        false => Persistence::Ephemeral,
    }
}

fn deserialize_with<T: for<'de> Deserialize<'de>>(
    site: FieldSite<'_>,
    step_type: &str,
    with: JsonValue,
) -> Result<T, ConfigError> {
    serde_json::from_value(with).map_err(|error| invalid_with(site, step_type, error.to_string()))
}

fn invalid_with(site: FieldSite<'_>, step_type: &str, message: String) -> ConfigError {
    ConfigError::InvalidWith {
        path: site.path.to_path_buf(),
        location: site.location,
        workflow_id: site.workflow_id.to_string(),
        step_index: site.step_index,
        step_type: step_type.to_owned(),
        message,
    }
}
