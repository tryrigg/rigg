use super::record;
use super::runner::{NodeRunContext, RunEngineContext};
use super::{Engine, EngineError, RunEvent, RunEventRecord, RunReason, RunStatus, StreamKind};
use crate::conversation::ConversationProvider;
use crate::error::ExecutorError;
use crate::progress::{LiveEvent, ProviderEvent, StepProgressSink};
use crate::state::RunState;
use crate::workflow::ValidatedNode;

struct ScopedStepProgress<'a> {
    sink: &'a mut dyn crate::progress::ProgressSink,
    frame_id: crate::FrameId,
    node_path: crate::NodePath,
    user_id: Option<crate::StepId>,
}

impl StepProgressSink for ScopedStepProgress<'_> {
    fn is_enabled(&self) -> bool {
        self.sink.is_enabled()
    }

    fn step_output(&mut self, stream: StreamKind, chunk: &str) {
        self.sink.emit(LiveEvent::StepOutput { stream, chunk: chunk.to_owned() });
    }

    fn provider_event(&mut self, event: ProviderEvent) {
        match event {
            ProviderEvent::ToolUse { provider, tool, detail } => {
                self.sink.emit(LiveEvent::ProviderToolUse {
                    frame_id: self.frame_id.clone(),
                    node_path: self.node_path.clone(),
                    user_id: self.user_id.clone(),
                    provider,
                    tool,
                    detail,
                })
            }
            ProviderEvent::Status { provider, message } => {
                self.sink.emit(LiveEvent::ProviderStatus {
                    frame_id: self.frame_id.clone(),
                    node_path: self.node_path.clone(),
                    user_id: self.user_id.clone(),
                    provider,
                    message,
                })
            }
            ProviderEvent::Error { provider, message } => {
                self.sink.emit(LiveEvent::ProviderError {
                    frame_id: self.frame_id.clone(),
                    node_path: self.node_path.clone(),
                    user_id: self.user_id.clone(),
                    provider,
                    message,
                })
            }
        }
    }
}

impl Engine {
    fn persist_action_execution(
        &self,
        state: &mut RunState,
        recorder: &mut dyn crate::RunRecorder,
        frame: &super::context::FrameContext,
        node: &ValidatedNode,
        attempt: u32,
        execution: &crate::StepRunResult,
    ) -> Result<(), EngineError> {
        let stdout_path =
            recorder.log_path(frame.frame_id(), &node.path, attempt, StreamKind::Stdout);
        let stderr_path =
            recorder.log_path(frame.frame_id(), &node.path, attempt, StreamKind::Stderr);
        append_provider_logs(
            recorder,
            &stdout_path,
            &stderr_path,
            &execution.stdout,
            &execution.provider_events,
        )?;
        recorder.append_log(&stdout_path, &execution.stdout)?;
        recorder.append_log(&stderr_path, &execution.stderr)?;
        self.update_node_executions(state, frame, node, |current, frame_result| {
            record::record_execution(current, attempt, execution, &stdout_path, &stderr_path);
            record::record_execution(frame_result, attempt, execution, &stdout_path, &stderr_path);
        });
        Ok(())
    }

    pub(super) fn execute_action_node(
        &self,
        node: &ValidatedNode,
        action: &crate::ActionNode,
        exec: NodeRunContext<'_>,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
    ) -> Result<bool, EngineError> {
        let run_artifacts_dir = ctx.recorder.run_artifacts_dir()?;
        let request = super::render::render_request(
            ctx.plan,
            node,
            exec.node_env,
            exec.context,
            &ctx.conversations,
            exec.frame,
            &run_artifacts_dir,
        )?;
        let attempt = self.next_attempt(state, node);
        let provider = request_provider(&request);
        ctx.recorder.append_event(&RunEventRecord {
            ts: ctx.clock.now(),
            event: RunEvent::NodeStarted {
                frame_id: exec.frame.frame_id().clone(),
                node_path: node.path.clone(),
                user_id: node.user_id.clone(),
                node_kind: node.kind.label().to_owned(),
                attempt,
                command: request.label(),
            },
        })?;
        ctx.progress.emit(LiveEvent::NodeStarted {
            frame_id: exec.frame.frame_id().clone(),
            node_path: node.path.clone(),
            user_id: node.user_id.clone(),
            node_kind: node.kind.label().to_owned(),
            provider,
            attempt,
        });

        let mut scoped_progress = ScopedStepProgress {
            sink: ctx.progress,
            frame_id: exec.frame.frame_id().clone(),
            node_path: node.path.clone(),
            user_id: node.user_id.clone(),
        };
        let execution = match ctx.step_runner.run_step(&request, &mut scoped_progress) {
            Ok(execution) => execution,
            Err(error) => {
                if let Some(execution) = error.partial_execution().cloned() {
                    self.persist_action_execution(
                        state,
                        ctx.recorder,
                        exec.frame,
                        node,
                        attempt,
                        &execution,
                    )?;
                } else {
                    let failed_at = ctx.clock.now();
                    self.update_node_executions(
                        state,
                        exec.frame,
                        node,
                        |current, frame_result| {
                            record::mark_failed_to_start(current, attempt, failed_at.clone());
                            record::mark_failed_to_start(frame_result, attempt, failed_at);
                        },
                    );
                }
                self.record_node_finished(
                    state,
                    ctx.recorder,
                    node,
                    exec.frame,
                    ctx.clock,
                    ctx.progress,
                )?;
                return Err(error);
            }
        };

        self.persist_action_execution(state, ctx.recorder, exec.frame, node, attempt, &execution)?;

        if execution.exit_code != 0 {
            self.record_node_finished(
                state,
                ctx.recorder,
                node,
                exec.frame,
                ctx.clock,
                ctx.progress,
            )?;
            self.finish_run(
                state,
                ctx.recorder,
                RunStatus::Failed,
                RunReason::StepFailed,
                ctx.clock,
                ctx.progress,
            )?;
            return Ok(false);
        }

        let result = match super::result::finalize_result(node, execution.result.as_ref()) {
            Ok(result) => result,
            Err(error) => {
                self.record_node_finished(
                    state,
                    ctx.recorder,
                    node,
                    exec.frame,
                    ctx.clock,
                    ctx.progress,
                )?;
                return Err(error);
            }
        };

        let conversation_handle = match super::render::conversation_binding(action) {
            Some(conversation) => match execution.conversation_handle.clone() {
                Some(handle) => Some((conversation, handle)),
                None => {
                    self.record_node_finished(
                        state,
                        ctx.recorder,
                        node,
                        exec.frame,
                        ctx.clock,
                        ctx.progress,
                    )?;
                    return Err(EngineError::Executor(ExecutorError::MissingConversationHandle {
                        tool: provider_tool_label(provider),
                    }));
                }
            },
            None => None,
        };

        self.update_node_executions(state, exec.frame, node, |current, frame_result| {
            current.result = result.clone();
            current.status = crate::NodeStatus::Succeeded;
            frame_result.result = result;
            frame_result.status = crate::NodeStatus::Succeeded;
        });

        if let Some((conversation, handle)) = conversation_handle {
            ctx.conversations.store(state, exec.frame, conversation, handle);
        }

        self.record_node_finished(state, ctx.recorder, node, exec.frame, ctx.clock, ctx.progress)?;
        Ok(true)
    }
}

