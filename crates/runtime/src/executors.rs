use crate::process::{CommandSpec, ShellExecutor, run_program};
use rigg_core::{
    CapturedValue, CodexMode, EngineError, ShellResultMode, StepExecution, StepExecutor,
    engine::{
        ExecutionRequest, ExecutorError, RenderedClaudeRequest, RenderedCodexAction,
        RenderedCodexRequest, RenderedReviewScope, RenderedShellRequest, RenderedWriteFileRequest,
    },
};
use serde_json::Value as JsonValue;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Default)]
pub struct CliExecutor {
    shell: ShellExecutor,
}

impl StepExecutor for CliExecutor {
    fn execute(&self, request: &ExecutionRequest) -> Result<StepExecution, EngineError> {
        match request {
            ExecutionRequest::Shell(request) => self.execute_shell(request),
            ExecutionRequest::Codex(request) => self.execute_codex(request),
            ExecutionRequest::Claude(request) => self.execute_claude(request),
            ExecutionRequest::WriteFile(request) => self.execute_write_file(request),
        }
    }
}

impl CliExecutor {
    fn execute_shell(&self, request: &RenderedShellRequest) -> Result<StepExecution, EngineError> {
        let output = self
            .shell
            .execute(&request.command, &request.cwd, &request.env, None)
            .map_err(|source| EngineError::Executor(ExecutorError::SpawnShell { source }))?;

        let result = match request.result_mode {
            ShellResultMode::None => None,
            ShellResultMode::Text => Some(CapturedValue::Text(output.stdout.clone())),
            ShellResultMode::Json => Some(parse_json_text(&output.stdout)?),
        };

        Ok(StepExecution {
            started_at: output.started_at,
            finished_at: output.finished_at,
            duration_ms: output.duration_ms,
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            result,
        })
    }

    fn execute_codex(&self, request: &RenderedCodexRequest) -> Result<StepExecution, EngineError> {
        match &request.action {
            RenderedCodexAction::Exec { prompt, model, mode, add_dirs, persist } => {
                let output_path = temp_file("codex-exec-output", "txt");
                let mut schema_path = None;
                if let Some(schema) = &request.result_schema {
                    let path = temp_schema_path("codex-exec-schema");
                    fs::write(
                        &path,
                        serde_json::to_vec_pretty(schema).map_err(json_process_error)?,
                    )
                    .map_err(|source| {
                        EngineError::Executor(ExecutorError::WriteSchema {
                            path: path.clone(),
                            source,
                        })
                    })?;
                    schema_path = Some(path);
                }
                let args = build_codex_exec_args(
                    prompt,
                    model.as_deref(),
                    *mode,
                    add_dirs,
                    *persist,
                    &output_path,
                    schema_path.as_deref(),
                );

                let output = self.run_tool("codex", args, &request.cwd, &request.env)?;
                let text = read_optional_text(&output_path)?;
                let result = match &request.result_schema {
                    Some(_) => text.as_deref().map(parse_json_text).transpose()?,
                    None => text.map(CapturedValue::Text),
                };

                Ok(StepExecution {
                    started_at: output.started_at,
                    finished_at: output.finished_at,
                    duration_ms: output.duration_ms,
                    exit_code: output.exit_code,
                    stdout: output.stdout,
                    stderr: output.stderr,
                    result,
                })
            }
            RenderedCodexAction::Review {
                prompt,
                model,
                mode,
                title,
                add_dirs,
                persist,
                scope,
            } => {
                let output_path = temp_file("codex-review-output", "txt");
                let args = build_codex_review_args(
                    prompt.as_deref(),
                    model.as_deref(),
                    *mode,
                    title.as_deref(),
                    add_dirs,
                    *persist,
                    scope,
                    &output_path,
                );

                let output = self.run_tool("codex", args, &request.cwd, &request.env)?;
                let result = match &request.result_schema {
                    Some(_) => read_optional_text(&output_path)?
                        .as_deref()
                        .map(parse_json_text)
                        .transpose()?,
                    None => read_optional_text(&output_path)?.map(CapturedValue::Text),
                };
                Ok(StepExecution {
                    started_at: output.started_at,
                    finished_at: output.finished_at,
                    duration_ms: output.duration_ms,
                    exit_code: output.exit_code,
                    stdout: output.stdout,
                    stderr: output.stderr,
                    result,
                })
            }
        }
    }

    fn execute_claude(
        &self,
        request: &RenderedClaudeRequest,
    ) -> Result<StepExecution, EngineError> {
        let args = build_claude_args(request);

        let output = self.run_tool("claude", args, &request.cwd, &request.env)?;
        let result = match request.result_schema {
            Some(_) => Some(parse_claude_structured_output(&output.stdout)?),
            None => Some(CapturedValue::Text(output.stdout.clone())),
        };

        Ok(StepExecution {
            started_at: output.started_at,
            finished_at: output.finished_at,
            duration_ms: output.duration_ms,
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
            result,
        })
    }

