mod fixture;

use super::{
    CommandTimeouts, ProgramError, ReaderMessage, TimeoutDisposition, TimeoutKind,
    begin_termination, spawn_reader,
};
use fixture::{
    FailingReader, check_timeout_error, printf_arg, run_non_streaming, run_streaming, shell,
};
use rigg_core::StreamKind;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[test]
fn streaming_accepts_non_utf8_stdout() -> Result<(), Box<dyn std::error::Error>> {
    let mut chunks = Vec::new();
    let output =
        run_streaming(printf_arg("%b", "\\377"), CommandTimeouts::none(), &mut |stream, chunk| {
            chunks.push((stream, chunk.to_owned()))
        })?;

    assert_eq!(output.stdout, char::REPLACEMENT_CHARACTER.to_string());
    assert_eq!(chunks, vec![(StreamKind::Stdout, char::REPLACEMENT_CHARACTER.to_string())]);
    Ok(())
}

#[test]
fn streaming_emits_partial_lines_before_exit() -> Result<(), Box<dyn std::error::Error>> {
    let (first_chunk_tx, first_chunk_rx) = mpsc::channel();
    let (chunk_tx, chunk_rx) = mpsc::channel();

    let handle = thread::spawn(move || {
        let mut first_chunk_tx = Some(first_chunk_tx);
        run_streaming(
            shell("printf tick; sleep 1; printf tock"),
            CommandTimeouts::none(),
            &mut |stream, chunk| {
                if stream == StreamKind::Stdout {
                    let _ = chunk_tx.send(chunk.to_owned());
                    if let Some(tx) = first_chunk_tx.take() {
                        let _ = tx.send(());
                    }
                }
            },
        )
    });

    first_chunk_rx.recv_timeout(Duration::from_millis(250))?;

    let mut observed = String::new();
    while let Ok(chunk) = chunk_rx.try_recv() {
        observed.push_str(&chunk);
    }

    assert_eq!(observed, "tick");

    let output =
        handle.join().map_err(|_| io::Error::other("streaming test thread panicked"))??;
    assert_eq!(output.stdout, "ticktock");
    Ok(())
}

#[test]
fn run_program_captures_stdout_without_streaming_callback() -> Result<(), Box<dyn std::error::Error>>
{
    let output = run_non_streaming(printf_arg("%s", "hello"), CommandTimeouts::none())?;

    assert_eq!(output.stdout, "hello");
    Ok(())
}

#[test]
fn finished_process_drains_output_after_exit() -> Result<(), Box<dyn std::error::Error>> {
    let chunk = "x".repeat(1024);
    let repetitions = 256;
    let payload = chunk.repeat(repetitions);
    let temp_root = std::env::temp_dir().join(format!(
        "rigg-runtime-process-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
    ));
    fs::create_dir_all(&temp_root)?;
    let exit_marker = temp_root.join("child-exited");
    let trap_command = format!("touch {}", shell_single_quote_path(&exit_marker));
    let script = format!(
        "trap {} EXIT; i=0; while [ \"$i\" -lt {repetitions} ]; do printf '%s' '{chunk}'; i=$((i + 1)); done",
        shell_single_quote_string(&trap_command)
    );
    let mut stdout_chunks_after_exit = 0_usize;
    let output = run_streaming(shell(&script), CommandTimeouts::none(), &mut |stream, _chunk| {
        if stream == StreamKind::Stdout {
            if exit_marker.exists() {
                stdout_chunks_after_exit += 1;
            }
            thread::sleep(Duration::from_millis(10));
        }
    })?;

    assert_eq!(output.stdout.len(), payload.len());
    assert_eq!(output.stdout, payload);
    assert!(
        stdout_chunks_after_exit > 0,
        "expected to keep draining stdout after the child exited"
    );
    let _ = fs::remove_dir_all(&temp_root);
    Ok(())
}

fn shell_single_quote_path(path: &Path) -> String {
    shell_single_quote_string(&path.as_os_str().to_string_lossy())
}

fn shell_single_quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[test]
fn spawn_reader_reports_io_errors() -> Result<(), Box<dyn std::error::Error>> {
    let (tx, rx) = mpsc::channel();
    let handle = spawn_reader(FailingReader, StreamKind::Stdout, tx);

    match rx.recv_timeout(Duration::from_millis(250))? {
        ReaderMessage::Error { stream, error } => {
            assert_eq!(stream, StreamKind::Stdout);
            assert_eq!(error.kind(), ErrorKind::Other);
            assert!(error.to_string().contains("boom"));
        }
        ReaderMessage::Chunk { .. } => {
            return Err("reader unexpectedly produced a chunk".into());
        }
        ReaderMessage::End => return Err("reader unexpectedly reached EOF".into()),
    }

    handle.join().map_err(|_| io::Error::other("reader test thread panicked"))?;
    Ok(())
}

#[test]
fn streaming_times_out_when_hard_deadline_is_exceeded() -> Result<(), Box<dyn std::error::Error>> {
    let error = check_timeout_error(
        "while :; do printf x; sleep 0.05; done",
        CommandTimeouts::new(Some(Duration::from_millis(250)), Duration::from_millis(50)),
    );

    match error {
        ProgramError::HardTimeout { timeout } => {
            assert_eq!(timeout.hard_timeout, Duration::from_millis(250));
            assert_eq!(timeout.grace_period, Duration::from_millis(50));
        }
        other => return Err(format!("unexpected error: {other:?}").into()),
    }

    Ok(())
}

#[test]
fn begin_termination_treats_exited_child_as_completed() -> Result<(), Box<dyn std::error::Error>> {
    let mut child = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("exit 0")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    thread::sleep(Duration::from_millis(20));

    match begin_termination(
        &mut child,
        TimeoutKind::Hard { hard_timeout: Duration::from_millis(1) },
        std::time::Instant::now(),
        Duration::from_millis(50),
    )? {
        TimeoutDisposition::Exited(status) => assert!(status.success()),
        TimeoutDisposition::Terminating(_) => {
            return Err("exited child should not enter timeout termination".into());
        }
    }

    Ok(())
}
