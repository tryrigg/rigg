# Rigg Workflow YAML — Complete Schema Reference

## Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique workflow identifier |
| `inputs` | map<string, JSONSchema> | No | Input parameter definitions (JSON Schema objects) |
| `env` | map<string, template> | No | Workflow-level environment variables |
| `steps` | array<Step> | Yes | Non-empty array of workflow steps |

## Input Schema

Inputs are JSON Schema objects. Top-level inputs may have `default`. Nested properties cannot have defaults.

```yaml
inputs:
  name:
    type: string
    description: User's name
    default: "world"
    minLength: 1
    maxLength: 100
    pattern: "^[a-zA-Z]+$"
    enum: ["Alice", "Bob"]

  count:
    type: integer
    minimum: 0
    maximum: 100

  rating:
    type: number
    minimum: 0.0
    maximum: 5.0

  enabled:
    type: boolean

  config:
    type: object
    required: [name]
    properties:
      name:
        type: string
      timeout:
        type: integer

  tags:
    type: array
    items:
      type: string
    minItems: 1
    maxItems: 10
```

Supported types: `string`, `number`, `integer`, `boolean`, `object`, `array`

- `object` requires `properties`
- `array` requires `items`
- Nested objects cannot have `default`

## Step Common Fields

All step types support these fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | No | Unique identifier (must start with ASCII letter or `_`; remaining characters may be alphanumeric, `_`, or `-`) |
| `type` | string | Yes | Step type |
| `if` | expression | No | Conditional execution (`${{ bool_expr }}`) |
| `env` | map<string, template> | No | Step-level environment variables |

## Action Steps

### type: shell

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `with.command` | template | Yes | — | Shell command to execute |
| `with.result` | enum | No | `text` | `none`, `text`, or `json` |

### type: codex (action: review)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `with.action` | `review` | Yes | — | Review action |
| `with.prompt` | template | No | — | Review instructions |
| `with.target` | enum | Yes* | — | `uncommitted`, `base`, or `commit` |
| `with.base` | template | Cond. | — | Required when `target: base` |
| `with.commit` | template | Cond. | — | Required when `target: commit` |
| `with.title` | template | No | — | Review title |
| `with.model` | string | No | — | Model override |
| `with.mode` | enum | No | `default` | `default` or `full_auto` |
| `with.add_dirs` | array<template> | No | `[]` | Additional directories |
| `with.persist` | bool | No | `true` | Session persistence |

*Target resolution: `target: uncommitted` requires no other fields. `target: base` requires `base`. `target: commit` requires `commit`. If `target` is omitted, presence of `base` infers `target: base`. However, `commit` alone does NOT infer `target: commit` — you must explicitly set `target: commit` with `commit`.

**NOT supported in review**: `conversation`, `output_schema`

### type: codex (action: exec)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `with.action` | `exec` | Yes | — | Exec action |
| `with.prompt` | template | Yes | — | Execution instructions |
| `with.mode` | enum | No | `default` | `default` or `full_auto` |
| `with.model` | string | No | — | Model override |
| `with.add_dirs` | array<template> | No | `[]` | Additional directories |
| `with.persist` | bool | No | `true` | Session persistence |
| `with.conversation` | object | No | — | Conversation context (requires persist: true) |
| `with.output_schema` | JSONSchema | No | — | Structured output validation |

**NOT supported in exec**: `target`, `base`, `commit`, `title`

### type: claude

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `with.action` | `prompt` | Yes | — | Only supported action |
| `with.prompt` | template | Yes | — | Prompt text |
| `with.permission_mode` | enum | No | `default` | `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions` |
| `with.model` | string | No | — | Model override |
| `with.add_dirs` | array<template> | No | `[]` | Additional directories |
| `with.persist` | bool | No | `true` | Session persistence |
| `with.conversation` | object | No | — | Conversation context (requires persist: true) |
| `with.output_schema` | JSONSchema | No | — | Structured output validation |

### type: write_file

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `with.path` | template | Yes | File path to write |
| `with.content` | template | Yes | File content |

## Conversation Binding

```yaml
conversation:
  name: 123 reviewer / main # Required: any non-blank string
  scope: iteration           # Optional: iteration | loop | workflow
```

- Default scope: `iteration` inside loops, `workflow` outside
- `scope: iteration` and `scope: loop` are only valid inside a loop body
- Requires `persist: true` (the default)

