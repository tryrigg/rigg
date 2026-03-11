mod common;

use std::error::Error;
use std::fs;

#[test]
fn exits_non_zero_when_workflow_fails() -> Result<(), Box<dyn Error>> {
    let root = common::temp_root("run-failure");
    let rigg_dir = root.join(".rigg");
    fs::create_dir_all(&rigg_dir)?;
    fs::write(
        rigg_dir.join("fail.yaml"),
        r#"
id: fail
steps:
  - id: boom
    type: shell
    with:
      command: exit 7
"#,
    )?;

    let output = common::run(&root, ["run", "fail"])?;
    assert!(!output.status.success(), "expected non-zero exit: {output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("status Failed"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("Reason: StepFailed"));
    Ok(())
}
