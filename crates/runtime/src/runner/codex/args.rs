use super::super::io::{artifact_file, write_schema_file};
use rigg_core::{CapturedValue, CodexMode, Persistence};
use rigg_engine::{
    EngineError, ExecutorError, RenderedCodexAction, RenderedCodexRequest, RenderedReviewScope,
};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CodexResultKind {
    Text,
    Structured,
}

impl CodexResultKind {
    fn for_request(request: &RenderedCodexRequest) -> Self {
        if request.result_schema.is_some() { Self::Structured } else { Self::Text }
    }

    pub(super) fn capture(
        self,
        result_text: Option<&str>,
    ) -> Result<Option<CapturedValue>, EngineError> {
        match self {
            Self::Text => Ok(result_text.map(|text| CapturedValue::Text(text.to_owned()))),
            Self::Structured => result_text.map(parse_json_text).transpose(),
        }
    }
}

#[derive(Debug)]
pub(super) struct PreparedCodexCommand {
    pub(super) args: Vec<OsString>,
    pub(super) output_path: PathBuf,
    pub(super) result_kind: CodexResultKind,
}

impl PreparedCodexCommand {
    pub(super) fn from_request(request: &RenderedCodexRequest) -> Result<Self, EngineError> {
        let result_kind = CodexResultKind::for_request(request);
        match &request.action {
            RenderedCodexAction::Exec { prompt, model, mode, add_dirs, persistence } => {
                validate_codex_resume_request(
                    request
                        .conversation
                        .as_ref()
                        .and_then(|conversation| conversation.resume_thread_id.as_deref()),
                    add_dirs,
                    request.result_schema.is_some(),
                )?;
                let output_path = artifact_file(&request.artifacts_dir, "exec-output", "txt")?;
                let schema_path = write_schema_file(
                    &request.artifacts_dir,
                    "exec-schema",
                    request.result_schema.as_ref(),
                )?;
                let args = build_codex_exec_args(CodexExecArgs {
                    prompt,
                    model: model.as_deref(),
                    mode: *mode,
                    add_dirs,
                    persistence: *persistence,
                    resume_thread_id: request
                        .conversation
                        .as_ref()
                        .and_then(|conversation| conversation.resume_thread_id.as_deref()),
                    output_path: &output_path,
                    schema_path: schema_path.as_deref(),
                });
                Ok(Self { args, output_path, result_kind })
            }
            RenderedCodexAction::Review {
                prompt,
                model,
                mode,
                title,
                add_dirs,
                persistence,
                scope,
            } => {
                let output_path = artifact_file(&request.artifacts_dir, "review-output", "txt")?;
                let args = build_codex_review_args(CodexReviewArgs {
                    prompt: prompt.as_deref(),
                    model: model.as_deref(),
                    mode: *mode,
                    title: title.as_deref(),
                    add_dirs,
                    persistence: *persistence,
                    scope,
                    output_path: &output_path,
                });
                Ok(Self { args, output_path, result_kind })
            }
        }
    }
}

pub(super) struct CodexExecArgs<'a> {
    pub(super) prompt: &'a str,
    pub(super) model: Option<&'a str>,
    pub(super) mode: CodexMode,
    pub(super) add_dirs: &'a [String],
    pub(super) persistence: Persistence,
    pub(super) resume_thread_id: Option<&'a str>,
    pub(super) output_path: &'a Path,
    pub(super) schema_path: Option<&'a Path>,
}

pub(super) fn build_codex_exec_args(config: CodexExecArgs<'_>) -> Vec<OsString> {
    let mut args = vec![OsString::from("exec")];
    if let Some(thread_id) = config.resume_thread_id {
        args.push(OsString::from("resume"));
        args.push(OsString::from(thread_id));
        push_codex_resume_args(&mut args, config.model, config.mode, config.persistence);
    } else {
        push_common_codex_args(
            &mut args,
            config.model,
            config.mode,
            config.add_dirs,
            config.persistence,
        );
        if let Some(schema_path) = config.schema_path {
            args.push(OsString::from("--output-schema"));
            args.push(schema_path.as_os_str().to_os_string());
        }
    }
    args.push(OsString::from("-o"));
    args.push(config.output_path.as_os_str().to_os_string());
    args.push(OsString::from(config.prompt));
    args
}

pub(super) struct CodexReviewArgs<'a> {
    pub(super) prompt: Option<&'a str>,
    pub(super) model: Option<&'a str>,
    pub(super) mode: CodexMode,
    pub(super) title: Option<&'a str>,
    pub(super) add_dirs: &'a [String],
    pub(super) persistence: Persistence,
    pub(super) scope: &'a RenderedReviewScope,
    pub(super) output_path: &'a Path,
}

