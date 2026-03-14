# Rigg Workflow YAML Guide

Rigg is a local-first workflow builder for coding. It orchestrates multi-step automation workflows involving AI coding agents (Codex, Claude), shell commands, and structured control flow.

Workflow files live in `.rigg/` and are run with `rigg run <workflow_id>`.

For complete field-by-field details, see [schema-reference.md](schema-reference.md).
For complete workflow examples, see [examples.md](examples.md).

## Workflow Structure

```yaml
id: workflow_name           # Required: unique identifier
inputs:                     # Optional: JSON Schema input definitions
  param_name:
    type: string
    description: ...
    default: default_value  # Only top-level inputs support defaults
env:                        # Optional: environment variables
  VAR_NAME: ${{ expr }}
steps:                      # Required: non-empty array of steps
  - id: step_name
    type: shell|codex|claude|write_file|group|loop|branch|parallel
    ...
```

## Step Types (Actions)

### shell — Run shell commands

```yaml
- id: check
  type: shell
  with:
    command: echo "hello ${{ inputs.name }}" # Template string
    result: text # none | text | json (default: text)
```

### codex — AI code review or execution

```yaml
# Review mode (pick exactly one target)
- id: review
  type: codex
  with:
    action: review
    target: uncommitted # uncommitted | base | commit
    prompt: Review for bugs.
    # target: base requires base:
    # base: ${{ inputs.branch }}
    # target: commit requires commit:
    # commit: ${{ inputs.sha }}
    title: Optional title # Optional, review only
    model: model_name # Optional

# Exec mode
- id: implement
  type: codex
  with:
    action: exec
    prompt: Implement the feature. # Required
    mode: full_auto # default | full_auto
    model: model_name # Optional
    persist: true # Session persistence (default: true)
    conversation: # Optional: maintain context across iterations
      name: planner
      scope: workflow # iteration | loop | workflow (iteration/loop only inside loops)
    output_schema: # Optional: validate structured JSON output
      type: object
      required: [field]
      additionalProperties: false
      properties:
        field:
          type: string
```

**Note:** `conversation` and `output_schema` cannot be used together when the conversation will be resumed (e.g., in a loop or when another step shares the same conversation name). Resumed Codex exec turns reject `output_schema` and `add_dirs`.

### claude — Interactive AI with permission control

```yaml
- id: judge
  type: claude
  with:
    action: prompt                                             # Only action type
    prompt: Evaluate this: ${{ toJSON(steps.review.result) }}  # Required
    permission_mode: default                                   # default|plan|acceptEdits|dontAsk|bypassPermissions
    model: model_name                                          # Optional
    persist: true                                              # Default: true
    conversation:                                              # Optional
      name: reviewer
      scope: workflow
    output_schema:                                            # Optional
      type: object
      required: [accepted]
      additionalProperties: false
      properties:
        accepted:
          type: boolean
```

### write_file — Write content to a file

```yaml
- id: save
  type: write_file
  with:
    path: ${{ inputs.output_path }}
    content: ${{ steps.draft.result.markdown }}
```

## Step Types (Control Flow)

### group — Encapsulate steps with exports

```yaml
- id: analysis
  type: group
  steps:
    - id: internal_step
      type: shell
      with:
        command: echo "hidden"
  exports:
    summary: ${{ steps.internal_step.result }}
```

### loop — Iterate until condition or max

```yaml
- id: remediation
  type: loop
  max: 5 # Required
  until: ${{ len(steps.review.result.findings) == 0 || steps.judge.result.accepted_count == 0 }} # Required
  steps:
    - id: review
      type: codex
      with:
        action: review
        target: uncommitted
        prompt: Review changes.
    - id: judge
      type: claude
      with:
        action: prompt
        prompt: Accept valid findings from ${{ toJSON(steps.review.result) }}
        output_schema:
          type: object
          required: [accepted_count]
          additionalProperties: false
          properties:
            accepted_count:
              type: integer
  exports:
    count: ${{ steps.judge.result.accepted_count }}
```

Inside loops: `${{ run.iteration }}` (1-based), `${{ run.max_iterations }}`, `${{ run.node_path }}` are available.

### branch — Conditional execution

```yaml
- id: decide
  type: branch
  cases:
    - if: ${{ steps.check.result.has_issues }}
      steps:
        - id: fix
          type: codex
          with:
            action: exec
            prompt: Fix the issues.
      exports:
        outcome: ${{ steps.fix.result }}
    - else:
      steps: []
      exports:
        outcome: "no issues"
```

All cases must export the same shape or none at all.

### parallel — Concurrent execution

```yaml
- id: tests
  type: parallel
  branches:
    - id: unit
      steps:
        - id: run_unit
          type: shell
          with:
            command: cargo test --lib
    - id: integration
      steps:
        - id: run_integration
          type: shell
          with:
            command: cargo test --tests
  exports:
    unit_result: ${{ steps.run_unit.result }}
    integration_result: ${{ steps.run_integration.result }}
```

## Expression Syntax

Templates use `${{ expression }}` syntax. Available roots:

| Root       | Description                      | Example                            |
| ---------- | -------------------------------- | ---------------------------------- |
| `inputs.*` | Workflow inputs                  | `${{ inputs.name }}`               |
| `steps.*`  | Previous step results            | `${{ steps.review.result.count }}` |
| `env.*`    | Environment variables            | `${{ env.CI }}`                    |
| `run.*`    | Loop context (inside loops only) | `${{ run.iteration }}`             |

Operators: `==`, `!=`, `>`, `>=`, `<`, `<=`, `&&`, `||`, `!`
Functions: `format('{0}:{1}', a, b)`, `toJSON(value)`, `join(array, ',')`

## Common Attributes (All Steps)

```yaml
- id: optional_unique_id # Alphanumeric + underscore + hyphen
  type: ... # Required
  if: ${{ boolean_expr }} # Optional: conditional execution
  env: # Optional: step-level env vars
    KEY: value
```

## CLI Commands

```bash
rigg init                                    # Generate .rigg/ with example workflows
rigg validate                                # Validate all .rigg/*.yaml files
rigg run <workflow_id> --input key=value     # Execute a workflow
rigg run <workflow_id> --json                # JSON output mode
rigg run <workflow_id> --quiet               # Minimal output
rigg status [run_id]                         # Check execution status
rigg logs <run_id> [--node id] [--stderr]    # View execution logs
```

## Key Rules

1. **Step results**: Access via `steps.<id>.result` — only visible to subsequent steps in the same scope
2. **Exports**: Make inner results visible outside group/loop/branch/parallel
3. **output_schema**: Must use `type: object` at the top level
4. **conversation**: Requires `persist: true` (default); `scope: iteration|loop` only inside loops
5. **codex review**: Does NOT support `conversation` or `output_schema`
6. **branch cases**: First matching `if` wins; `else` is the fallback
7. **Inputs**: Must be JSON Schema objects with `type` field, not shorthand strings
