# Rigg Workflow YAML Guide

Rigg is a local-first workflow builder for coding. It orchestrates Codex and shell steps with structured control flow.

Workflow files live in `.rigg/` and are run with `rigg run <workflow_id>`.

For complete field-by-field details, see [schema-reference.md](schema-reference.md).
For complete workflow examples, see [examples.md](examples.md).

## Workflow Structure

```yaml
id: workflow_name
inputs:
  param_name:
    type: string
    description: Optional description
env:
  VAR_NAME: ${{ expr }}
steps:
  - id: step_name
    type: shell|codex|write_file|group|loop|branch|parallel
    ...
```

## Action Steps

### shell

```yaml
- id: check
  type: shell
  with:
    command: echo "hello ${{ inputs.name }}"
    result: text # none | text | json (default: text)
```

### codex

```yaml
# Run mode
- id: implement
  type: codex
  with:
    action: run
    prompt: Implement the feature.
    model: gpt-5.4
    output:
      schema:
        type: object
        required: [summary]
        additionalProperties: false
        properties:
          summary:
            type: string

# Review mode
- id: review
  type: codex
  with:
    action: review
    model: gpt-5.4
    review:
      target:
        type: uncommitted # uncommitted | base | commit
      title: Optional title
```

For `review.target`:

- `type: uncommitted` needs no extra fields
- `type: base` requires `branch`
- `type: commit` requires `sha`

### write_file

```yaml
- id: save
  type: write_file
  with:
    path: ${{ inputs.output_path }}
    content: ${{ steps.draft.result.markdown }}
```

## Control Flow

### group

```yaml
- id: analysis
  type: group
  steps:
    - id: inner
      type: shell
      with:
        command: echo hi
  exports:
    summary: ${{ steps.inner.result }}
```

### loop

```yaml
- id: remediation
  type: loop
  max: 5
  until: ${{ steps.review.result.findings == [] }}
  steps: []
```

Inside loops: `${{ run.iteration }}`, `${{ run.max_iterations }}`, and `${{ run.node_path }}` are available.

### branch

```yaml
- id: decide
  type: branch
  cases:
    - if: ${{ steps.check.result.ok }}
      steps: []
      exports:
        status: ${{ "ok" }}
    - else:
      steps: []
      exports:
        status: ${{ "needs_work" }}
```

### parallel

```yaml
- id: checks
  type: parallel
  branches:
    - id: unit
      steps:
        - id: run_unit
          type: shell
          with:
            command: npm test
    - id: lint
      steps:
        - id: run_lint
          type: shell
          with:
            command: npm run lint
  exports:
    unit: ${{ steps.run_unit.result }}
    lint: ${{ steps.run_lint.result }}
```

## Expressions

Templates use `${{ expression }}` syntax. Available roots:

- `inputs.*`
- `steps.*`
- `env.*`
- `run.*` inside loops only

Built-in functions: `format`, `toJSON`, `join`, `len`

## CLI Commands

```bash
rigg init
rigg validate
rigg run <workflow_id> --input key=value
rigg run <workflow_id> --json
rigg run <workflow_id> --quiet
```

## Key Rules

1. Access step outputs via `steps.<id>.result`
2. `with.output.schema` must use `type: object` at the root
3. `codex` supports `action: run` and `action: review`
4. Unknown YAML keys cause validation errors
