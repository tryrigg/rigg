use super::super::{
    CommandOutput, CommandSpec, CommandTimeouts, ProgramError, run_program, run_program_streaming,
};
use rigg_core::StreamKind;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Read};

pub(super) struct FailingReader;

impl Read for FailingReader {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("boom"))
    }
}

fn command(program: &str, args: &[&str]) -> CommandSpec {
    CommandSpec {
        program: OsString::from(program),
        args: args.iter().map(OsString::from).collect(),
        stdin_text: None,
    }
}

pub(super) fn shell(script: &str) -> CommandSpec {
    command("/bin/sh", &["-c", script])
}

pub(super) fn printf_arg(format: &str, value: &str) -> CommandSpec {
    command("/usr/bin/printf", &[format, value])
}

pub(super) fn run_streaming(
    spec: CommandSpec,
    timeouts: CommandTimeouts,
    on_output: &mut dyn FnMut(StreamKind, &str),
) -> Result<CommandOutput, ProgramError> {
    run_program_streaming(spec, &std::env::temp_dir(), &BTreeMap::new(), timeouts, on_output)
}

pub(super) fn run_non_streaming(
    spec: CommandSpec,
    timeouts: CommandTimeouts,
) -> Result<CommandOutput, ProgramError> {
    run_program(spec, &std::env::temp_dir(), &BTreeMap::new(), timeouts)
}

pub(super) fn check_timeout_error(script: &str, timeouts: CommandTimeouts) -> ProgramError {
    run_streaming(shell(script), timeouts, &mut |_stream, _chunk| {})
        .expect_err("timeout should terminate the child process")
}
