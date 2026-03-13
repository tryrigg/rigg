use super::support::{parse_and_validate, parse_and_validate_error};
use crate::ConfigError;

fn check_forward_step_reference(
    yaml: &str,
    expected_step_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error("invalid.yaml", yaml)?;
    assert!(
        matches!(error, ConfigError::ForwardStepReference { ref step_id, .. } if step_id == expected_step_id),
        "expected ForwardStepReference for `{expected_step_id}`, got {error:?}"
    );
    Ok(())
}

fn check_result_unavailable(
    yaml: &str,
    expected_message: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error("invalid.yaml", yaml)?;
    assert!(
        matches!(error, ConfigError::InvalidReference { ref message, .. } if message == expected_message),
        "expected InvalidReference with `{expected_message}`, got {error:?}"
    );
    Ok(())
}

#[test]
fn loop_exports_make_final_body_values_visible() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: remediation
    type: loop
    max: 5
    until: ${{ steps.judge.result.accepted_count == 0 }}
    steps:
      - id: inspect
        type: shell
        with:
          command: echo review
      - id: judge
        type: claude
        with:
          action: prompt
          prompt: ${{ steps.inspect.result }}
          output_schema:
            type: object
            required: [accepted_count, fix_brief]
            properties:
              accepted_count:
                type: integer
              fix_brief:
                type: string
      - id: fix
        if: ${{ steps.judge.result.accepted_count > 0 }}
        type: shell
        with:
          command: echo ${{ steps.judge.result.fix_brief }}
    exports:
      accepted_count: ${{ steps.judge.result.accepted_count }}
      fix_brief: ${{ steps.judge.result.fix_brief }}

  - id: summarize
    type: shell
    with:
      command: echo ${{ steps.remediation.result.accepted_count }}
"#,
    )?;
    assert_eq!(workflow.root.nodes.len(), 2);
    Ok(())
}

#[test]
fn loop_body_nodes_remain_private_outside_loop() -> Result<(), Box<dyn std::error::Error>> {
    check_forward_step_reference(
        r#"
id: invalid
steps:
  - id: remediation
    type: loop
    max: 5
    until: ${{ steps.judge.result.accepted_count == 0 }}
    steps:
      - id: judge
        type: claude
        with:
          action: prompt
          prompt: hello
          output_schema:
            type: object
            required: [accepted_count]
            properties:
              accepted_count:
                type: integer
    exports:
      accepted_count: ${{ steps.judge.result.accepted_count }}

  - id: summarize
    type: shell
    with:
      command: echo ${{ steps.judge.result.accepted_count }}
"#,
        "judge",
    )
}

#[test]
fn group_exports_make_body_values_visible() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: summarize
    type: group
    steps:
      - id: inner
        type: shell
        with:
          command: echo inner
    exports:
      summary: ${{ steps.inner.result }}

  - id: consume
    type: shell
    with:
      command: echo ${{ steps.summarize.result.summary }}
"#,
    )?;

    assert_eq!(workflow.root.nodes.len(), 2);
    assert!(matches!(
        workflow.root.nodes[0].public_result,
        rigg_core::ResultSpec::Shape(rigg_core::ResultShape::Object(_))
    ));
    Ok(())
}

#[test]
fn conditional_group_hides_result_downstream() -> Result<(), Box<dyn std::error::Error>> {
    check_result_unavailable(
        r#"
id: invalid
inputs:
  enabled:
    type: boolean
steps:
  - id: summarize
    if: ${{ inputs.enabled }}
    type: group
    steps:
      - id: inner
        type: shell
        with:
          command: echo inner
    exports:
      summary: ${{ steps.inner.result }}

  - id: consume
    type: shell
    with:
      command: echo ${{ steps.summarize.result.summary }}
"#,
        "`steps.summarize.result` is not available for this node",
    )
}

#[test]
fn conditional_action_hides_result_downstream() -> Result<(), Box<dyn std::error::Error>> {
    check_result_unavailable(
        r#"
id: invalid
steps:
  - id: maybe
    if: ${{ false }}
    type: claude
    with:
      action: prompt
      prompt: hello
      output_schema:
        type: object
        required: [accepted_count]
        properties:
          accepted_count:
            type: integer
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.maybe.result.accepted_count }}
"#,
        "`steps.maybe.result` is not available for this node",
    )
}

#[test]
fn len_can_be_used_with_review_findings() -> Result<(), Box<dyn std::error::Error>> {
    parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: review
    type: codex
    with:
      action: review
      target: uncommitted
  - id: gate
    type: shell
    with:
      command: echo ${{ len(steps.review.result.findings) }}
"#,
    )?;

    Ok(())
}

#[test]
fn group_body_nodes_remain_private_outside_group() -> Result<(), Box<dyn std::error::Error>> {
    check_forward_step_reference(
        r#"
id: invalid
steps:
  - id: summarize
    type: group
    steps:
      - id: inner
        type: shell
        with:
          command: echo inner
    exports:
      summary: ${{ steps.inner.result }}

  - id: consume
    type: shell
    with:
      command: echo ${{ steps.inner.result }}
"#,
        "inner",
    )
}

