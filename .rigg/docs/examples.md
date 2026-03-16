# Rigg Workflow Examples

## 1. Review and remediate uncommitted changes

```yaml
id: review-uncommitted
steps:
  - id: remediation
    type: loop
    max: 5
    until: ${{ len(steps.review.result.findings) == 0 || steps.judge.result.accepted_count == 0 }}
    steps:
      - id: review
        type: codex
        with:
          action: review
          review:
            target:
              type: uncommitted

      - id: judge
        type: codex
        with:
          action: run
          prompt: |
            Accept only findings that are valid and actionable.
            Review:
            ${{ toJSON(steps.review.result) }}
          output:
            schema:
              type: object
              required: [accepted_count, fix_brief]
              additionalProperties: false
              properties:
                accepted_count:
                  type: integer
                fix_brief:
                  type: string

      - id: fix
        if: ${{ steps.judge.result.accepted_count > 0 }}
        type: codex
        with:
          action: run
          prompt: ${{ steps.judge.result.fix_brief }}
```

## 2. Plan, critique, and write a document

```yaml
id: plan
inputs:
  requirements:
    type: string
  output_path:
    type: string
steps:
  - id: draft
    type: codex
    with:
      action: run
      prompt: |
        Draft an implementation plan.
        Requirements:
        ${{ inputs.requirements }}
      output:
        schema:
          type: object
          required: [markdown]
          additionalProperties: false
          properties:
            markdown:
              type: string

  - id: critique
    type: codex
    with:
      action: run
      prompt: |
        Critique this draft and list concrete improvements.
        Draft:
        ${{ steps.draft.result.markdown }}
      output:
        schema:
          type: object
          required: [has_findings, findings]
          additionalProperties: false
          properties:
            has_findings:
              type: boolean
            findings:
              type: array
              items:
                type: object
                required: [description, suggestion]
                additionalProperties: false
                properties:
                  description:
                    type: string
                  suggestion:
                    type: string

  - id: write
    type: write_file
    with:
      path: ${{ inputs.output_path }}
      content: ${{ steps.draft.result.markdown }}
```

## 3. Parallel checks

```yaml
id: parallel-checks
steps:
  - id: all
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

  - id: report
    type: codex
    with:
      action: run
      prompt: |
        Summarize these results.
        Unit:
        ${{ steps.all.result.unit }}
        Lint:
        ${{ steps.all.result.lint }}
      output:
        schema:
          type: object
          required: [summary]
          additionalProperties: false
          properties:
            summary:
              type: string
```

## 4. Commit review

```yaml
id: review-commit
inputs:
  commit_sha:
    type: string
steps:
  - id: review
    type: codex
    with:
      action: review
      review:
        target:
          type: commit
          sha: ${{ inputs.commit_sha }}
```

## Common Pattern: Structured output

```yaml
output:
  schema:
    type: object
    required: [summary]
    additionalProperties: false
    properties:
      summary:
        type: string
```
