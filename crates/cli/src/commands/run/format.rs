use rigg_core::progress::LiveEvent;
use rigg_core::{LoopIterationOutcome, NodePath, NodeStatus, RunStatus, StepId, StreamKind};

#[derive(Debug, Default)]
pub(super) struct ProgressFormatter {
    output: OutputBuffer,
}

impl ProgressFormatter {
    pub(super) fn render(&mut self, event: LiveEvent) -> Vec<String> {
        match event {
            LiveEvent::RunStarted { run_id, workflow_id, node_count } => self.with_flushed_output(
                vec![format!("[run] id={run_id} workflow={workflow_id} nodes={node_count}")],
            ),
            LiveEvent::NodeStarted { node_path, user_id, node_kind, attempt, .. } => {
                let label = node_label(user_id.as_ref(), &node_path);
                self.with_flushed_output(format_block(
                    "start",
                    &format!("node={label} kind={node_kind} attempt={attempt}"),
                ))
            }
            LiveEvent::NodeSkipped { node_path, user_id, reason, .. } => {
                self.with_flushed_output(format_block(
                    "skip",
                    &format!("node={} reason={reason}", node_label(user_id.as_ref(), &node_path)),
                ))
            }
            LiveEvent::BranchSelected { node_path, user_id, case_index, selection, .. } => self
                .with_flushed_output(vec![format!(
                    "[branch] node={} case={} kind={}",
                    node_label(user_id.as_ref(), &node_path),
                    case_index,
                    selection.as_str()
                )]),
            LiveEvent::LoopIterationStarted {
                node_path,
                user_id,
                iteration,
                max_iterations,
                ..
            } => self.with_flushed_output(vec![format!(
                "[loop] node={} iteration={iteration}/{max_iterations} status=started",
                node_label(user_id.as_ref(), &node_path),
            )]),
            LiveEvent::LoopIterationFinished {
                node_path,
                user_id,
                iteration,
                max_iterations,
                outcome,
                ..
            } => self.with_flushed_output(vec![format!(
                "[loop] node={} iteration={iteration}/{max_iterations} status={}",
                node_label(user_id.as_ref(), &node_path),
                loop_iteration_outcome(outcome),
            )]),
            LiveEvent::StepOutput { stream, chunk } => {
                self.output.push(stream, &chunk).into_iter().map(format_stream_line).collect()
            }
            LiveEvent::ProviderToolUse { .. } | LiveEvent::ProviderStatus { .. } => Vec::new(),
            LiveEvent::ProviderError { node_path, user_id, provider, message, .. } => {
                let label = node_label(user_id.as_ref(), &node_path);
                self.with_flushed_output(format_block(
                    "error",
                    &format!("provider={provider} node={label} {message}"),
                ))
            }
            LiveEvent::NodeFinished {
                node_path,
                user_id,
                status,
                exit_code,
                duration_ms,
                stdout_path,
                stderr_path,
                ..
            } => self.with_flushed_output(vec![format!(
                "[done] node={} status={} exit={} duration={} stdout={} stderr={}",
                node_label(user_id.as_ref(), &node_path),
                node_status(status),
                exit_code.map_or_else(|| "-".to_owned(), |value| value.to_string()),
                duration_ms.map_or_else(|| "-".to_owned(), |value| format!("{value}ms")),
                stdout_path.unwrap_or_else(|| "-".to_owned()),
                stderr_path.unwrap_or_else(|| "-".to_owned()),
            )]),
            LiveEvent::RunFinished { status, reason } => self.with_flushed_output(vec![format!(
                "[run] status={} reason={}",
                run_status(status),
                format!("{reason:?}").to_lowercase()
            )]),
        }
    }

    pub(super) fn flush(&mut self) -> Vec<String> {
        self.output.flush_all().into_iter().map(format_stream_line).collect()
    }

    fn with_flushed_output(&mut self, mut lines: Vec<String>) -> Vec<String> {
        let mut rendered = self.flush();
        rendered.append(&mut lines);
        rendered
    }
}

#[derive(Debug, Default)]
struct OutputBuffer {
    pending_stdout: PendingOutput,
    pending_stderr: PendingOutput,
    next_pending_order: u64,
}