fn request_provider(request: &crate::StepRunRequest) -> Option<ConversationProvider> {
    match request {
        crate::StepRunRequest::Codex(_) => Some(ConversationProvider::Codex),
        crate::StepRunRequest::Claude(_) => Some(ConversationProvider::Claude),
        crate::StepRunRequest::Shell(_) | crate::StepRunRequest::WriteFile(_) => None,
    }
}

fn provider_tool_label(provider: Option<ConversationProvider>) -> &'static str {
    match provider {
        Some(ConversationProvider::Codex) => "codex",
        Some(ConversationProvider::Claude) => "claude",
        None => "step",
    }
}

fn append_provider_logs(
    recorder: &mut dyn crate::RunRecorder,
    stdout_path: &str,
    stderr_path: &str,
    stdout: &str,
    events: &[ProviderEvent],
) -> Result<(), EngineError> {
    for event in events {
        match event {
            ProviderEvent::ToolUse { tool, detail, .. } => recorder
                .append_log(stdout_path, &format_log_block("tool", &tool_detail(tool, detail)))?,
            ProviderEvent::Status { provider: ConversationProvider::Codex, message } => {
                append_codex_provider_message(recorder, stdout_path, stdout, "progress", message)?
            }
            ProviderEvent::Error { provider: ConversationProvider::Codex, message } => {
                append_codex_provider_message(recorder, stdout_path, stdout, "error", message)?
            }
            ProviderEvent::Status { message, .. } => {
                recorder.append_log(stdout_path, &format_log_block("progress", message))?
            }
            ProviderEvent::Error { message, .. } => {
                recorder.append_log(stderr_path, &format_log_block("error", message))?
            }
        }
    }
    Ok(())
}

fn append_codex_provider_message(
    recorder: &mut dyn crate::RunRecorder,
    stdout_path: &str,
    stdout: &str,
    label: &str,
    message: &str,
) -> Result<(), EngineError> {
    if stdout_contains_exact_block(stdout, message) {
        return Ok(());
    }
    recorder.append_log(stdout_path, &format_log_block(label, message))
}

fn stdout_contains_exact_block(stdout: &str, message: &str) -> bool {
    let message_lines = message.lines().collect::<Vec<_>>();
    if message_lines.is_empty() {
        return false;
    }
    let stdout_lines = stdout.lines().collect::<Vec<_>>();
    stdout_lines.windows(message_lines.len()).any(|window| window == message_lines.as_slice())
}

fn tool_detail(tool: &str, detail: &Option<String>) -> String {
    match detail.as_deref() {
        Some(detail) if !detail.is_empty() => format!("{tool} {detail}"),
        _ => tool.to_owned(),
    }
}

fn format_log_block(label: &str, text: &str) -> String {
    let mut rendered = String::new();
    let mut wrote_any = false;
    for (index, line) in text.lines().enumerate() {
        let prefix = if index == 0 { format!("  [{label}]") } else { "           ".to_owned() };
        rendered.push_str(&prefix);
        rendered.push(' ');
        rendered.push_str(line);
        rendered.push('\n');
        wrote_any = true;
    }
    if !wrote_any {
        rendered.push_str(&format!("  [{label}]\n"));
    }
    rendered
}
