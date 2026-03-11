use super::format::ProgressFormatter;
use rigg_core::conversation::ConversationProvider;
use rigg_core::progress::{LiveEvent, ProgressSink};
use rigg_core::{FrameId, NodePath, StepId};
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use unicode_width::UnicodeWidthChar;

const TICK_INTERVAL: Duration = Duration::from_millis(100);
const SPINNER_FRAMES: [&str; 4] = ["|", "/", "-", "\\"];
const DEFAULT_TERMINAL_WIDTH: usize = 80;

pub(super) struct TerminalProgressSink {
    sender: mpsc::SyncSender<ProgressCommand>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TerminalProgressSink {
    pub(super) fn new<W>(writer: W) -> Self
    where
        W: Write + Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(0);
        let terminal_width = terminal_width().unwrap_or(DEFAULT_TERMINAL_WIDTH);
        let handle =
            thread::spawn(move || TerminalRenderer::new(writer, terminal_width).run(receiver));
        Self { sender, handle: Some(handle) }
    }

    #[cfg(test)]
    fn new_with_width<W>(writer: W, terminal_width: usize) -> Self
    where
        W: Write + Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(0);
        let handle =
            thread::spawn(move || TerminalRenderer::new(writer, terminal_width).run(receiver));
        Self { sender, handle: Some(handle) }
    }
}

impl ProgressSink for TerminalProgressSink {
    fn is_enabled(&self) -> bool {
        true
    }

    fn emit(&mut self, event: LiveEvent) {
        let _ = self.sender.send(ProgressCommand::Event(event));
    }
}