impl OutputBuffer {
    fn push(&mut self, stream: StreamKind, chunk: &str) -> Vec<BufferedLine> {
        let mut rendered = Vec::new();
        let mut remaining = chunk;
        while let Some(newline_index) = remaining.find('\n') {
            self.push_pending_fragment(stream, &remaining[..newline_index]);
            self.ensure_pending_output(stream);
            self.flush_pending_stream_in_order(stream, &mut rendered);
            remaining = &remaining[newline_index + 1..];
        }
        self.push_pending_fragment(stream, remaining);
        rendered
    }

    fn flush_all(&mut self) -> Vec<BufferedLine> {
        let mut rendered = Vec::new();
        match (self.pending_stdout.order, self.pending_stderr.order) {
            (Some(stdout_order), Some(stderr_order)) if stdout_order <= stderr_order => {
                self.flush_pending_stream(StreamKind::Stdout, &mut rendered);
                self.flush_pending_stream(StreamKind::Stderr, &mut rendered);
            }
            (Some(_), Some(_)) => {
                self.flush_pending_stream(StreamKind::Stderr, &mut rendered);
                self.flush_pending_stream(StreamKind::Stdout, &mut rendered);
            }
            (Some(_), None) => self.flush_pending_stream(StreamKind::Stdout, &mut rendered),
            (None, Some(_)) => self.flush_pending_stream(StreamKind::Stderr, &mut rendered),
            (None, None) => {}
        }
        rendered
    }

    fn push_pending_fragment(&mut self, stream: StreamKind, fragment: &str) {
        if fragment.is_empty() {
            return;
        }
        self.ensure_pending_output(stream);
        self.pending_output_mut(stream).text.push_str(fragment);
    }

    fn ensure_pending_output(&mut self, stream: StreamKind) {
        if self.pending_output(stream).order.is_some() {
            return;
        }
        let order = self.next_pending_order;
        self.next_pending_order += 1;
        self.pending_output_mut(stream).order = Some(order);
    }

    fn flush_pending_stream_in_order(
        &mut self,
        stream: StreamKind,
        rendered: &mut Vec<BufferedLine>,
    ) {
        let Some(target_order) = self.pending_output(stream).order else {
            return;
        };
        let other_stream = other_stream(stream);
        if let Some(other_order) = self.pending_output(other_stream).order
            && other_order < target_order
        {
            self.flush_pending_stream(other_stream, rendered);
        }
        self.flush_pending_stream(stream, rendered);
    }

    fn flush_pending_stream(&mut self, stream: StreamKind, rendered: &mut Vec<BufferedLine>) {
        let pending = self.pending_output_mut(stream);
        if pending.order.is_none() {
            return;
        }

        let line = pending.text.trim_end_matches('\r').to_owned();
        pending.text.clear();
        pending.order = None;
        rendered.push(BufferedLine { stream, text: line });
    }

    fn pending_output(&self, stream: StreamKind) -> &PendingOutput {
        match stream {
            StreamKind::Stdout => &self.pending_stdout,
            StreamKind::Stderr => &self.pending_stderr,
        }
    }

    fn pending_output_mut(&mut self, stream: StreamKind) -> &mut PendingOutput {
        match stream {
            StreamKind::Stdout => &mut self.pending_stdout,
            StreamKind::Stderr => &mut self.pending_stderr,
        }
    }
}

#[derive(Debug)]
struct BufferedLine {
    stream: StreamKind,
    text: String,
}

#[derive(Debug, Default)]
struct PendingOutput {
    text: String,
    order: Option<u64>,
}

fn format_block(label: &str, text: &str) -> Vec<String> {
    let mut rendered = Vec::new();
    let mut lines = text.lines();
    let mut wrote_any = false;
    for (index, line) in lines.by_ref().enumerate() {
        let prefix = if index == 0 { format!("  [{label}]") } else { "           ".to_owned() };
        rendered.push(format!("{prefix} {}", inline(line)));
        wrote_any = true;
    }

    if !wrote_any {
        rendered.push(format!("  [{label}]"));
    }

    rendered
}

fn format_stream_line(line: BufferedLine) -> String {
    let label = match line.stream {
        StreamKind::Stdout => "stdout",
        StreamKind::Stderr => "stderr",
    };
    format!("  [{label}] {}", inline(&line.text))
}

