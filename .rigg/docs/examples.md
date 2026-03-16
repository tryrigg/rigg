# Rigg Workflow Examples

## 1. Review and remediate uncommitted changes

```yaml
id: review-uncommitted
steps:
  - id: remediation
    type: loop
    max: 5
    until: ${{ len(steps.review.result.findings) == 0 }}
    steps:
      - id: review
        type: codex
        with:
          action: review
          review:
            target:
              type: uncommitted

      - id: fix
        if: ${{ len(steps.review.result.findings) > 0 }}
        type: codex
        with:
          action: run
          prompt: |
            Address the accepted findings from this review.
            Review:
            ${{ toJSON(steps.review.result) }}
```

## 2. Draft and write a document

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
      action: plan
      prompt: |
        Clarify anything missing, then draft an implementation plan.
        Requirements:
        ${{ inputs.requirements }}

  - id: write
    type: write_file
    with:
      path: ${{ inputs.output_path }}
      content: ${{ steps.draft.result }}
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