## Output Schema

Must be a JSON Schema with `type: object` at the root.

```yaml
output_schema:
  type: object
  required: [status, findings]
  additionalProperties: false
  properties:
    status:
      type: string
      enum: ["pass", "fail"]
    findings:
      type: array
      items:
        type: object
        required: [severity, description]
        properties:
          severity:
            type: string
          description:
            type: string
    count:
      type: integer
    score:
      type: number
    approved:
      type: boolean
```

## Control Flow Steps

### type: group

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `steps` | array<Step> | Yes | Nested steps |
| `exports` | map<string, template> | No | Expose internal results |

Exports make inner step results visible outside the group. Without exports, inner steps are hidden from downstream.

### type: loop

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `max` | integer | Yes | Maximum iterations |
| `until` | expression | Yes | Exit condition (`${{ bool_expr }}`) |
| `steps` | array<Step> | Yes | Loop body |
| `exports` | map<string, template> | No | Expose final iteration values |

Inside loops, these `run.*` variables are available:
- `run.iteration` — Current iteration (1-based integer)
- `run.max_iterations` — Maximum iterations (integer)
- `run.node_path` — Node path (string)

### type: branch

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cases` | array<Case> | Yes | At least one case |

Each case:
```yaml
cases:
  - if: ${{ condition }}    # Conditional case
    steps: [...]
    exports: { ... }
  - else:                   # Fallback case (no if)
    steps: [...]
    exports: { ... }
```

Rules:
- First matching `if` executes; `else` is the fallback
- All cases must export the same shape, or none at all
- If any case declares `exports`, an `else` case is required
- `else:` marker must be empty (just `else:` with no value)

### type: parallel

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branches` | array<Branch> | Yes | At least one branch |
| `exports` | map<string, template> | No | Expose results from any branch |

Each branch:
```yaml
branches:
  - id: branch_id          # Required: unique identifier
    steps: [...]
```

Exports can reference `steps.*` from any branch within the parallel block.

## Expression Syntax

### Template Strings

Templates embed expressions in `${{ }}`:
```yaml
prompt: "Hello ${{ inputs.name }}, iteration ${{ run.iteration }}"
```

Plain strings without `${{ }}` are literal values.

### Expression Roots

| Root | Available | Description |
|------|-----------|-------------|
| `inputs` | Always | Workflow input parameters |
| `steps` | Always | Results from previous steps in scope |
| `env` | Always | Environment variables |
| `run` | Inside loops only | Loop iteration context |

### Path Access

```
inputs.name                    → input value
inputs.config.timeout          → nested object field
steps.review.result            → step result (text or full object)
steps.judge.result.count       → nested field in structured output
steps.list.result.0.name       → array index access
env.CI                         → environment variable
run.iteration                  → loop iteration number
```

### Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `==` | Equal | `steps.x.result == 'ok'` |
| `!=` | Not equal | `steps.x.result != null` |
| `>` | Greater than | `steps.x.result.count > 0` |
| `>=` | Greater or equal | `run.iteration >= 3` |
| `<` | Less than | `steps.x.result.score < 0.5` |
| `<=` | Less or equal | `steps.x.result.count <= 10` |
| `&&` | Logical AND | `steps.a.result && steps.b.result` |
| `\|\|` | Logical OR | `steps.a.result \|\| steps.b.result` |
| `!` | Logical NOT | `!steps.x.result.has_issues` |

### Built-in Functions

| Function | Description | Example |
|----------|-------------|---------|
| `format(fmt, ...)` | String formatting | `format('{0}:{1}', a, b)` |
| `toJSON(value)` | JSON stringification | `toJSON(steps.data.result)` |
| `join(array, delim)` | Join array elements | `join(steps.x.result.tags, ', ')` |

### Literals

- `null`, `true`, `false`
- Numbers: `42`, `3.14`
- Strings: `'single quoted'`

## Validation Rules

1. Step IDs must be unique across the entire workflow
2. Step IDs must start with an ASCII letter or `_`; remaining characters may be alphanumeric, `_`, or `-`
3. `steps` arrays cannot be empty (except in branch cases, where `steps: []` is allowed)
4. `steps.<id>.result` only references previous (not forward) steps
5. Exported fields from branch cases must have matching shapes
6. `with` is required for all action types
7. `deny_unknown_fields` is enforced — unknown YAML keys cause errors
8. All expression roots must be valid for the current scope