fn other_stream(stream: StreamKind) -> StreamKind {
    match stream {
        StreamKind::Stdout => StreamKind::Stderr,
        StreamKind::Stderr => StreamKind::Stdout,
    }
}

fn node_status(status: NodeStatus) -> &'static str {
    match status {
        NodeStatus::Pending => "pending",
        NodeStatus::Skipped => "skipped",
        NodeStatus::Succeeded => "succeeded",
        NodeStatus::Failed => "failed",
    }
}

fn run_status(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Running => "running",
        RunStatus::Succeeded => "succeeded",
        RunStatus::Failed => "failed",
    }
}

fn loop_iteration_outcome(outcome: LoopIterationOutcome) -> &'static str {
    match outcome {
        LoopIterationOutcome::Continue => "continue",
        LoopIterationOutcome::Completed => "completed",
        LoopIterationOutcome::Failed => "failed",
    }
}

fn node_label(user_id: Option<&StepId>, node_path: &NodePath) -> String {
    user_id.map_or_else(|| node_path.to_string(), ToString::to_string)
}

fn inline(text: &str) -> String {
    text.trim_end_matches('\n').replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::ProgressFormatter;
    use rigg_core::progress::LiveEvent;
    use rigg_core::{
        FrameId, LoopIterationOutcome, NodePath, NodeStatus, RunReason, RunStatus, StreamKind,
    };

    #[test]
    fn buffers_partial_output_until_line_or_step_end() -> Result<(), Box<dyn std::error::Error>> {
        let output = render(vec![
            LiveEvent::StepOutput { stream: StreamKind::Stdout, chunk: "tick".to_owned() },
            LiveEvent::StepOutput { stream: StreamKind::Stdout, chunk: "tock\n".to_owned() },
            LiveEvent::NodeFinished {
                frame_id: FrameId::root(),
                node_path: NodePath::root_child(0),
                user_id: Some("step".parse()?),
                status: NodeStatus::Succeeded,
                exit_code: Some(0),
                duration_ms: Some(10),
                stdout_path: None,
                stderr_path: None,
            },
        ]);

        assert!(output.contains("[stdout] ticktock"));
        assert!(!output.contains("[stdout] tick\n"));
        assert!(!output.contains("[stdout] tock"));
        Ok(())
    }

    #[test]
    fn flushes_partial_output_before_non_output_events() -> Result<(), Box<dyn std::error::Error>> {
        let output = render(vec![
            LiveEvent::StepOutput { stream: StreamKind::Stderr, chunk: "warn".to_owned() },
            LiveEvent::RunFinished { status: RunStatus::Succeeded, reason: RunReason::Completed },
        ]);

        let warn_index = output
            .find("[stderr] warn")
            .ok_or_else(|| std::io::Error::other("stderr line should be rendered"))?;
        let run_index = output
            .find("[run] status=succeeded")
            .ok_or_else(|| std::io::Error::other("run line should be rendered"))?;
        assert!(warn_index < run_index);
        Ok(())
    }

    #[test]
    fn preserves_arrival_order_for_pending_stdout_and_stderr()
    -> Result<(), Box<dyn std::error::Error>> {
        let output = render(vec![
            LiveEvent::StepOutput { stream: StreamKind::Stderr, chunk: "warn".to_owned() },
            LiveEvent::StepOutput { stream: StreamKind::Stdout, chunk: "info".to_owned() },
            LiveEvent::RunFinished { status: RunStatus::Succeeded, reason: RunReason::Completed },
        ]);

        let stderr_index = output
            .find("[stderr] warn")
            .ok_or_else(|| std::io::Error::other("stderr line should be rendered"))?;
        let stdout_index = output
            .find("[stdout] info")
            .ok_or_else(|| std::io::Error::other("stdout line should be rendered"))?;
        let run_index = output
            .find("[run] status=succeeded")
            .ok_or_else(|| std::io::Error::other("run line should be rendered"))?;
        assert!(stderr_index < stdout_index);
        assert!(stdout_index < run_index);
        Ok(())
    }

    #[test]
    fn flushes_older_partial_output_before_newer_completed_line()
    -> Result<(), Box<dyn std::error::Error>> {
        let output = render(vec![
            LiveEvent::StepOutput { stream: StreamKind::Stdout, chunk: "info".to_owned() },
            LiveEvent::StepOutput { stream: StreamKind::Stderr, chunk: "warn\n".to_owned() },
            LiveEvent::RunFinished { status: RunStatus::Succeeded, reason: RunReason::Completed },
        ]);

        let stdout_index = output
            .find("[stdout] info")
            .ok_or_else(|| std::io::Error::other("stdout line should be rendered"))?;
        let stderr_index = output
            .find("[stderr] warn")
            .ok_or_else(|| std::io::Error::other("stderr line should be rendered"))?;
        let run_index = output
            .find("[run] status=succeeded")
            .ok_or_else(|| std::io::Error::other("run line should be rendered"))?;
        assert!(stdout_index < stderr_index);
        assert!(stderr_index < run_index);
        Ok(())
    }

    #[test]
    fn node_start_output_does_not_render_command_text() -> Result<(), Box<dyn std::error::Error>> {
        let output = render(vec![LiveEvent::NodeStarted {
            frame_id: FrameId::root(),
            node_path: NodePath::root_child(0),
            user_id: Some("step".parse()?),
            node_kind: "shell".to_owned(),
            provider: None,
            attempt: 1,
        }]);

        assert!(output.contains("[start] node=step kind=shell attempt=1"));
        assert!(!output.contains("command="));
        Ok(())
    }

    #[test]
    fn renders_loop_iteration_events() -> Result<(), Box<dyn std::error::Error>> {
        let loop_scope = FrameId::root().child_loop_scope(&NodePath::root_child(0));
        let output = render(vec![
            LiveEvent::LoopIterationStarted {
                frame_id: FrameId::for_loop_iteration(&loop_scope, 1),
                node_path: NodePath::root_child(0),
                user_id: Some("remediation".parse()?),
                iteration: 1,
                max_iterations: 5,
            },
            LiveEvent::LoopIterationFinished {
                frame_id: FrameId::for_loop_iteration(&loop_scope, 1),
                node_path: NodePath::root_child(0),
                user_id: Some("remediation".parse()?),
                iteration: 1,
                max_iterations: 5,
                outcome: LoopIterationOutcome::Continue,
            },
            LiveEvent::LoopIterationFinished {
                frame_id: FrameId::for_loop_iteration(&loop_scope, 2),
                node_path: NodePath::root_child(0),
                user_id: Some("remediation".parse()?),
                iteration: 2,
                max_iterations: 5,
                outcome: LoopIterationOutcome::Completed,
            },
        ]);

        assert!(output.contains("[loop] node=remediation iteration=1/5 status=started"));
        assert!(output.contains("[loop] node=remediation iteration=1/5 status=continue"));
        assert!(output.contains("[loop] node=remediation iteration=2/5 status=completed"));
        Ok(())
    }

    #[test]
    fn renders_branch_selection_events() -> Result<(), Box<dyn std::error::Error>> {
        let output = render(vec![LiveEvent::BranchSelected {
            frame_id: FrameId::root(),
            node_path: NodePath::root_child(0),
            user_id: Some("decide".parse()?),
            case_index: 1,
            selection: rigg_core::BranchSelection::If,
        }]);

        assert!(output.contains("[branch] node=decide case=1 kind=if"));
        Ok(())
    }

    #[test]
    fn preserves_blank_lines_in_output() {
        let output = render(vec![
            LiveEvent::StepOutput {
                stream: StreamKind::Stdout,
                chunk: "\nalpha\n\nbeta\n\n".to_owned(),
            },
            LiveEvent::RunFinished { status: RunStatus::Succeeded, reason: RunReason::Completed },
        ]);

        let stdout_lines =
            output.lines().filter(|line| line.starts_with("  [stdout]")).collect::<Vec<_>>();
        assert_eq!(
            stdout_lines,
            vec![
                "  [stdout] ",
                "  [stdout] alpha",
                "  [stdout] ",
                "  [stdout] beta",
                "  [stdout] ",
            ]
        );
    }

    fn render(events: Vec<LiveEvent>) -> String {
        let mut formatter = ProgressFormatter::default();
        let mut lines = Vec::new();
        for event in events {
            lines.extend(formatter.render(event));
        }
        lines.extend(formatter.flush());
        lines.join("\n")
    }
}
