mod common;

use std::error::Error;
use std::fs;

#[test]
fn init_generates_valid_examples() -> Result<(), Box<dyn Error>> {
    let root = common::temp_root("init");
    let init_output = common::run(&root, ["init"])?;
    assert!(init_output.status.success(), "init failed: {init_output:?}");

    let validate_output = common::run(&root, ["validate"])?;
    assert!(validate_output.status.success(), "validate failed: {validate_output:?}");
    let stdout = String::from_utf8_lossy(&validate_output.stdout);
    assert!(stdout.contains("plan"));
    assert!(stdout.contains("review-uncommitted"));
    assert!(stdout.contains("review-branch"));
    assert!(stdout.contains("review-commit"));

    let review_uncommitted = fs::read_to_string(root.join(".rigg/review-uncommitted.yaml"))?;
    assert!(review_uncommitted.contains("type: loop"));
    assert!(review_uncommitted.contains(
        "until: ${{ len(steps.review.result.findings) == 0 || steps.judge.result.accepted_count == 0 }}"
    ));
    assert!(review_uncommitted.contains("${{ toJSON(steps.review.result) }}"));

    let plan = fs::read_to_string(root.join(".rigg/plan.yaml"))?;
    assert!(plan.contains("requirements:\n    type: string"));
    assert!(plan.contains("output_path:\n    type: string"));
    assert!(plan.contains("additionalProperties: false"));
    assert!(plan.contains("${{ toJSON(steps.critique.result.findings) }}"));
    assert!(!plan.contains("requirements: string"));
    assert!(!plan.contains("output_path: string"));

    let review_branch = fs::read_to_string(root.join(".rigg/review-branch.yaml"))?;
    assert!(review_branch.contains("base_branch:\n    type: string"));
    assert!(!review_branch.contains("base_branch: string"));

    let review_commit = fs::read_to_string(root.join(".rigg/review-commit.yaml"))?;
    assert!(review_commit.contains("commit_sha:\n    type: string"));
    assert!(!review_commit.contains("commit_sha: string"));

    let docs_dir = root.join(".rigg/docs");
    assert!(docs_dir.exists(), "docs directory should be created");
    let workflow_syntax = fs::read_to_string(docs_dir.join("workflow-syntax.md"))?;
    assert!(workflow_syntax.contains("## Step Types (Actions)"));
    assert!(workflow_syntax.contains("## Expression Syntax"));
    let schema_ref = fs::read_to_string(docs_dir.join("schema-reference.md"))?;
    assert!(schema_ref.contains("## Action Steps"));
    let examples = fs::read_to_string(docs_dir.join("examples.md"))?;
    assert!(examples.contains("## 1. Simple Shell Pipeline"));
    assert!(examples.contains("## Common Patterns"));

    let agent_skill = fs::read_to_string(root.join(".agents/skills/rigg/SKILL.md"))?;
    assert!(agent_skill.contains("name: rigg"));
    assert!(agent_skill.contains(".rigg/docs/workflow-syntax.md"));

    let claude_skill = fs::read_to_string(root.join(".claude/skills/rigg/SKILL.md"))?;
    assert!(claude_skill.contains("name: rigg"));
    assert!(claude_skill.contains(".rigg/docs/workflow-syntax.md"));

    Ok(())
}
