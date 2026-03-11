mod common;

use std::error::Error;
use std::fs;

#[test]
fn runs_shell_workflow_with_result_end_to_end() -> Result<(), Box<dyn Error>> {
    let root = common::temp_root("run-workflow");
    let rigg_dir = root.join(".rigg");
    fs::create_dir_all(&rigg_dir)?;
    fs::write(
        rigg_dir.join("smoke.yaml"),
        r#"
id: smoke
steps:
  - id: produce
    type: shell
    with:
      command: printf '%s' '{"count":0}'
      result: json

  - id: done
    if: ${{ steps.produce.result.count == 0 }}
    type: shell
    with:
      command: printf '%s' 'done'
"#,
    )?;

    let validate = common::run(&root, ["validate"])?;
    assert!(validate.status.success(), "validate failed: {validate:?}");
    assert!(String::from_utf8_lossy(&validate.stdout).contains("Validated 1 workflow(s): smoke"));

    let run_output = common::run(&root, ["run", "smoke"])?;
    assert!(run_output.status.success(), "run failed: {run_output:?}");
    let run_stdout = String::from_utf8_lossy(&run_output.stdout);
    assert!(run_stdout.contains("finished with status Succeeded"));
    let run_id = run_stdout
        .split_whitespace()
        .nth(1)
        .ok_or("run output did not contain a run id")?
        .to_owned();

    let status_output = common::run(&root, ["status", &run_id, "--json"])?;
    assert!(status_output.status.success(), "status failed: {status_output:?}");
    let status_json: serde_json::Value = serde_json::from_slice(&status_output.stdout)?;
    assert_eq!(status_json[0]["nodes"][0]["result"]["count"], 0);

    let logs_output = common::run(&root, ["logs", &run_id])?;
    assert!(logs_output.status.success(), "logs failed: {logs_output:?}");
    assert!(String::from_utf8_lossy(&logs_output.stdout).contains(r#"{"count":0}"#));
    Ok(())
}

#[test]
fn json_run_keeps_stderr_clean() -> Result<(), Box<dyn Error>> {
    let root = common::temp_root("run-json");
    let rigg_dir = root.join(".rigg");
    fs::create_dir_all(&rigg_dir)?;
    fs::write(
        rigg_dir.join("json.yaml"),
        r#"
id: json
steps:
  - id: produce
    type: shell
    with:
      command: printf 'line one\nline two\n'
"#,
    )?;

    let output = common::run(&root, ["run", "json", "--json"])?;
    assert!(output.status.success(), "json run failed: {output:?}");

    let stdout_json: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(stdout_json["workflow_id"], "json");
    assert!(output.stderr.is_empty(), "stderr should stay empty: {output:?}");
    Ok(())
}
