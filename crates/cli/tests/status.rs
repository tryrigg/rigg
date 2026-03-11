mod common;

use std::error::Error;
use std::fs;

#[test]
fn status_json_ignores_incomplete_run_directories() -> Result<(), Box<dyn Error>> {
    let root = common::temp_root("status-incomplete-run");
    let rigg_dir = root.join(".rigg");
    fs::create_dir_all(&rigg_dir)?;
    fs::write(
        rigg_dir.join("status.yaml"),
        r#"
id: status
steps:
  - id: ok
    type: shell
    with:
      command: printf '%s' 'ok'
"#,
    )?;

    let run_output = common::run(&root, ["run", "status"])?;
    assert!(run_output.status.success(), "run failed: {run_output:?}");

    let broken_run_dir =
        root.join(".rigg").join("runs").join("019cc300-0000-7000-8000-000000000099");
    fs::create_dir_all(&broken_run_dir)?;
    fs::write(
        broken_run_dir.join("meta.json"),
        r#"{"run_id":"019cc300-0000-7000-8000-000000000099"}"#,
    )?;

    let status_output = common::run(&root, ["status", "--json"])?;
    assert!(status_output.status.success(), "status failed: {status_output:?}");

    let status_json: serde_json::Value = serde_json::from_slice(&status_output.stdout)?;
    let runs = status_json.as_array().ok_or("status output should be an array")?;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["workflow_id"], "status");
    Ok(())
}
