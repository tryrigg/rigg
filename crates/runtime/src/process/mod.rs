mod decoder;
#[cfg(test)]
mod tests;

use self::decoder::StreamDecoder;
use rigg_core::StreamKind;
use std::ffi::OsString;
use std::fmt;
use std::io;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Debug, Clone)]
pub(crate) struct CommandSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub stdin_text: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct CommandOutput {
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u128,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CommandTimeouts {
    pub hard_timeout: Option<Duration>,
    pub terminate_grace: Duration,
}

impl CommandTimeouts {
    pub(crate) const fn new(hard_timeout: Option<Duration>, terminate_grace: Duration) -> Self {
        Self { hard_timeout, terminate_grace }
    }

    pub(crate) const fn none() -> Self {
        Self { hard_timeout: None, terminate_grace: Duration::from_secs(0) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HardTimeout {
    pub hard_timeout: Duration,
    pub grace_period: Duration,
}

impl fmt::Display for HardTimeout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "step exceeded hard timeout of {}ms", self.hard_timeout.as_millis())
    }
}

#[derive(Debug, Error)]
pub(crate) enum ProgramError {
    #[error("failed to spawn child process")]
    Spawn {
        #[source]
        source: io::Error,
    },
    #[error("missing stdout pipe on spawned child process")]
    MissingStdoutPipe,
    #[error("missing stderr pipe on spawned child process")]
    MissingStderrPipe,
    #[error("failed to {operation}")]
    Io {
        operation: ProgramIoOperation,
        #[source]
        source: io::Error,
    },
    #[error("{timeout}")]
    HardTimeout { timeout: HardTimeout },
}

impl ProgramError {
    fn spawn(source: io::Error) -> Self {
        Self::Spawn { source }
    }