impl Drop for TerminalProgressSink {
    fn drop(&mut self) {
        let _ = self.sender.send(ProgressCommand::Finish);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

enum ProgressCommand {
    Event(LiveEvent),
    Finish,
}

struct TerminalRenderer<W> {
    writer: W,
    formatter: ProgressFormatter,
    active_nodes: BTreeMap<String, ActiveNode>,
    last_active_key: Option<String>,
    run_started_at: Instant,
    spinner_index: usize,
    footer_visible: bool,
    footer_rows: usize,
    terminal_width: usize,
}

impl<W: Write> TerminalRenderer<W> {
    fn new(writer: W, terminal_width: usize) -> Self {
        Self {
            writer,
            formatter: ProgressFormatter::default(),
            active_nodes: BTreeMap::new(),
            last_active_key: None,
            run_started_at: Instant::now(),
            spinner_index: 0,
            footer_visible: false,
            footer_rows: 0,
            terminal_width: terminal_width.max(1),
        }
    }

    fn run(mut self, receiver: mpsc::Receiver<ProgressCommand>) {
        loop {
            match receiver.recv_timeout(TICK_INTERVAL) {
                Ok(ProgressCommand::Event(event)) => self.handle_event(event),
                Ok(ProgressCommand::Finish) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => self.tick(),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        self.finish();
    }

    fn handle_event(&mut self, event: LiveEvent) {
        self.update_state(&event);
        let lines = self.formatter.render(event);
        if lines.is_empty() {
            self.draw_footer();
            return;
        }
        self.clear_footer();
        for line in lines {
            let _ = writeln!(self.writer, "{line}");
        }
        let _ = self.writer.flush();
        self.draw_footer();
    }

    fn tick(&mut self) {
        if self.active_nodes.is_empty() {
            self.clear_footer();
            return;
        }
        self.spinner_index = (self.spinner_index + 1) % SPINNER_FRAMES.len();
        self.draw_footer();
    }

    fn finish(&mut self) {
        let lines = self.formatter.flush();
        if !lines.is_empty() {
            self.clear_footer();
            for line in lines {
                let _ = writeln!(self.writer, "{line}");
            }
        }
        self.active_nodes.clear();
        self.last_active_key = None;
        self.clear_footer();
        let _ = self.writer.flush();
    }

    fn update_state(&mut self, event: &LiveEvent) {
        match event {
            LiveEvent::RunStarted { .. } => {
                self.run_started_at = Instant::now();
                self.spinner_index = 0;
            }
            LiveEvent::NodeStarted {
                frame_id, node_path, user_id, node_kind, provider, ..
            } => {
                let key = active_key(frame_id, node_path);
                self.last_active_key = Some(key.clone());
                self.active_nodes.insert(
                    key,
                    ActiveNode {
                        label: node_label(user_id.as_ref(), node_path),
                        node_kind: node_kind.clone(),
                        provider: *provider,
                        last_tool: None,
                        last_status: None,
                    },
                );
            }
            LiveEvent::NodeFinished { frame_id, node_path, .. }
            | LiveEvent::NodeSkipped { frame_id, node_path, .. } => {
                let key = active_key(frame_id, node_path);
                self.active_nodes.remove(&key);
                if self.last_active_key.as_deref() == Some(key.as_str()) {
                    self.last_active_key = self.active_nodes.keys().next_back().cloned();
                }
            }
            LiveEvent::ProviderToolUse { frame_id, node_path, user_id, provider, tool, detail } => {
                let state =
                    self.ensure_active_node(frame_id, node_path, user_id.as_ref(), Some(*provider));
                state.provider = Some(*provider);
                state.last_tool = Some(compact_tool_message(tool, detail.as_deref()));
                self.last_active_key = Some(active_key(frame_id, node_path));
            }
            LiveEvent::ProviderStatus { frame_id, node_path, user_id, provider, message } => {
                let Some(status) = compact_status_message(*provider, message) else {
                    return;
                };
                let state =
                    self.ensure_active_node(frame_id, node_path, user_id.as_ref(), Some(*provider));
                state.provider = Some(*provider);
                state.last_status = Some(status);
                self.last_active_key = Some(active_key(frame_id, node_path));
            }
            LiveEvent::ProviderError { frame_id, node_path, user_id, provider, message } => {
                let state =
                    self.ensure_active_node(frame_id, node_path, user_id.as_ref(), Some(*provider));
                state.provider = Some(*provider);
                state.last_status = Some(compact_text(message));
                self.last_active_key = Some(active_key(frame_id, node_path));
            }
            LiveEvent::RunFinished { .. } => {
                self.active_nodes.clear();
                self.last_active_key = None;
            }
            LiveEvent::BranchSelected { .. }
            | LiveEvent::LoopIterationStarted { .. }
            | LiveEvent::LoopIterationFinished { .. }
            | LiveEvent::StepOutput { .. } => {}
        }
    }

    fn ensure_active_node(
        &mut self,
        frame_id: &FrameId,
        node_path: &NodePath,
        user_id: Option<&StepId>,
        provider: Option<ConversationProvider>,
    ) -> &mut ActiveNode {
        let key = active_key(frame_id, node_path);
        self.active_nodes.entry(key).or_insert_with(|| ActiveNode {
            label: node_label(user_id, node_path),
            node_kind: default_node_kind(provider),
            provider,
            last_tool: None,
            last_status: None,
        })
    }

    fn draw_footer(&mut self) {
        let Some(line) = self.footer_line() else {
            self.clear_footer();
            return;
        };
        if self.footer_visible {
            self.clear_footer();
        }
        let _ = write!(self.writer, "\r\x1b[2K{line}");
        let _ = self.writer.flush();
        self.footer_visible = true;
        self.footer_rows = wrapped_line_count(&line, self.terminal_width);
    }

    fn clear_footer(&mut self) {
        if !self.footer_visible {
            return;
        }
        let _ = write!(self.writer, "\r\x1b[2K");
        for _ in 1..self.footer_rows {
            let _ = write!(self.writer, "\x1b[1A\r\x1b[2K");
        }
        let _ = self.writer.flush();
        self.footer_visible = false;
        self.footer_rows = 0;
    }

    fn footer_line(&self) -> Option<String> {
        let active_key = self
            .last_active_key
            .as_ref()
            .and_then(|key| self.active_nodes.get_key_value(key))
            .or_else(|| self.active_nodes.iter().next_back())?;
        let active = active_key.1;
        let mut parts = Vec::new();
        parts.push(format!(
            "[{}] running {}{}",
            SPINNER_FRAMES[self.spinner_index],
            active.label,
            match self.active_nodes.len().checked_sub(1) {
                Some(0) | None => String::new(),
                Some(extra) => format!(" (+{extra} more)"),
            }
        ));
        parts.push(
            active
                .provider
                .map(|provider| provider.to_string())
                .unwrap_or_else(|| active.node_kind.clone()),
        );
        if let Some(status) = &active.last_status {
            parts.push(status.clone());
        }
        if let Some(tool) = &active.last_tool {
            parts.push(format!("tool: {tool}"));
        }
        parts.push(format!("{}s", self.run_started_at.elapsed().as_secs()));
        Some(compact_text(&parts.join(" | ")))
    }
}

#[derive(Debug, Clone)]
struct ActiveNode {
    label: String,
    node_kind: String,
    provider: Option<ConversationProvider>,
    last_tool: Option<String>,
    last_status: Option<String>,
}

fn active_key(frame_id: &FrameId, node_path: &NodePath) -> String {
    format!("{frame_id}:{node_path}")
}

fn node_label(user_id: Option<&StepId>, node_path: &NodePath) -> String {
    user_id.map_or_else(|| node_path.to_string(), ToString::to_string)
}

fn default_node_kind(provider: Option<ConversationProvider>) -> String {
    provider.map(|provider| provider.to_string()).unwrap_or_else(|| "step".to_owned())
}

fn compact_tool_message(tool: &str, detail: Option<&str>) -> String {
    match detail.map(compact_text) {
        Some(detail) if !detail.is_empty() => compact_text(&format!("{tool} {detail}")),
        _ => tool.to_owned(),
    }
}

fn compact_status_message(provider: ConversationProvider, message: &str) -> Option<String> {
    let compact = compact_text(message);
    if compact.is_empty() {
        return None;
    }
    match provider {
        ConversationProvider::Codex => {
            if compact.starts_with("thread started ")
                || compact == "turn started"
                || compact.starts_with("turn completed ")
                || compact.starts_with("turn completed")
                || compact.starts_with("**")
            {
                return None;
            }
        }
        ConversationProvider::Claude => {
            if compact.starts_with("system task_progress") || compact.starts_with("thinking ") {
                return None;
            }
        }
    }
    Some(compact)
}

fn compact_text(text: &str) -> String {
    let single_line =
        text.lines().filter(|line| !line.trim().is_empty()).collect::<Vec<_>>().join(" ");
    let compact = single_line.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut truncated = compact.chars().take(96).collect::<String>();
    if compact.chars().count() > 96 {
        truncated.push_str("...");
    }
    truncated
}

fn wrapped_line_count(text: &str, terminal_width: usize) -> usize {
    let width = terminal_width.max(1);
    let display_width = text.chars().map(|ch| ch.width().unwrap_or(0)).sum::<usize>();
    display_width.saturating_sub(1) / width + 1
}

fn terminal_width() -> Option<usize> {
    #[cfg(unix)]
    {
        let mut winsize = libc::winsize { ws_row: 0, ws_col: 0, ws_xpixel: 0, ws_ypixel: 0 };
        let result = unsafe { libc::ioctl(libc::STDERR_FILENO, libc::TIOCGWINSZ, &mut winsize) };
        if result == 0 && winsize.ws_col > 0 {
            return Some(usize::from(winsize.ws_col));
        }
    }

    std::env::var("COLUMNS").ok()?.parse::<usize>().ok().filter(|width| *width > 0)
}

#[cfg(test)]
mod tests {
    use super::{TerminalProgressSink, wrapped_line_count};
    use rigg_core::conversation::ConversationProvider;
    use rigg_core::progress::{LiveEvent, ProgressSink};
    use rigg_core::{FrameId, NodePath, RunId, RunReason, RunStatus, StreamKind};

    use std::io::{Result as IoResult, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn keeps_provider_status_out_of_durable_log() -> Result<(), Box<dyn std::error::Error>> {
        let writer = SharedBuffer::default();
        let snapshot = writer.snapshot();
        {
            let mut sink = TerminalProgressSink::new(writer);
            sink.emit(LiveEvent::RunStarted {
                run_id: RunId::new(),
                workflow_id: "demo".parse()?,
                node_count: 1,
            });
            sink.emit(LiveEvent::NodeStarted {
                frame_id: FrameId::root(),
                node_path: NodePath::root_child(0),
                user_id: Some("draft".parse()?),
                node_kind: "codex".to_owned(),
                provider: Some(ConversationProvider::Codex),
                attempt: 1,
            });
            sink.emit(LiveEvent::ProviderStatus {
                frame_id: FrameId::root(),
                node_path: NodePath::root_child(0),
                user_id: Some("draft".parse()?),
                provider: ConversationProvider::Codex,
                message: "thread started abc".to_owned(),
            });
            sink.emit(LiveEvent::ProviderError {
                frame_id: FrameId::root(),
                node_path: NodePath::root_child(0),
                user_id: Some("draft".parse()?),
                provider: ConversationProvider::Codex,
                message: "Authentication failed".to_owned(),
            });
            sink.emit(LiveEvent::RunFinished {
                status: RunStatus::Succeeded,
                reason: RunReason::Completed,
            });
        }

        let output = String::from_utf8(
            snapshot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
        )?;
        assert!(!output.contains("thread started abc"));
        assert!(output.contains("Authentication failed"));
        Ok(())
    }

    #[test]
    fn redraws_footer_while_waiting_for_more_events() -> Result<(), Box<dyn std::error::Error>> {
        let writer = SharedBuffer::default();
        let snapshot = writer.snapshot();
        {
            let mut sink = TerminalProgressSink::new(writer);
            sink.emit(LiveEvent::RunStarted {
                run_id: RunId::new(),
                workflow_id: "demo".parse()?,
                node_count: 1,
            });
            sink.emit(LiveEvent::NodeStarted {
                frame_id: FrameId::root(),
                node_path: NodePath::root_child(0),
                user_id: Some("draft".parse()?),
                node_kind: "codex".to_owned(),
                provider: Some(ConversationProvider::Codex),
                attempt: 1,
            });
            std::thread::sleep(Duration::from_millis(260));
            sink.emit(LiveEvent::RunFinished {
                status: RunStatus::Succeeded,
                reason: RunReason::Completed,
            });
        }

        let output = String::from_utf8(
            snapshot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
        )?;
        let redraws = output.matches("\u{1b}[2K[").count();
        assert!(redraws >= 2, "expected footer redraws, got output: {output}");
        Ok(())
    }

    #[test]
    fn clears_wrapped_footer_rows_before_redraw() -> Result<(), Box<dyn std::error::Error>> {
        let writer = SharedBuffer::default();
        let snapshot = writer.snapshot();
        {
            let mut sink = TerminalProgressSink::new_with_width(writer, 20);
            sink.emit(LiveEvent::RunStarted {
                run_id: RunId::new(),
                workflow_id: "demo".parse()?,
                node_count: 1,
            });
            sink.emit(LiveEvent::NodeStarted {
                frame_id: FrameId::root(),
                node_path: NodePath::root_child(0),
                user_id: Some("draft".parse()?),
                node_kind: "codex".to_owned(),
                provider: Some(ConversationProvider::Codex),
                attempt: 1,
            });
            std::thread::sleep(Duration::from_millis(260));
            sink.emit(LiveEvent::RunFinished {
                status: RunStatus::Succeeded,
                reason: RunReason::Completed,
            });
        }

        let output = String::from_utf8(
            snapshot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
        )?;
        assert!(
            output.contains("\u{1b}[1A\r\u{1b}[2K"),
            "expected wrapped footer rows to be cleared, got output: {output}"
        );
        Ok(())
    }

    #[test]
    fn wrapped_line_count_uses_display_width_for_wide_text() {
        assert_eq!(wrapped_line_count("あ".repeat(11).as_str(), 20), 2);
        assert_eq!(wrapped_line_count("draft🙂draft🙂", 10), 2);
    }

    #[test]
    fn clears_wide_character_footer_rows_before_redraw() -> Result<(), Box<dyn std::error::Error>> {
        let writer = SharedBuffer::default();
        let snapshot = writer.snapshot();
        {
            let mut sink = TerminalProgressSink::new_with_width(writer, 20);
            sink.emit(LiveEvent::RunStarted {
                run_id: RunId::new(),
                workflow_id: "demo".parse()?,
                node_count: 1,
            });
            sink.emit(LiveEvent::NodeStarted {
                frame_id: FrameId::root(),
                node_path: NodePath::root_child(0),
                user_id: Some("draft".parse()?),
                node_kind: "codex".to_owned(),
                provider: Some(ConversationProvider::Codex),
                attempt: 1,
            });
            sink.emit(LiveEvent::ProviderStatus {
                frame_id: FrameId::root(),
                node_path: NodePath::root_child(0),
                user_id: Some("draft".parse()?),
                provider: ConversationProvider::Codex,
                message: "レビュー修正🙂 完了しました".to_owned(),
            });
            std::thread::sleep(Duration::from_millis(260));
            sink.emit(LiveEvent::RunFinished {
                status: RunStatus::Succeeded,
                reason: RunReason::Completed,
            });
        }

        let output = String::from_utf8(
            snapshot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
        )?;
        assert!(
            output.contains("\u{1b}[1A\r\u{1b}[2K"),
            "expected wide wrapped footer rows to be cleared, got output: {output}"
        );
        Ok(())
    }

    #[test]
    fn still_writes_stream_output_to_durable_log() -> Result<(), Box<dyn std::error::Error>> {
        let writer = SharedBuffer::default();
        let snapshot = writer.snapshot();
        {
            let mut sink = TerminalProgressSink::new(writer);
            sink.emit(LiveEvent::StepOutput {
                stream: StreamKind::Stdout,
                chunk: "hello\n".to_owned(),
            });
            sink.emit(LiveEvent::RunFinished {
                status: RunStatus::Succeeded,
                reason: RunReason::Completed,
            });
        }

        let output = String::from_utf8(
            snapshot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
        )?;
        assert!(output.contains("[stdout] hello"));
        assert!(output.contains("[run] status=succeeded reason=completed"));
        Ok(())
    }

    #[test]
    fn applies_backpressure_when_renderer_is_busy() -> Result<(), Box<dyn std::error::Error>> {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let writer = BlockingWriter::new(started_tx, release_rx);

        let handle = std::thread::spawn(move || {
            let mut sink = TerminalProgressSink::new(writer);
            sink.emit(LiveEvent::StepOutput {
                stream: StreamKind::Stdout,
                chunk: "hello\n".to_owned(),
            });
            sink.emit(LiveEvent::RunFinished {
                status: RunStatus::Succeeded,
                reason: RunReason::Completed,
            });
            drop(sink);
            let _ = done_tx.send(());
        });

        started_rx.recv_timeout(Duration::from_secs(1)).map_err(std::io::Error::other)?;
        assert!(
            done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "emits should block until the renderer drains the prior event"
        );

        release_tx.send(()).map_err(std::io::Error::other)?;
        done_rx.recv_timeout(Duration::from_secs(1)).map_err(std::io::Error::other)?;
        handle.join().map_err(|_| std::io::Error::other("sink thread should join cleanly"))?;
        Ok(())
    }

    #[derive(Debug, Clone, Default)]
    struct SharedBuffer {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl SharedBuffer {
        fn snapshot(&self) -> Arc<Mutex<Vec<u8>>> {
            self.bytes.clone()
        }
    }

    impl Write for SharedBuffer {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            self.bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> IoResult<()> {
            Ok(())
        }
    }

    #[derive(Debug)]
    struct BlockingWriter {
        write_started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        blocked: AtomicBool,
    }

    impl BlockingWriter {
        fn new(write_started: mpsc::Sender<()>, release: mpsc::Receiver<()>) -> Self {
            Self { write_started, release, blocked: AtomicBool::new(false) }
        }
    }

    impl Write for BlockingWriter {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            if !self.blocked.swap(true, Ordering::SeqCst) {
                let _ = self.write_started.send(());
                self.release
                    .recv()
                    .map_err(|_| std::io::Error::other("test should release blocked writer"))?;
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> IoResult<()> {
            Ok(())
        }
    }
}
