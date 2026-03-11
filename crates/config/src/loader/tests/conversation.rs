use super::support::{invalid_with_message, parse_and_validate, parse_and_validate_error};
use crate::ConfigError;

fn check_rejects_resume_with(yaml: &str) -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error("invalid.yaml", yaml)?;
    assert!(
        matches!(&error, ConfigError::InvalidWith { message, .. }
            if message.contains("codex exec resume") && message.contains("with.add_dirs")),
        "expected resume rejection, got {error:?}"
    );
    Ok(())
}

#[test]
fn workflow_scope_default_outside_loop() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: draft
    type: claude
    with:
      action: prompt
      prompt: hello
      conversation:
        name: reviewer
"#,
    )?;
    let node = &workflow.root.nodes[0];
    let rigg_core::NodeKind::Action(action) = &node.kind else {
        panic!("expected action node");
    };
    match &action.action {
        rigg_core::ActionKind::Claude(step) => {
            let conversation = step.conversation.as_ref().expect("expected conversation");
            assert_eq!(conversation.name, "reviewer".parse()?);
            assert_eq!(conversation.scope, rigg_core::ConversationScope::Workflow);
        }
        other => panic!("unexpected action: {other:?}"),
    }
    Ok(())
}

#[test]
fn iteration_scope_default_inside_loop() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: remediation
    type: loop
    max: 2
    until: ${{ false }}
    steps:
      - id: fix
        type: codex
        with:
          action: exec
          prompt: hello
          conversation:
            name: fixer
"#,
    )?;
    let loop_node = &workflow.root.nodes[0];
    let rigg_core::NodeKind::Loop(loop_node) = &loop_node.kind else {
        panic!("expected loop node");
    };
    let child = &loop_node.body.nodes[0];
    let rigg_core::NodeKind::Action(action) = &child.kind else {
        panic!("expected action node");
    };
    match &action.action {
        rigg_core::ActionKind::Codex(step) => match &step.action {
            rigg_core::CodexAction::Exec(exec) => {
                let conversation = exec.conversation.as_ref().expect("expected conversation");
                assert_eq!(conversation.name, "fixer".parse()?);
                assert_eq!(conversation.scope, rigg_core::ConversationScope::Iteration);
            }
            other => panic!("unexpected codex action: {other:?}"),
        },
        other => panic!("unexpected action: {other:?}"),
    }
    Ok(())
}

#[test]
fn workflow_after_iteration_allows_schema() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: remediation
    type: loop
    max: 1
    until: ${{ true }}
    steps:
      - id: reviewer_loop
        type: codex
        with:
          action: exec
          prompt: inside loop
          conversation:
            name: reviewer
  - id: reviewer_workflow
    type: codex
    with:
      action: exec
      prompt: outside loop
      add_dirs:
        - docs
      conversation:
        name: reviewer
        scope: workflow
      output_schema:
        type: object
        required: [summary]
        properties:
          summary:
            type: string
"#,
    )?;

    assert_eq!(workflow.root.nodes.len(), 2);
    Ok(())
}

#[test]
fn conditional_loop_rejects_resume_fields() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_resume_with(
        r#"
id: valid
inputs:
  enabled:
    type: boolean
steps:
  - id: remediation
    if: ${{ inputs.enabled }}
    type: loop
    max: 1
    until: ${{ true }}
    steps:
      - id: reviewer_loop
        type: codex
        with:
          action: exec
          prompt: inside loop
          conversation:
            name: reviewer
            scope: workflow
  - id: reviewer_workflow
    type: codex
    with:
      action: exec
      prompt: outside loop
      add_dirs:
        - docs
      conversation:
        name: reviewer
        scope: workflow
      output_schema:
        type: object
        required: [summary]
        properties:
          summary:
            type: string
"#,
    )
}

#[test]
fn unconditional_loop_rejects_resume_fields() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_resume_with(
        r#"
id: invalid
steps:
  - id: remediation
    type: loop
    max: 1
    until: ${{ true }}
    steps:
      - id: reviewer_loop
        type: codex
        with:
          action: exec
          prompt: inside loop
          conversation:
            name: reviewer
            scope: workflow
  - id: reviewer_workflow
    type: codex
    with:
      action: exec
      prompt: outside loop
      add_dirs:
        - docs
      conversation:
        name: reviewer
        scope: workflow
"#,
    )
}

#[test]
fn allows_same_name_different_scopes() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: remediation
    type: loop
    max: 1
    until: ${{ true }}
    steps:
      - id: draft_loop
        type: claude
        with:
          action: prompt
          prompt: inside loop
          conversation:
            name: reviewer
  - id: draft_workflow
    type: codex
    with:
      action: exec
      prompt: outside loop
      conversation:
        name: reviewer
        scope: workflow
"#,
    )?;

    assert_eq!(workflow.root.nodes.len(), 2);
    Ok(())
}

#[test]
fn rejects_same_name_same_scope() -> Result<(), Box<dyn std::error::Error>> {
    let message = invalid_with_message(
        r#"
id: invalid
steps:
  - id: draft_claude
    type: claude
    with:
      action: prompt
      prompt: hello
      conversation:
        name: reviewer
  - id: draft_codex
    type: codex
    with:
      action: exec
      prompt: hello
      conversation:
        name: reviewer
        scope: workflow
"#,
    )?;
    assert!(message.contains("`conversation: reviewer`"));
    assert!(message.contains("already bound"));
    Ok(())
}