#[test]
fn branch_case_exports_make_selected_result_visible() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
inputs:
  enabled:
    type: boolean
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ false }}
        steps:
          - id: reject
            type: shell
            with:
              command: echo reject
        exports:
          summary: ${{ steps.reject.result }}
      - else:
        steps:
          - id: accept
            type: shell
            with:
              command: echo accept
        exports:
          summary: ${{ steps.accept.result }}

  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result.summary }}
"#,
    )?;

    let rigg_core::NodeKind::Branch(branch_node) = &workflow.root.nodes[0].kind else {
        panic!("expected branch node");
    };
    assert_eq!(branch_node.cases.len(), 2);
    assert!(matches!(
        workflow.root.nodes[0].public_result,
        rigg_core::ResultSpec::Shape(rigg_core::ResultShape::Object(_))
    ));
    Ok(())
}

#[test]
fn branch_exports_reject_skip_capable_result() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
inputs:
  enabled:
    type: boolean
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps:
          - id: maybe
            if: ${{ inputs.enabled }}
            type: shell
            with:
              command: echo maybe
        exports:
          summary: ${{ steps.maybe.result }}
      - else:
        steps: []
        exports:
          summary: ${{ 'fallback' }}
"#,
    )?;

    assert!(matches!(
        error,
        ConfigError::InvalidReference { message, .. }
            if message == "`steps.maybe.result` is not available for this node"
    ));
    Ok(())
}

#[test]
fn branch_exports_accept_nested_input_shape() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
inputs:
  user:
    type: object
    properties:
      name:
        type: string
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps: []
        exports:
          value: ${{ inputs.user.name }}
      - else:
        steps: []
        exports:
          value: ${{ 'fallback' }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result.value }}
"#,
    )?;

    assert_eq!(workflow.root.nodes.len(), 2);
    Ok(())
}

#[test]
fn branch_without_else_and_exports_is_allowed() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
inputs:
  enabled:
    type: boolean
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ inputs.enabled }}
        steps:
          - id: run
            type: shell
            with:
              command: echo run
"#,
    )?;

    assert!(matches!(workflow.root.nodes[0].public_result, rigg_core::ResultSpec::None));
    Ok(())
}

#[test]
fn skip_capable_branch_hides_result() -> Result<(), Box<dyn std::error::Error>> {
    check_result_unavailable(
        r#"
id: invalid
inputs:
  enabled:
    type: boolean
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ inputs.enabled }}
        steps:
          - id: run
            type: shell
            with:
              command: echo run
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result }}
"#,
        "`steps.decide.result` is not available for this node",
    )
}

#[test]
fn conditional_branch_hides_result_downstream() -> Result<(), Box<dyn std::error::Error>> {
    check_result_unavailable(
        r#"
id: invalid
inputs:
  enabled:
    type: boolean
steps:
  - id: decide
    if: ${{ inputs.enabled }}
    type: branch
    cases:
      - if: ${{ true }}
        steps:
          - id: first
            type: shell
            with:
              command: echo first
        exports:
          summary: ${{ steps.first.result }}
      - else:
        steps:
          - id: second
            type: shell
            with:
              command: echo second
        exports:
          summary: ${{ steps.second.result }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result.summary }}
"#,
        "`steps.decide.result` is not available for this node",
    )
}

#[test]
fn rejects_branch_level_exports() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: decide
    type: branch
    cases:
      - else:
        steps: []
        exports:
          summary: ${{ "ok" }}
    exports:
      summary: ${{ "bad" }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidWith { .. }));
    Ok(())
}

#[test]
fn rejects_branch_case_export_shape_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps:
          - id: text_value
            type: shell
            with:
              command: echo hi
        exports:
          value: ${{ steps.text_value.result }}
      - else:
        steps:
          - id: json_value
            type: claude
            with:
              action: prompt
              prompt: hello
              output_schema:
                type: object
                required: [count]
                properties:
                  count:
                    type: integer
        exports:
          value: ${{ steps.json_value.result.count }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidWith { message, .. }
        if message == "all `branch` case exports must declare the same result shape"));
    Ok(())
}

#[test]
fn rejects_computed_export_shape_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: check
    type: shell
    with:
      command: echo ok
  - id: msg
    type: shell
    with:
      command: echo hello
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps: []
        exports:
          value: ${{ steps.check.result == 'ok' }}
      - else:
        steps: []
        exports:
          value: ${{ format('{0}', steps.msg.result) }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidWith { message, .. }
        if message == "all `branch` case exports must declare the same result shape"));
    Ok(())
}

#[test]
fn branch_exports_merge_integer_and_number_to_number() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps: []
        exports:
          value: ${{ 1 }}
      - else:
        steps: []
        exports:
          value: ${{ 1.5 }}
"#,
    )?;

    assert!(matches!(
        workflow.root.nodes[0].public_result,
        rigg_core::ResultSpec::Shape(rigg_core::ResultShape::Object(ref fields))
            if fields.get("value") == Some(&rigg_core::ResultShape::Number)
    ));
    Ok(())
}

