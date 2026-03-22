# Rigg Workflow YAML — Complete Schema Reference

## Top-Level Fields

| Field    | Type                    | Required | Description                |
| -------- | ----------------------- | -------- | -------------------------- |
| `id`     | string                  | Yes      | Unique workflow identifier |
| `inputs` | map<string, JSONSchema> | No       | Input parameter schema     |
| `env`    | map<string, template>   | No       | Workflow environment vars  |
| `steps`  | array<Step>             | Yes      | Non-empty workflow steps   |

## Common Step Fields

| Field  | Type                  | Required |
| ------ | --------------------- | -------- |
| `id`   | string                | No       |
| `type` | string                | Yes      |
| `if`   | expression            | No       |
| `env`  | map<string, template> | No       |

## type: shell

| Field          | Type                       | Required | Default |
| -------------- | -------------------------- | -------- | ------- |
| `with.command` | template                   | Yes      | —       |
| `with.result`  | `none` \| `text` \| `json` | No       | `text`  |

## type: codex (`kind: turn`)

| Field                     | Type                                   | Required |
| ------------------------- | -------------------------------------- | -------- |
| `with.kind`               | `turn`                                 | Yes      |
| `with.prompt`             | template                               | Yes      |
| `with.collaboration_mode` | `default` \| `plan`                    | No       |
| `with.model`              | string                                 | No       |
| `with.effort`             | `low` \| `medium` \| `high` \| `xhigh` | No       |

`kind: turn` returns plain text. `collaboration_mode: plan` uses Codex's built-in Plan collaboration mode and is planning-only.
`with.effort` maps to Codex reasoning effort and defaults to `medium`.

## type: codex (`kind: review`)

| Field                | Type                                | Required  |
| -------------------- | ----------------------------------- | --------- |
| `with.kind`          | `review`                            | Yes       |
| `with.model`         | string                              | No        |
| `with.target.type`   | `uncommitted` \| `base` \| `commit` | Yes       |
| `with.target.branch` | template                            | if base   |
| `with.target.sha`    | template                            | if commit |

Built-in review result shape:

```yaml
findings:
  - title: string
    body: string
    confidence_score: number
    priority: integer
    code_location:
      absolute_file_path: string
      line_range:
        start: integer
        end: integer
overall_correctness: string
overall_explanation: string
overall_confidence_score: number
```

## type: cursor

| Field         | Type                       | Required              |
| ------------- | -------------------------- | --------------------- |
| `with.mode`   | `agent` \| `ask` \| `plan` | No (default: `agent`) |
| `with.prompt` | template                   | Yes                   |
| `with.model`  | string                     | No                    |

`cursor` communicates with Cursor Agent through ACP and returns the final plain-text assistant response.

## type: write_file

| Field          | Type     | Required |
| -------------- | -------- | -------- |
| `with.path`    | template | Yes      |
| `with.content` | template | Yes      |

## type: group

| Field     | Type                  | Required |
| --------- | --------------------- | -------- |
| `steps`   | array<Step>           | Yes      |
| `exports` | map<string, template> | No       |

## type: loop

| Field     | Type                  | Required |
| --------- | --------------------- | -------- |
| `max`     | integer               | Yes      |
| `until`   | expression            | Yes      |
| `steps`   | array<Step>           | Yes      |
| `exports` | map<string, template> | No       |

## type: branch

| Field   | Type        | Required |
| ------- | ----------- | -------- |
| `cases` | array<Case> | Yes      |

## type: parallel

| Field      | Type                  | Required |
| ---------- | --------------------- | -------- |
| `branches` | array<Branch>         | Yes      |
| `exports`  | map<string, template> | No       |

## Validation Rules

1. Step IDs must be unique across the entire workflow
2. Step IDs must start with an ASCII letter or `_`
3. `steps.<id>.result` only references previous steps
4. Branch exports must have matching shapes across cases
5. Unknown YAML keys cause validation errors
