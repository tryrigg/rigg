use super::error::{current_dir_error, template_error};
use super::protocol::ExecutionPlan;
use super::{
    RenderedClaudeConversation, RenderedClaudeRequest, RenderedCodexAction,
    RenderedCodexConversation, RenderedCodexRequest, RenderedReviewScope, RenderedShellRequest,
    RenderedWriteFileRequest, StepRunRequest, context::FrameContext,
    conversations::ConversationState,
};
use crate::conversation::{ConversationHandle, ConversationProvider};
use crate::ids::{NodePath, StepId};
use crate::state::RunState;
use crate::workflow::{ActionKind, NodeAttrs, ReviewScope, ValidatedNode};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub(super) fn render_request(
    plan: &ExecutionPlan,
    node: &ValidatedNode,
    node_env: &BTreeMap<String, String>,
    context: &JsonValue,
    conversations: &ConversationState,
    frame: &FrameContext,
    run_artifacts_dir: &Path,
) -> Result<StepRunRequest, super::EngineError> {
    let action = match &node.kind {
        crate::workflow::NodeKind::Action(action) => action,
        _ => unreachable!("slice 5 only executes action nodes"),
    };

    match &action.action {
        ActionKind::Shell(shell) => Ok(StepRunRequest::Shell(RenderedShellRequest {
            cwd: plan.project_root.clone(),
            env: node_env.clone(),
            command: shell.command.render(context).map_err(template_error)?,
            result_mode: shell.result_mode,
        })),
        ActionKind::WriteFile(write) => {
            let path = write.path.render(context).map_err(template_error)?;
            let content = write.content.render(context).map_err(template_error)?;
            Ok(StepRunRequest::WriteFile(RenderedWriteFileRequest {
                cwd: plan.project_root.clone(),
                path: resolve_output_path(&plan.project_root, &path),
                contents: content,
            }))
        }
        ActionKind::Claude(claude) => Ok(StepRunRequest::Claude(RenderedClaudeRequest {
            cwd: plan.project_root.clone(),
            env: node_env.clone(),
            prompt: claude.prompt.render(context).map_err(template_error)?,
            model: claude.model.clone(),
            permission_mode: claude.permission_mode.clone(),
            add_dirs: claude
                .add_dirs
                .iter()
                .map(|dir| dir.render(context).map_err(template_error))
                .collect::<Result<Vec<_>, _>>()?,
            persistence: claude.persistence,
            conversation: render_claude_conversation(
                conversations,
                frame,
                claude.conversation.as_ref(),
            )?,
            result_schema: action.result_contract.provider_schema().cloned(),
        })),
        ActionKind::Codex(codex) => Ok(StepRunRequest::Codex(RenderedCodexRequest {
            cwd: plan.project_root.clone(),
            artifacts_dir: absolute_path(&plan.project_root, &run_artifacts_dir.join("codex"))?,
            env: node_env.clone(),
            result_schema: action.result_contract.provider_schema().cloned(),
            conversation: render_codex_conversation(
                conversations,
                frame,
                match &codex.action {
                    crate::workflow::CodexAction::Exec(exec) => exec.conversation.as_ref(),
                    crate::workflow::CodexAction::Review(_) => None,
                },
            )?,
            action: match &codex.action {
                crate::workflow::CodexAction::Review(review) => {
                    let prompt = review
                        .prompt
                        .as_ref()
                        .map(|prompt| prompt.render(context).map_err(template_error))
                        .transpose()?;
                    RenderedCodexAction::Review {
                        prompt,
                        model: review.model.clone(),
                        mode: review.mode,
                        title: review
                            .title
                            .as_ref()
                            .map(|title| title.render(context).map_err(template_error))
                            .transpose()?,
                        add_dirs: review
                            .add_dirs
                            .iter()
                            .map(|dir| dir.render(context).map_err(template_error))
                            .collect::<Result<Vec<_>, _>>()?,
                        persistence: review.persistence,
                        scope: match &review.scope {
                            ReviewScope::Uncommitted => RenderedReviewScope::Uncommitted,
                            ReviewScope::Base(base) => RenderedReviewScope::Base(
                                base.render(context).map_err(template_error)?,
                            ),
                            ReviewScope::Commit(commit) => RenderedReviewScope::Commit(
                                commit.render(context).map_err(template_error)?,
                            ),
                        },
                    }
                }
                crate::workflow::CodexAction::Exec(exec) => RenderedCodexAction::Exec {
                    prompt: exec.prompt.render(context).map_err(template_error)?,
                    model: exec.model.clone(),
                    mode: exec.mode,
                    add_dirs: exec
                        .add_dirs
                        .iter()
                        .map(|dir| dir.render(context).map_err(template_error))
                        .collect::<Result<Vec<_>, _>>()?,
                    persistence: exec.persistence,
                },
            },
        })),
    }
}

