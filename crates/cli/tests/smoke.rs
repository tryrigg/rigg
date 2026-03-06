use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn runs_shell_flow_with_outputs_end_to_end() -> Result<(), Box<dyn Error>> {
    let root = temp_root();
    let rigg_dir = root.join(".rigg");
    fs::create_dir_all(&rigg_dir)?;
    fs::write(
        rigg_dir.join("smoke.yaml"),
        r#"
flows:
  smoke:
    steps:
      - id: produce
        type: shell
        with:
          command: printf '%s' '{"count":0}'
        outputs:
          count: integer

      - id: done
        if: ${{ steps.produce.outputs.count == 0 }}
        type: shell
        with:
          command: printf '%s' 'done'

    loop:
      until: ${{ steps.produce.outputs.count == 0 }}
      max: 2
"#,
    )?;

    let validate = run(&root, ["validate"])?;
    assert!(validate.status.success(), "validate failed: {validate:?}");
    assert!(String::from_utf8_lossy(&validate.stdout).contains("Validated 1 flow(s): smoke"));

    let run_output = run(&root, ["run", "smoke"])?;
    assert!(run_output.status.success(), "run failed: {run_output:?}");
    let run_stdout = String::from_utf8_lossy(&run_output.stdout);
    assert!(run_stdout.contains("finished with status Succeeded"));
    let run_id = run_stdout
        .split_whitespace()
        .nth(1)
        .ok_or("run output did not contain a run id")?
        .to_owned();

    let status_output = run(&root, ["status", &run_id, "--json"])?;
    assert!(status_output.status.success(), "status failed: {status_output:?}");
    let status_json: serde_json::Value = serde_json::from_slice(&status_output.stdout)?;
    assert_eq!(status_json[0]["steps"][0]["outputs"]["count"], 0);

    let logs_output = run(&root, ["logs", &run_id])?;
    assert!(logs_output.status.success(), "logs failed: {logs_output:?}");
    assert!(String::from_utf8_lossy(&logs_output.stdout).contains(r#"{"count":0}"#));
    Ok(())
}

#[test]
fn exits_non_zero_when_flow_fails() -> Result<(), Box<dyn Error>> {
    let root = temp_root();
    let rigg_dir = root.join(".rigg");
    fs::create_dir_all(&rigg_dir)?;
    fs::write(
        rigg_dir.join("fail.yaml"),
        r#"
flows:
  fail:
    steps:
      - id: boom
        type: shell
        with:
          command: exit 7
"#,
    )?;

    let output = run(&root, ["run", "fail"])?;
    assert!(!output.status.success(), "expected non-zero exit: {output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("status Failed"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("Reason: StepFailed"));
    Ok(())
}

#[test]
fn init_generates_valid_examples() -> Result<(), Box<dyn Error>> {
    let root = temp_root();
    let init_output = run(&root, ["init"])?;
    assert!(init_output.status.success(), "init failed: {init_output:?}");

    let validate_output = run(&root, ["validate"])?;
    assert!(validate_output.status.success(), "validate failed: {validate_output:?}");
    let stdout = String::from_utf8_lossy(&validate_output.stdout);
    assert!(stdout.contains("plan"));
    assert!(stdout.contains("review-uncommitted"));
    assert!(stdout.contains("review-branch"));
    assert!(stdout.contains("review-commit"));
    Ok(())
}

fn run<'a>(
    cwd: &PathBuf,
    args: impl IntoIterator<Item = &'a str>,
) -> Result<std::process::Output, std::io::Error> {
    Command::new(env!("CARGO_BIN_EXE_rigg")).current_dir(cwd).args(args).output()
}

fn temp_root() -> PathBuf {
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let root = std::env::temp_dir().join(format!("rigg-cli-{suffix}"));
    let _ = fs::create_dir_all(&root);
    root
}