#[test]
fn separate_loops_isolate_resume_constraints() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: remediation_a
    type: loop
    max: 1
    until: ${{ true }}
    steps:
      - id: reviewer_a
        type: codex
        with:
          action: exec
          prompt: first loop
          conversation:
            name: reviewer
  - id: remediation_b
    type: loop
    max: 1
    until: ${{ true }}
    steps:
      - id: reviewer_b
        type: codex
        with:
          action: exec
          prompt: second loop
          add_dirs:
            - docs
          conversation:
            name: reviewer
          output_schema:
            type: object
            required: [summary]
            properties:
              summary:
                type: string
"#,
    )?;

    assert_eq!(workflow.root.nodes.len(), 2);
    Ok(())
}

#[test]
fn rejects_resume_incompatible_fields() -> Result<(), Box<dyn std::error::Error>> {
    let message = invalid_with_message(
        r#"
id: invalid
steps:
  - id: remediation
    type: loop
    max: 1
    until: ${{ true }}
    steps:
      - id: draft
        type: codex
        with:
          action: exec
          prompt: first
          conversation:
            name: reviewer
      - id: fix
        type: codex
        with:
          action: exec
          prompt: second
          add_dirs:
            - docs
          conversation:
            name: reviewer
"#,
    )?;
    assert!(message.contains("codex exec resume"));
    assert!(message.contains("with.add_dirs"));
    Ok(())
}

#[test]
fn branch_arm_guarantees_isolated() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
inputs:
  use_first:
    type: boolean
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ inputs.use_first }}
        steps:
          - id: first
            type: codex
            with:
              action: exec
              prompt: first
              conversation:
                name: reviewer
      - else:
        steps:
          - id: second
            type: codex
            with:
              action: exec
              prompt: second
              add_dirs:
                - docs
              conversation:
                name: reviewer
              output_schema:
                type: object
                required: [summary]
                properties:
                  summary:
                    type: string
"#,
    )?;

    assert_eq!(workflow.root.nodes.len(), 1);
    Ok(())
}

#[test]
fn branch_may_create_rejects_resume_fields() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_resume_with(
        r#"
id: valid
inputs:
  use_first:
    type: boolean
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ inputs.use_first }}
        steps:
          - id: first
            type: codex
            with:
              action: exec
              prompt: first
              conversation:
                name: reviewer
      - else:
        steps:
          - id: second
            type: shell
            with:
              command: echo second
  - id: final
    type: codex
    with:
      action: exec
      prompt: final
      add_dirs:
        - docs
      conversation:
        name: reviewer
      output_schema:
        type: object
        required: [summary]
        properties:
          summary:
            type: string
"#,
    )
}

#[test]
fn conditional_branch_rejects_resume_fields() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_resume_with(
        r#"
id: valid
inputs:
  enabled:
    type: boolean
steps:
  - id: decide
    type: branch
    if: ${{ inputs.enabled }}
    cases:
      - else:
        steps:
          - id: review
            type: codex
            with:
              action: exec
              prompt: review
              conversation:
                name: reviewer
  - id: final
    type: codex
    with:
      action: exec
      prompt: final
      add_dirs:
        - docs
      conversation:
        name: reviewer
      output_schema:
        type: object
        required: [summary]
        properties:
          summary:
            type: string
"#,
    )
}

#[test]
fn conditional_action_rejects_resume_fields() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_resume_with(
        r#"
id: invalid
inputs:
  enabled:
    type: boolean
steps:
  - id: review
    if: ${{ inputs.enabled }}
    type: codex
    with:
      action: exec
      prompt: review
      conversation:
        name: reviewer
  - id: final
    type: codex
    with:
      action: exec
      prompt: final
      add_dirs:
        - docs
      conversation:
        name: reviewer
"#,
    )
}

#[test]
fn guaranteed_branch_rejects_resume_fields() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_resume_with(
        r#"
id: invalid
inputs:
  use_first:
    type: boolean
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ inputs.use_first }}
        steps:
          - id: first
            type: codex
            with:
              action: exec
              prompt: first
              conversation:
                name: reviewer
      - else:
        steps:
          - id: second
            type: codex
            with:
              action: exec
              prompt: second
              conversation:
                name: reviewer
  - id: final
    type: codex
    with:
      action: exec
      prompt: final
      add_dirs:
        - docs
      conversation:
        name: reviewer
"#,
    )
}

#[test]
fn rejects_non_workflow_scope_outside_loop() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: draft
    type: claude
    with:
      action: prompt
      prompt: hello
      conversation:
        name: reviewer
        scope: iteration
"#,
    )?;
    assert!(matches!(error, ConfigError::InvalidWith { message, .. }
        if message == "`conversation.scope: iteration` is only allowed inside a `loop` body"));
    Ok(())
}

#[test]
fn rejects_parallel_sharing_binding() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: fanout
    type: parallel
    branches:
      - id: draft
        steps:
          - id: first
            type: codex
            with:
              action: exec
              prompt: Draft
              conversation:
                name: reviewer
      - id: fix
        steps:
          - id: second
            type: codex
            with:
              action: exec
              prompt: Fix
              conversation:
                name: reviewer
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidWith { message, .. }
        if message.contains("cannot reuse `conversation: reviewer`")
            && message.contains("sibling parallel branches execute concurrently")));
    Ok(())
}