pub(super) fn build_codex_review_args(config: CodexReviewArgs<'_>) -> Vec<OsString> {
    let mut args = vec![OsString::from("exec"), OsString::from("review")];
    push_common_codex_args(
        &mut args,
        config.model,
        config.mode,
        config.add_dirs,
        config.persistence,
    );
    match config.scope {
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
    if let Some(title) = config.title {
        args.push(OsString::from("--title"));
        args.push(OsString::from(title));
    }
    args.push(OsString::from("-o"));
    args.push(config.output_path.as_os_str().to_os_string());
    if let Some(prompt) = config.prompt {
        args.push(OsString::from(prompt));
    }
    args
}

fn validate_codex_resume_request(
    resume_thread_id: Option<&str>,
    add_dirs: &[String],
    has_result_schema: bool,
) -> Result<(), EngineError> {
    if resume_thread_id.is_some() && !add_dirs.is_empty() {
        return Err(EngineError::Executor(ExecutorError::UnsupportedCodexResumeOption {
            option: "--add-dir",
        }));
    }
    if resume_thread_id.is_some() && has_result_schema {
        return Err(EngineError::Executor(ExecutorError::UnsupportedCodexResumeOption {
            option: "--output-schema",
        }));
    }
    Ok(())
}

fn push_codex_resume_args(
    args: &mut Vec<OsString>,
    model: Option<&str>,
    mode: CodexMode,
    persistence: Persistence,
) {
    if let Some(model) = model {
        args.push(OsString::from("-m"));
        args.push(OsString::from(model));
    }
    if matches!(mode, CodexMode::FullAuto) {
        args.push(OsString::from("--full-auto"));
    }
    if matches!(persistence, Persistence::Ephemeral) {
        args.push(OsString::from("--ephemeral"));
    }
    args.push(OsString::from("--json"));
}

fn push_common_codex_args(
    args: &mut Vec<OsString>,
    model: Option<&str>,
    mode: CodexMode,
    add_dirs: &[String],
    persistence: Persistence,
) {
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
    if matches!(persistence, Persistence::Ephemeral) {
        args.push(OsString::from("--ephemeral"));
    }
    args.push(OsString::from("--json"));
}

fn parse_json_text(text: &str) -> Result<CapturedValue, EngineError> {
    serde_json::from_str(text.trim()).map(CapturedValue::Json).map_err(|source| {
        EngineError::Executor(ExecutorError::ParseJsonOutput { tool: "codex", source })
    })
}

#[cfg(test)]
mod tests {
    use super::{
        CodexExecArgs, CodexReviewArgs, PreparedCodexCommand, build_codex_exec_args,
        build_codex_review_args,
    };
    use rigg_core::{CodexMode, Persistence};
    use rigg_engine::{
        EngineError, ExecutorError, RenderedCodexAction, RenderedCodexConversation,
        RenderedCodexRequest, RenderedReviewScope,
    };
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn unsupported_resume_option(
        request: &RenderedCodexRequest,
    ) -> Result<&'static str, Box<dyn std::error::Error>> {
        let error = PreparedCodexCommand::from_request(request)
            .expect_err("expected unsupported resume option error");
        match error {
            EngineError::Executor(ExecutorError::UnsupportedCodexResumeOption { option }) => {
                Ok(option)
            }
            other => Err(format!("expected unsupported resume option error, got {other:?}").into()),
        }
    }

    #[test]
    fn builds_review_args_for_commit_scope() {
        let scope = RenderedReviewScope::Commit("abc123".to_owned());
        let add_dirs = vec!["docs".to_owned(), "notes".to_owned()];
        let args = build_codex_review_args(CodexReviewArgs {
            prompt: Some("review this"),
            model: Some("gpt-5"),
            mode: CodexMode::FullAuto,
            title: Some("Bug sweep"),
            add_dirs: &add_dirs,
            persistence: Persistence::Ephemeral,
            scope: &scope,
            output_path: Path::new("/tmp/out.txt"),
        });
        assert_eq!(
            stringify(&args),
            vec![
                "exec",
                "review",
                "-m",
                "gpt-5",
                "--full-auto",
                "--add-dir",
                "docs",
                "--add-dir",
                "notes",
                "--ephemeral",
                "--json",
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
    fn builds_exec_args_with_add_dirs() {
        let args = build_codex_exec_args(CodexExecArgs {
            prompt: "fix it",
            model: Some("gpt-5"),
            mode: CodexMode::FullAuto,
            add_dirs: &["docs".to_owned(), "notes".to_owned()],
            persistence: Persistence::Ephemeral,
            resume_thread_id: None,
            output_path: Path::new("/tmp/out.txt"),
            schema_path: Some(Path::new("/tmp/schema.json")),
        });
        assert_eq!(
            stringify(&args),
            vec![
                "exec",
                "-m",
                "gpt-5",
                "--full-auto",
                "--add-dir",
                "docs",
                "--add-dir",
                "notes",
                "--ephemeral",
                "--json",
                "--output-schema",
                "/tmp/schema.json",
                "-o",
                "/tmp/out.txt",
                "fix it",
            ]
        );
    }

    #[test]
    fn builds_exec_resume_args() {
        let args = build_codex_exec_args(CodexExecArgs {
            prompt: "follow up",
            model: None,
            mode: CodexMode::Default,
            add_dirs: &[],
            persistence: Persistence::Persist,
            resume_thread_id: Some("thread_123"),
            output_path: Path::new("/tmp/out.txt"),
            schema_path: None,
        });
        assert_eq!(
            stringify(&args),
            vec!["exec", "resume", "thread_123", "--json", "-o", "/tmp/out.txt", "follow up",]
        );
    }

    #[test]
    fn rejects_resumed_exec_with_add_dirs() -> Result<(), Box<dyn std::error::Error>> {
        let artifacts_dir = temp_artifacts_dir("resume-add-dirs");
        let request = RenderedCodexRequest {
            cwd: std::env::temp_dir(),
            artifacts_dir: artifacts_dir.join("codex"),
            env: BTreeMap::new(),
            result_schema: None,
            conversation: Some(RenderedCodexConversation {
                resume_thread_id: Some("thread_123".to_owned()),
            }),
            action: RenderedCodexAction::Exec {
                prompt: "follow up".to_owned(),
                model: Some("gpt-5".to_owned()),
                mode: CodexMode::FullAuto,
                add_dirs: vec!["docs".to_owned()],
                persistence: Persistence::Persist,
            },
        };

        assert_eq!(unsupported_resume_option(&request)?, "--add-dir");
        let _ = fs::remove_dir_all(artifacts_dir);
        Ok(())
    }

    #[test]
    fn rejects_resumed_exec_with_output_schema() -> Result<(), Box<dyn std::error::Error>> {
        let artifacts_dir = temp_artifacts_dir("resume-schema");
        let request = RenderedCodexRequest {
            cwd: std::env::temp_dir(),
            artifacts_dir: artifacts_dir.join("codex"),
            env: BTreeMap::new(),
            result_schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "markdown": { "type": "string" }
                }
            })),
            conversation: Some(RenderedCodexConversation {
                resume_thread_id: Some("thread_123".to_owned()),
            }),
            action: RenderedCodexAction::Exec {
                prompt: "follow up".to_owned(),
                model: Some("gpt-5".to_owned()),
                mode: CodexMode::FullAuto,
                add_dirs: vec![],
                persistence: Persistence::Persist,
            },
        };

        assert_eq!(unsupported_resume_option(&request)?, "--output-schema");
        let _ = fs::remove_dir_all(artifacts_dir);
        Ok(())
    }

    #[test]
    fn writes_auxiliary_files_to_artifacts_dir() -> Result<(), Box<dyn std::error::Error>> {
        let artifacts_dir = temp_artifacts_dir("prepared-command");
        let codex_dir = artifacts_dir.join("codex");
        let request = RenderedCodexRequest {
            cwd: std::env::temp_dir(),
            artifacts_dir: codex_dir.clone(),
            env: BTreeMap::new(),
            result_schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "markdown": { "type": "string" }
                }
            })),
            conversation: None,
            action: RenderedCodexAction::Exec {
                prompt: "fix it".to_owned(),
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: Persistence::Ephemeral,
            },
        };

        let prepared = PreparedCodexCommand::from_request(&request)?;
        assert_eq!(prepared.output_path.parent(), Some(codex_dir.as_path()));
        let args = stringify(&prepared.args);
        let schema_path = args
            .windows(2)
            .find(|window| window[0] == "--output-schema")
            .map(|window| PathBuf::from(&window[1]))
            .ok_or("schema path should be present")?;
        assert_eq!(schema_path.parent(), Some(codex_dir.as_path()));
        assert!(schema_path.exists());

        fs::remove_dir_all(artifacts_dir)?;
        Ok(())
    }

    #[test]
    fn always_builds_json_args_for_non_conversation_requests()
    -> Result<(), Box<dyn std::error::Error>> {
        let artifacts_dir = temp_artifacts_dir("json-transport");
        let request = RenderedCodexRequest {
            cwd: std::env::temp_dir(),
            artifacts_dir: artifacts_dir.join("codex"),
            env: BTreeMap::new(),
            result_schema: None,
            conversation: None,
            action: RenderedCodexAction::Exec {
                prompt: "fix it".to_owned(),
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: Persistence::Persist,
            },
        };

        let prepared = PreparedCodexCommand::from_request(&request)?;
        assert!(stringify(&prepared.args).iter().any(|arg| arg == "--json"));

        fs::remove_dir_all(artifacts_dir).ok();
        Ok(())
    }
    fn stringify(args: &[OsString]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect()
    }

    fn temp_artifacts_dir(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        std::env::temp_dir().join(format!("rigg-codex-args-{label}-{suffix}"))
    }
}