#[test]
fn computed_exports_preserve_scalar_shape() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: left
    type: shell
    with:
      command: echo ok
  - id: right
    type: shell
    with:
      command: echo ok
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps: []
        exports:
          flag: ${{ steps.left.result == 'ok' }}
      - else:
        steps: []
        exports:
          flag: ${{ steps.right.result == 'ok' }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result.flag.foo }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidReference { message, .. }
        if message.contains("does not support nested field access")));
    Ok(())
}

#[test]
fn rejects_branch_exports_without_else() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps:
          - id: run
            type: shell
            with:
              command: echo hi
        exports:
          summary: ${{ steps.run.result }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidWith { message, .. }
        if message == "`branch` without `else` cannot declare case `exports`"));
    Ok(())
}

#[test]
fn branch_arm_nodes_remain_private_outside_branch() -> Result<(), Box<dyn std::error::Error>> {
    check_forward_step_reference(
        r#"
id: invalid
steps:
  - id: decide
    type: branch
    cases:
      - else:
        steps:
          - id: inner
            type: shell
            with:
              command: echo hi
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.inner.result }}
"#,
        "inner",
    )
}

#[test]
fn parallel_exports_visible_downstream() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: fanout
    type: parallel
    branches:
      - id: lint
        steps:
          - id: lint_result
            type: shell
            with:
              command: echo lint
      - id: test
        steps:
          - id: test_result
            type: shell
            with:
              command: echo test
    exports:
      summary: ${{ format('{0}:{1}', steps.lint_result.result, steps.test_result.result) }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.fanout.result.summary }}
"#,
    )?;

    let rigg_core::NodeKind::Parallel(parallel_node) = &workflow.root.nodes[0].kind else {
        panic!("expected parallel node");
    };
    assert_eq!(parallel_node.branches.len(), 2);
    assert_eq!(parallel_node.branches[0].user_id.to_string(), "lint");
    assert_eq!(parallel_node.branches[1].user_id.to_string(), "test");
    assert!(matches!(
        workflow.root.nodes[0].public_result,
        rigg_core::ResultSpec::Shape(rigg_core::ResultShape::Object(_))
    ));
    Ok(())
}

#[test]
fn conditional_parallel_hides_result() -> Result<(), Box<dyn std::error::Error>> {
    check_result_unavailable(
        r#"
id: invalid
inputs:
  enabled:
    type: boolean
steps:
  - id: fanout
    if: ${{ inputs.enabled }}
    type: parallel
    branches:
      - id: lint
        steps:
          - id: lint_result
            type: shell
            with:
              command: echo lint
      - id: test
        steps:
          - id: test_result
            type: shell
            with:
              command: echo test
    exports:
      summary: ${{ format('{0}:{1}', steps.lint_result.result, steps.test_result.result) }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.fanout.result.summary }}
"#,
        "`steps.fanout.result` is not available for this node",
    )
}

#[test]
fn parallel_branch_nodes_remain_private() -> Result<(), Box<dyn std::error::Error>> {
    check_forward_step_reference(
        r#"
id: invalid
steps:
  - id: fanout
    type: parallel
    branches:
      - id: lint
        steps:
          - id: lint_result
            type: shell
            with:
              command: echo lint
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.lint_result.result }}
"#,
        "lint_result",
    )
}

#[test]
fn separate_parallel_nodes_can_reuse_branch_ids() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: first_fanout
    type: parallel
    branches:
      - id: lint
        steps:
          - id: first_lint_result
            type: shell
            with:
              command: echo first
  - id: second_fanout
    type: parallel
    branches:
      - id: lint
        steps:
          - id: second_lint_result
            type: shell
            with:
              command: echo second
"#,
    )?;

    let rigg_core::NodeKind::Parallel(first_parallel) = &workflow.root.nodes[0].kind else {
        panic!("expected first parallel node");
    };
    let rigg_core::NodeKind::Parallel(second_parallel) = &workflow.root.nodes[1].kind else {
        panic!("expected second parallel node");
    };
    assert_eq!(first_parallel.branches[0].user_id.to_string(), "lint");
    assert_eq!(second_parallel.branches[0].user_id.to_string(), "lint");
    Ok(())
}

#[test]
fn parallel_rejects_duplicate_sibling_branch_ids() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: fanout
    type: parallel
    branches:
      - id: lint
        steps:
          - id: lint_first
            type: shell
            with:
              command: echo first
      - id: lint
        steps:
          - id: lint_second
            type: shell
            with:
              command: echo second
"#,
    )?;

    assert!(
        error.to_string().contains("reuses local branch id `lint` within the same parallel node")
    );
    Ok(())
}

#[test]
fn parallel_rejects_skip_capable_exports() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
inputs:
  enabled:
    type: boolean
steps:
  - id: fanout
    type: parallel
    branches:
      - id: lint
        steps:
          - id: lint_result
            if: ${{ inputs.enabled }}
            type: shell
            with:
              command: echo lint
    exports:
      summary: ${{ steps.lint_result.result }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidReference { message, .. }
        if message == "`steps.lint_result.result` is not available for this node"));
    Ok(())
}