    fn io(operation: ProgramIoOperation, source: io::Error) -> Self {
        Self::Io { operation, source }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgramIoOperation {
    WriteStdin,
    PollExit,
    WaitForExit,
    JoinReaders,
    SendSignal(Signal),
    ReadStdout,
    ReadStderr,
}

impl ProgramIoOperation {
    fn read_stream(stream: StreamKind) -> Self {
        match stream {
            StreamKind::Stdout => Self::ReadStdout,
            StreamKind::Stderr => Self::ReadStderr,
        }
    }
}

impl fmt::Display for ProgramIoOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WriteStdin => f.write_str("write child stdin"),
            Self::PollExit => f.write_str("poll child exit status"),
            Self::WaitForExit => f.write_str("wait for child exit"),
            Self::JoinReaders => f.write_str("join output reader threads"),
            Self::SendSignal(signal) => write!(f, "send {signal} to child process"),
            Self::ReadStdout => f.write_str("read child stdout"),
            Self::ReadStderr => f.write_str("read child stderr"),
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct ShellExecutor;

impl ShellExecutor {
    pub(crate) fn execute(
        &self,
        command: &str,
        cwd: &Path,
        env: &std::collections::BTreeMap<String, String>,
        stdin_text: Option<String>,
        on_output: &mut dyn FnMut(StreamKind, &str),
    ) -> Result<CommandOutput, ProgramError> {
        run_program_streaming(
            CommandSpec {
                program: OsString::from("/bin/sh"),
                args: vec![OsString::from("-lc"), OsString::from(command)],
                stdin_text,
            },
            cwd,
            env,
            CommandTimeouts::none(),
            on_output,
        )
    }
}

#[cfg(test)]
pub(crate) fn run_program(
    spec: CommandSpec,
    cwd: &Path,
    env: &std::collections::BTreeMap<String, String>,
    timeouts: CommandTimeouts,
) -> Result<CommandOutput, ProgramError> {
    let mut noop = |_stream: StreamKind, _chunk: &str| {};
    run_program_streaming(spec, cwd, env, timeouts, &mut noop)
}

pub(crate) fn run_program_streaming(
    spec: CommandSpec,
    cwd: &Path,
    env: &std::collections::BTreeMap<String, String>,
    timeouts: CommandTimeouts,
    on_output: &mut dyn FnMut(StreamKind, &str),
) -> Result<CommandOutput, ProgramError> {
    let started_at = timestamp_now();
    let start = Instant::now();
    let mut child = spawn_child(&spec, cwd, env).map_err(ProgramError::spawn)?;

    if let Some(stdin_text) = spec.stdin_text
        && let Some(mut stdin) = child.stdin.take()
    {
        stdin
            .write_all(stdin_text.as_bytes())
            .map_err(|source| ProgramError::io(ProgramIoOperation::WriteStdin, source))?;
    }

    let (tx, rx) = mpsc::channel();
    let stdout = child.stdout.take().ok_or(ProgramError::MissingStdoutPipe)?;
    let stderr = child.stderr.take().ok_or(ProgramError::MissingStderrPipe)?;

    let mut stdout_reader = Some(spawn_reader(stdout, StreamKind::Stdout, tx.clone()));
    let mut stderr_reader = Some(spawn_reader(stderr, StreamKind::Stderr, tx));

    let mut stdout_text = String::new();
    let mut stderr_text = String::new();
    let mut completed_streams = 0;
    let mut exit_status = None;
    let mut readers_closed = false;
    let mut termination: Option<TerminationState> = None;
    loop {
        if exit_status.is_none()
            && let Some(status) = child
                .try_wait()
                .map_err(|source| ProgramError::io(ProgramIoOperation::PollExit, source))?
        {
            exit_status = Some(status);
        }

        let now = Instant::now();
        if exit_status.is_none() {
            if let Some(active_termination) = termination.as_mut() {
                if !active_termination.kill_sent && now >= active_termination.grace_deadline {
                    kill_child(&mut child)?;
                    active_termination.kill_sent = true;
                }
            } else if let Some(kind) = timeout_kind(timeouts, start, now) {
                match begin_termination(&mut child, kind, now, timeouts.terminate_grace)? {
                    TimeoutDisposition::Exited(status) => exit_status = Some(status),
                    TimeoutDisposition::Terminating(state) => termination = Some(state),
                }
            }
        }

        if exit_status.is_some() && readers_closed {
            break;
        }

        match rx.recv_timeout(RECV_POLL_INTERVAL) {
            Ok(ReaderMessage::Chunk { stream, text }) => {
                append_stream_output(stream, &text, on_output, &mut stdout_text, &mut stderr_text);
            }
            Ok(ReaderMessage::End) => {
                completed_streams += 1;
                readers_closed = completed_streams >= 2;
            }
            Ok(ReaderMessage::Error { stream, error }) => {
                let _ = kill_child(&mut child);
                let _ = child.wait();
                let _ = join_readers(&mut stdout_reader, &mut stderr_reader);
                return Err(ProgramError::io(ProgramIoOperation::read_stream(stream), error));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                readers_closed = true;
                join_readers(&mut stdout_reader, &mut stderr_reader)
                    .map_err(|source| ProgramError::io(ProgramIoOperation::JoinReaders, source))?;
            }
        }
    }

    let output = wait_for_child_exit(&mut child, exit_status)
        .map_err(|source| ProgramError::io(ProgramIoOperation::WaitForExit, source))?;
    join_readers(&mut stdout_reader, &mut stderr_reader)
        .map_err(|source| ProgramError::io(ProgramIoOperation::JoinReaders, source))?;

    if let Some(termination) = termination {
        return Err(termination.kind.into_error(timeouts.terminate_grace));
    }

    let finished_at = timestamp_now();

    Ok(CommandOutput {
        started_at,
        finished_at,
        duration_ms: start.elapsed().as_millis(),
        exit_code: output.code().unwrap_or(-1),
        stdout: stdout_text,
        stderr: stderr_text,
    })
}

fn spawn_child(
    spec: &CommandSpec,
    cwd: &Path,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<Child, std::io::Error> {
    let mut command = Command::new(&spec.program);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .args(&spec.args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(if spec.stdin_text.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    command.spawn()
}

fn wait_for_child_exit(
    child: &mut Child,
    exit_status: Option<ExitStatus>,
) -> Result<ExitStatus, std::io::Error> {
    match exit_status {
        Some(exit_status) => Ok(exit_status),
        None => child.wait(),
    }
}

const RECV_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy)]
enum TimeoutKind {
    Hard { hard_timeout: Duration },
}

impl TimeoutKind {
    fn into_error(self, grace_period: Duration) -> ProgramError {
        match self {
            Self::Hard { hard_timeout } => {
                ProgramError::HardTimeout { timeout: HardTimeout { hard_timeout, grace_period } }
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct TerminationState {
    kind: TimeoutKind,
    grace_deadline: Instant,
    kill_sent: bool,
}

fn timeout_kind(timeouts: CommandTimeouts, start: Instant, now: Instant) -> Option<TimeoutKind> {
    if let Some(hard_timeout) = timeouts.hard_timeout
        && now.saturating_duration_since(start) >= hard_timeout
    {
        return Some(TimeoutKind::Hard { hard_timeout });
    }

    None
}

fn kill_child(child: &mut Child) -> Result<(), ProgramError> {
    send_signal_ignoring_missing(child, Signal::Kill)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Signal {
    Terminate,
    Kill,
}

impl fmt::Display for Signal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Terminate => f.write_str("SIGTERM"),
            Self::Kill => f.write_str("SIGKILL"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalDelivery {
    Delivered,
    Missing,
}

#[derive(Debug)]
enum TimeoutDisposition {
    Exited(ExitStatus),
    Terminating(TerminationState),
}

fn begin_termination(
    child: &mut Child,
    kind: TimeoutKind,
    now: Instant,
    terminate_grace: Duration,
) -> Result<TimeoutDisposition, ProgramError> {
    match send_signal(child, Signal::Terminate).map_err(|source| {
        ProgramError::io(ProgramIoOperation::SendSignal(Signal::Terminate), source)
    })? {
        SignalDelivery::Delivered => {
            Ok(TimeoutDisposition::Terminating(termination_state(kind, now, terminate_grace)))
        }
        SignalDelivery::Missing => match child
            .try_wait()
            .map_err(|source| ProgramError::io(ProgramIoOperation::PollExit, source))?
        {
            Some(status) => Ok(TimeoutDisposition::Exited(status)),
            None => {
                Ok(TimeoutDisposition::Terminating(termination_state(kind, now, terminate_grace)))
            }
        },
    }
}

fn termination_state(
    kind: TimeoutKind,
    now: Instant,
    terminate_grace: Duration,
) -> TerminationState {
    TerminationState { kind, grace_deadline: now + terminate_grace, kill_sent: false }
}

fn send_signal_ignoring_missing(child: &mut Child, signal: Signal) -> Result<(), ProgramError> {
    match send_signal(child, signal)
        .map_err(|source| ProgramError::io(ProgramIoOperation::SendSignal(signal), source))?
    {
        SignalDelivery::Delivered | SignalDelivery::Missing => Ok(()),
    }
}

#[cfg(unix)]
fn send_signal(child: &mut Child, signal: Signal) -> io::Result<SignalDelivery> {
    let signal = match signal {
        Signal::Terminate => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    let process_group = -(child.id() as libc::pid_t);
    let result = unsafe { libc::kill(process_group, signal) };
    if result == 0 {
        return Ok(SignalDelivery::Delivered);
    }

    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) { Ok(SignalDelivery::Missing) } else { Err(error) }
}

#[cfg(not(unix))]
fn send_signal(child: &mut Child, _signal: Signal) -> io::Result<SignalDelivery> {
    match child.kill() {
        Ok(()) => Ok(SignalDelivery::Delivered),
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => Ok(SignalDelivery::Missing),
        Err(error) => Err(error),
    }
}

fn append_stream_output(
    stream: StreamKind,
    text: &str,
    on_output: &mut dyn FnMut(StreamKind, &str),
    stdout: &mut String,
    stderr: &mut String,
) {
    if text.is_empty() {
        return;
    }

    on_output(stream, text);
    match stream {
        StreamKind::Stdout => stdout.push_str(text),
        StreamKind::Stderr => stderr.push_str(text),
    }
}

enum ReaderMessage {
    Chunk { stream: StreamKind, text: String },
    End,
    Error { stream: StreamKind, error: io::Error },
}

fn spawn_reader(
    stream: impl std::io::Read + Send + 'static,
    kind: StreamKind,
    tx: mpsc::Sender<ReaderMessage>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut stream = stream;
        let mut decoder = StreamDecoder::default();
        let mut buffer = [0_u8; 4096];
        loop {
            let bytes = match stream.read(&mut buffer) {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = tx.send(ReaderMessage::Error {
                        stream: kind,
                        error: io::Error::new(error.kind(), error.to_string()),
                    });
                    return;
                }
            };
            if bytes == 0 {
                break;
            }
            let text = decoder.push(&buffer[..bytes]);
            if text.is_empty() {
                continue;
            }
            if tx.send(ReaderMessage::Chunk { stream: kind, text }).is_err() {
                return;
            }
        }
        let remaining = decoder.finish();
        if !remaining.is_empty()
            && tx.send(ReaderMessage::Chunk { stream: kind, text: remaining }).is_err()
        {
            return;
        }
        let _ = tx.send(ReaderMessage::End);
    })
}

fn join_reader(handle: Option<thread::JoinHandle<()>>) -> Result<(), std::io::Error> {
    let Some(handle) = handle else {
        return Ok(());
    };

    match handle.join() {
        Ok(()) => Ok(()),
        Err(_) => Err(std::io::Error::other("process output reader thread panicked")),
    }
}

fn join_readers(
    stdout_reader: &mut Option<thread::JoinHandle<()>>,
    stderr_reader: &mut Option<thread::JoinHandle<()>>,
) -> Result<(), std::io::Error> {
    let stdout_result = join_reader(stdout_reader.take());
    let stderr_result = join_reader(stderr_reader.take());
    stdout_result.and(stderr_result)
}

fn timestamp_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}
