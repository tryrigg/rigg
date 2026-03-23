# Rigg Workflow YAML Guide

Rigg is a local-first workflow builder for coding. It orchestrates Codex and shell steps with structured control flow.

Workflow files live in `.rigg/` and are run with `rigg run <workflow_id>`.
If you omit a declared workflow input from `--input`, `rigg run` prompts for it before execution starts so you can confirm or override the default interactively.
Enter JSON for non-string values such as booleans, numbers, arrays, and objects.

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
    stdout:
      mode: text # none | text | json (default: text)
```

### codex

```yaml
# Turn (default collaboration)
- id: implement
  type: codex
  with:
    kind: turn
    prompt: Implement the feature.
    model: gpt-5.4
    effort: high

# Turn with Plan collaboration
- id: draft_plan
  type: codex
  with:
    kind: turn
    collaboration_mode: plan
    prompt: Clarify the scope and produce an implementation plan.
    model: gpt-5.4
    effort: low

# Review
- id: review
  type: codex
  with:
    kind: review
    model: gpt-5.4
    target:
      type: uncommitted # uncommitted | base | commit
```

`kind: turn` returns plain text.
`collaboration_mode: plan` uses Codex's built-in Plan collaboration mode and is planning-only.
It must not mutate repo-tracked files.
`effort` is optional on turns and maps to Codex reasoning effort.
Allowed values: `low | medium | high | xhigh`.
If omitted, Rigg uses `medium`.

For `target` on `kind: review`:

- `type: uncommitted` needs no extra fields
- `type: base` requires `branch`
- `type: commit` requires `sha`

### write_file

```yaml
- id: save
  type: write_file
  with:
    path: ${{ inputs.output_path }}
    content: ${{ steps.draft.result }}
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
  until: ${{ len(steps.review.result.findings) == 0 }}
  steps: []
```

Inside loops: `${{ run.iteration }}`, `${{ run.max_iterations }}`, and `${{ run.node_path }}` are available.

### branch

```yaml
- id: decide
  type: branch
  cases:
    - if: ${{ steps.check.result == "ok" }}
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
```

## Key Rules

1. Access step outputs via `steps.<id>.result`
2. `codex` uses `kind: turn` or `kind: review` (turns may set `collaboration_mode: plan`)
3. `codex` turns return text; `codex` review returns the built-in review object shape
4. Plan collaboration on a turn uses `collaboration_mode: plan` and is planning-only
5. Unknown YAML keys cause validation errors