    fn execute_write_file(
        &self,
        request: &RenderedWriteFileRequest,
    ) -> Result<StepExecution, EngineError> {
        let started_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned());
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
        let finished_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned());

        Ok(StepExecution {
            started_at,
            finished_at,
            duration_ms: start.elapsed().as_millis(),
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            result: Some(CapturedValue::Json(serde_json::json!({
                "path": request.path.display().to_string()
            }))),
        })
    }

    fn run_tool(
        &self,
        program: &str,
        args: Vec<OsString>,
        cwd: &Path,
        env: &std::collections::BTreeMap<String, String>,
    ) -> Result<super::process::CommandOutput, EngineError> {
        run_program(
            CommandSpec { program: OsString::from(program), args, stdin_text: None },
            cwd,
            env,
        )
        .map_err(|source| {
            EngineError::Executor(ExecutorError::RunTool { program: program.to_owned(), source })
        })
    }
}

fn build_codex_exec_args(
    prompt: &str,
    model: Option<&str>,
    mode: CodexMode,
    add_dirs: &[String],
    persist: bool,
    output_path: &Path,
    schema_path: Option<&Path>,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("exec")];
    if let Some(model) = model {
        args.push(OsString::from("-m"));
        args.push(OsString::from(model));
    }
    if matches!(mode, CodexMode::FullAuto) {
        args.push(OsString::from("--full-auto"));
    }
    for add_dir in add_dirs {
        args.push(OsString::from("--add-dir"));
        args.push(OsString::from(add_dir));
    }
    if !persist {
        args.push(OsString::from("--ephemeral"));
    }
    if let Some(schema_path) = schema_path {
        args.push(OsString::from("--output-schema"));
        args.push(schema_path.as_os_str().to_os_string());
    }
    args.push(OsString::from("-o"));
    args.push(output_path.as_os_str().to_os_string());
    args.push(OsString::from(prompt));
    args
}

fn build_codex_review_args(
    prompt: Option<&str>,
    model: Option<&str>,
    mode: CodexMode,
    title: Option<&str>,
    add_dirs: &[String],
    persist: bool,
    scope: &RenderedReviewScope,
    output_path: &Path,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("review")];
    if let Some(model) = model {
        args.push(OsString::from("-m"));
        args.push(OsString::from(model));
    }
    if matches!(mode, CodexMode::FullAuto) {
        args.push(OsString::from("--full-auto"));
    }
    for add_dir in add_dirs {
        args.push(OsString::from("--add-dir"));
        args.push(OsString::from(add_dir));
    }
    if !persist {
        args.push(OsString::from("--ephemeral"));
    }
    match scope {
        RenderedReviewScope::Uncommitted => args.push(OsString::from("--uncommitted")),
        RenderedReviewScope::Base(base) => {
            args.push(OsString::from("--base"));
            args.push(OsString::from(base));
        }
        RenderedReviewScope::Commit(commit) => {
            args.push(OsString::from("--commit"));
            args.push(OsString::from(commit));
        }
    }
    if let Some(title) = title {
        args.push(OsString::from("--title"));
        args.push(OsString::from(title));
    }
    args.push(OsString::from("-o"));
    args.push(output_path.as_os_str().to_os_string());
    if let Some(prompt) = prompt {
        args.push(OsString::from(prompt));
    }
    args
}

fn build_claude_args(request: &RenderedClaudeRequest) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-p"),
        OsString::from("--permission-mode"),
        OsString::from(request.permission_mode.as_str()),
        OsString::from("--output-format"),
        OsString::from(if request.result_schema.is_some() { "json" } else { "text" }),
    ];
    if let Some(model) = &request.model {
        args.push(OsString::from("--model"));
        args.push(OsString::from(model));
    }
    for add_dir in &request.add_dirs {
        args.push(OsString::from("--add-dir"));
        args.push(OsString::from(add_dir));
    }
    if !request.persist {
        args.push(OsString::from("--no-session-persistence"));
    }
    if let Some(schema) = &request.result_schema {
        args.push(OsString::from("--json-schema"));
        args.push(OsString::from(schema.to_string()));
    }
    args.push(OsString::from(&request.prompt));
    args
}

fn read_optional_text(path: &Path) -> Result<Option<String>, EngineError> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|source| {
        EngineError::Executor(ExecutorError::ReadFile { path: path.to_path_buf(), source })
    })?;
    Ok(Some(text))
}