pub(super) fn render_env(
    plan: &ExecutionPlan,
    state: &RunState,
    visible_steps: &BTreeMap<StepId, NodePath>,
    node_attrs: &NodeAttrs,
    frame: &FrameContext,
) -> Result<BTreeMap<String, String>, super::EngineError> {
    let mut env = plan.parent_env.clone();
    render_env_fields(&plan.workflow.env, plan, state, visible_steps, &mut env, frame)?;
    render_env_fields(&node_attrs.env, plan, state, visible_steps, &mut env, frame)?;
    Ok(env)
}

fn render_env_fields(
    fields: &[crate::TemplateField],
    plan: &ExecutionPlan,
    state: &RunState,
    visible_steps: &BTreeMap<StepId, NodePath>,
    env: &mut BTreeMap<String, String>,
    frame: &FrameContext,
) -> Result<(), super::EngineError> {
    for field in fields {
        let context = super::context::build_context(plan, state, visible_steps, env, frame);
        let value = field.value.render(&context).map_err(template_error)?;
        env.insert(field.key.clone(), value);
    }
    Ok(())
}

pub(super) fn conversation_binding(
    action: &crate::ActionNode,
) -> Option<&crate::ConversationBinding> {
    action.action.conversation_binding()
}

fn resolve_output_path(cwd: &Path, raw_path: &str) -> PathBuf {
    resolve_path(cwd, Path::new(raw_path))
}

fn resolve_path(cwd: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) }
}

fn absolute_path(cwd: &Path, path: &Path) -> Result<PathBuf, super::EngineError> {
    let path = resolve_path(cwd, path);
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir().map(|process_cwd| process_cwd.join(path)).map_err(current_dir_error)
    }
}

fn render_claude_conversation(
    conversations: &ConversationState,
    frame: &FrameContext,
    conversation: Option<&crate::ConversationBinding>,
) -> Result<Option<RenderedClaudeConversation>, super::EngineError> {
    conversation
        .map(|conversation| {
            Ok(RenderedClaudeConversation {
                resume_session_id: lookup_conversation_handle(
                    conversations,
                    frame,
                    conversation,
                    ConversationProvider::Claude,
                )?
                .and_then(ConversationHandle::claude_session_id)
                .map(str::to_owned),
            })
        })
        .transpose()
}

fn render_codex_conversation(
    conversations: &ConversationState,
    frame: &FrameContext,
    conversation: Option<&crate::ConversationBinding>,
) -> Result<Option<RenderedCodexConversation>, super::EngineError> {
    conversation
        .map(|conversation| {
            Ok(RenderedCodexConversation {
                resume_thread_id: lookup_conversation_handle(
                    conversations,
                    frame,
                    conversation,
                    ConversationProvider::Codex,
                )?
                .and_then(ConversationHandle::codex_thread_id)
                .map(str::to_owned),
            })
        })
        .transpose()
}

fn lookup_conversation_handle<'a>(
    conversations: &'a ConversationState,
    frame: &FrameContext,
    conversation: &crate::ConversationBinding,
    provider: ConversationProvider,
) -> Result<Option<&'a ConversationHandle>, super::EngineError> {
    let Some(handle) = conversations.lookup(frame, conversation) else {
        return Ok(None);
    };
    if handle.provider() == provider {
        Ok(Some(handle))
    } else {
        unreachable!("conversation providers are validated at config load time")
    }
}
