mod common;

use std::error::Error;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

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

#[test]
fn codex_review_results_are_preserved_in_run_and_status_json() -> Result<(), Box<dyn Error>> {
    #[cfg(not(unix))]
    {
        return Ok(());
    }

    #[cfg(unix)]
    {
        let root = common::temp_root("run-review-json");
        let rigg_dir = root.join(".rigg");
        fs::create_dir_all(&rigg_dir)?;
        fs::write(
            rigg_dir.join("review.yaml"),
            r#"
id: review
steps:
  - id: review
    type: codex
    with:
      action: review
      target: uncommitted
"#,
        )?;

        let codex_path = root.join("codex");
        fs::write(
            &codex_path,
            r#"#!/bin/sh
printf '%s\n' '{"type":"exited_review_mode","review_output":{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"looks good","overall_confidence_score":0.91}}'
"#,
        )?;
        fs::set_permissions(&codex_path, fs::Permissions::from_mode(0o755))?;

        let path = format!("{}:{}", root.display(), std::env::var("PATH").unwrap_or_default());

        let run_output =
            common::run_with_env(&root, ["run", "review", "--json"], [("PATH", path.clone())])?;
        assert!(run_output.status.success(), "run failed: {run_output:?}");

        let run_json: serde_json::Value = serde_json::from_slice(&run_output.stdout)?;
        assert_eq!(run_json["nodes"][0]["result"]["overall_correctness"], "patch is correct");
        assert_eq!(run_json["nodes"][0]["result"]["findings"], serde_json::json!([]));
        assert!(
            run_json["nodes"][0]["stdout_preview"]
                .as_str()
                .unwrap_or_default()
                .contains("\"overall_correctness\":\"patch is correct\"")
        );

        let run_id = run_json["run_id"].as_str().ok_or("run output missing run_id")?.to_owned();
        let status_output =
            common::run_with_env(&root, ["status", &run_id, "--json"], [("PATH", path)])?;
        assert!(status_output.status.success(), "status failed: {status_output:?}");

        let status_json: serde_json::Value = serde_json::from_slice(&status_output.stdout)?;
        assert_eq!(status_json[0]["nodes"][0]["result"]["overall_explanation"], "looks good");

        Ok(())
    }
}