fn parse_json_text(text: &str) -> Result<CapturedValue, EngineError> {
    serde_json::from_str(text.trim()).map(CapturedValue::Json).map_err(|source| {
        EngineError::Executor(ExecutorError::ParseJsonOutput { tool: "command", source })
    })
}

fn parse_claude_structured_output(text: &str) -> Result<CapturedValue, EngineError> {
    let value: JsonValue = serde_json::from_str(text.trim()).map_err(|source| {
        EngineError::Executor(ExecutorError::ParseJsonOutput { tool: "claude", source })
    })?;

    let normalized = value.get("structured_output").cloned().unwrap_or(value);

    Ok(CapturedValue::Json(normalized))
}

fn temp_schema_path(prefix: &str) -> PathBuf {
    temp_file(prefix, "json")
}

fn temp_file(prefix: &str, ext: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{prefix}-{}.{}", Uuid::now_v7(), ext))
}

fn json_process_error(error: serde_json::Error) -> EngineError {
    EngineError::Executor(ExecutorError::SerializeJson {
        operation: "structured output",
        source: error,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_claude_args, build_codex_exec_args, build_codex_review_args,
        parse_claude_structured_output,
    };
    use rigg_core::{
        CapturedValue, ClaudePermissionMode, CodexMode, engine::RenderedClaudeRequest,
        engine::RenderedReviewScope,
    };
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn extracts_claude_structured_output_from_result_envelope()
    -> Result<(), Box<dyn std::error::Error>> {
        let result = parse_claude_structured_output(
            r#"{
              "type":"result",
              "subtype":"success",
              "structured_output":{"markdown":"ok"}
            }"#,
        )?;
        assert_eq!(
            result,
            CapturedValue::Json(serde_json::json!({
                "markdown": "ok"
            }))
        );
        Ok(())
    }

    #[test]
    fn keeps_raw_json_when_claude_returns_plain_object() -> Result<(), Box<dyn std::error::Error>> {
        let result = parse_claude_structured_output(r#"{"markdown":"ok"}"#)?;
        assert_eq!(
            result,
            CapturedValue::Json(serde_json::json!({
                "markdown": "ok"
            }))
        );
        Ok(())
    }

    #[test]
    fn builds_codex_review_args_for_commit_scope() {
        let args = build_codex_review_args(
            Some("review this"),
            Some("gpt-5"),
            CodexMode::FullAuto,
            Some("Bug sweep"),
            &["docs".to_owned(), "notes".to_owned()],
            false,
            &RenderedReviewScope::Commit("abc123".to_owned()),
            Path::new("/tmp/out.txt"),
        );
        assert_eq!(
            stringify(&args),
            vec![
                "review",
                "-m",
                "gpt-5",
                "--full-auto",
                "--add-dir",
                "docs",
                "--add-dir",
                "notes",
                "--ephemeral",
                "--commit",
                "abc123",
                "--title",
                "Bug sweep",
                "-o",
                "/tmp/out.txt",
                "review this",
            ]
        );
    }

    #[test]
    fn builds_codex_exec_args_with_add_dirs_and_ephemeral() {
        let args = build_codex_exec_args(
            "fix it",
            None,
            CodexMode::Default,
            &["docs".to_owned()],
            false,
            Path::new("/tmp/out.txt"),
            Some(Path::new("/tmp/schema.json")),
        );
        assert_eq!(
            stringify(&args),
            vec![
                "exec",
                "--add-dir",
                "docs",
                "--ephemeral",
                "--output-schema",
                "/tmp/schema.json",
                "-o",
                "/tmp/out.txt",
                "fix it",
            ]
        );
    }

    #[test]
    fn builds_claude_args_with_add_dirs_and_non_persistent_session() {
        let args = build_claude_args(&RenderedClaudeRequest {
            cwd: std::env::temp_dir(),
            env: BTreeMap::new(),
            prompt: "summarize".to_owned(),
            model: Some("sonnet".to_owned()),
            permission_mode: ClaudePermissionMode::Plan,
            add_dirs: vec!["docs".to_owned(), "notes".to_owned()],
            persist: false,
            result_schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "markdown": { "type": "string" }
                },
                "required": ["markdown"]
            })),
        });
        let args = stringify(&args);
        assert_eq!(
            &args[..13],
            &[
                "-p",
                "--permission-mode",
                "plan",
                "--output-format",
                "json",
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
            serde_json::from_str::<serde_json::Value>(&args[13]).unwrap(),
            serde_json::json!({
                "type": "object",
                "properties": {
                    "markdown": { "type": "string" }
                },
                "required": ["markdown"]
            })
        );
        assert_eq!(args[14], "summarize");
    }

    fn stringify(args: &[OsString]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect()
    }
}
